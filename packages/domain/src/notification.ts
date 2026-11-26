/**
 * 通知投递（技术文档 §5.4，notification_outbox 事务外发）。
 *
 * 入队：由业务事务内调用 enqueueNotification 写入 outbox（幂等去重，
 *   uq_outbox_event 约束 event_key+recipient+channel）。
 * 投递：worker 每拍调用 dispatchPendingNotifications，按租约（lease_until）
 *   抢占 PENDING 且到点的消息，交由 NotificationGateway 真实投递。
 *
 * 设计要点：
 * - 投递逻辑与具体通道解耦：domain 只定义 NotificationGateway 接口，不依赖任何
 *   外部 SDK；真实通道（飞书/邮件）在 apps 层实现，凭据就绪后注入。
 * - 本地无凭据时默认用 LocalLogGateway（仅记录并成功），使整条投递链路可在本地跑通验证。
 * - 投递成功 → SENT；失败 → 退避重试（FAILED + next_retry_at 延后）；超过 maxAttempts → DEAD 死信。
 */
import type { DbClient } from './db.js';

export type NotificationChannel = 'IN_APP' | 'FEISHU' | 'EMAIL';

export interface EnqueueInput {
  orgId: string;
  eventKey: string;
  recipientId: string;
  channel?: NotificationChannel;
  payload: Record<string, unknown>;
}

/**
 * 投递给网关的单条消息（已从 outbox 取数）。
 */
export interface OutboundNotification {
  id: string;
  orgId: string;
  channel: NotificationChannel;
  recipientId: string;
  payload: Record<string, unknown>;
}

export interface GatewaySendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  accepted?: boolean;
}

/**
 * 通知网关抽象：domain 零依赖，仅声明 send 契约。
 * 真实实现（飞书/邮件）在 apps 层提供，凭据就绪后注入 dispatchPendingNotifications。
 */
export interface NotificationGateway {
  send(msg: OutboundNotification): Promise<GatewaySendResult>;
}

/**
 * 本地日志网关：不触达外部，仅记录并返回成功。
 * 用于本地验证与无凭据环境默认投递；生产由真实网关替换。
 */
export const LocalLogGateway: NotificationGateway = {
  async send(msg) {
    // eslint-disable-next-line no-console
    console.info('[notify] local-deliver', msg.channel, msg.recipientId, JSON.stringify(msg.payload));
    return { ok: false, error: 'LOG_GATEWAY_IS_NOT_DELIVERY' };
  },
};

/**
 * 幂等入队。已存在同 (event_key, recipient, channel) 则返回 id=null（不重复插入）。
 */
export async function enqueueNotification(
  client: DbClient,
  input: EnqueueInput,
): Promise<{ id: string | null }> {
  const channel = input.channel ?? 'IN_APP';
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO notification_outbox (id, org_id, event_key, recipient_id, channel, payload_json)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     ON CONFLICT (event_key, recipient_id, channel) DO NOTHING
     RETURNING id`,
    [input.orgId, input.eventKey, input.recipientId, channel, JSON.stringify(input.payload)],
  );
  return { id: rows[0]?.id ?? null };
}

export interface DispatchResult {
  /** 本次成功投递条数 */
  dispatched: number;
  /** 本次投递失败、转入退避重试条数 */
  failed: number;
  /** 本次超过重试上限、转入死信条数 */
  dead: number;
}

/** 失败退避：指数退避，封顶 1 小时 */
function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 3_600_000);
}

/**
 * 投递一批待发通知：抢占租约 → 调用网关 send → 按结果落状态。
 * - status='PENDING' 且 next_retry_at <= now 且租约空闲（lease_until 为空或已过期）
 * - 设 lease_until = now + leaseMs 防并发重复
 * - 调 gateway.send：ok → SENT；失败且 attempts 未达上限 → FAILED + 延后重试；达上限 → DEAD
 * 返回本批各状态计数。
 */
export async function dispatchPendingNotifications(
  client: DbClient,
  gateway: NotificationGateway,
  now: Date = new Date(),
  leaseMs = 30_000,
  batchSize = 50,
  maxAttempts = 5,
): Promise<DispatchResult> {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const claim=await client.query<{id:string;org_id:string;channel:NotificationChannel;recipient_id:string;payload_json:Record<string,unknown>;attempts:number}>(
    `WITH candidates AS (
       SELECT id FROM notification_outbox WHERE status IN ('PENDING','FAILED') AND next_retry_at<=$1
         AND (lease_until IS NULL OR lease_until<$1) AND attempts<$4
       ORDER BY next_retry_at,id LIMIT $3 FOR UPDATE SKIP LOCKED
     ) UPDATE notification_outbox n SET lease_until=$2,attempts=n.attempts+1
       FROM candidates c WHERE n.id=c.id
       RETURNING n.id,n.org_id,n.channel,n.recipient_id,n.payload_json,n.attempts`,
    [now,leaseUntil,batchSize,maxAttempts]);
  const result:DispatchResult={dispatched:0,failed:0,dead:0};
  for(const r of claim.rows){
    let response:GatewaySendResult;
    try{response=await gateway.send({id:r.id,orgId:r.org_id,channel:r.channel,recipientId:r.recipient_id,payload:r.payload_json});}
    catch{response={ok:false,error:'NOTIFICATION_TRANSPORT_ERROR'};}
    if(response.ok&&response.accepted===true&&response.messageId){
      const changed=await client.query(`UPDATE notification_outbox SET status='ACCEPTED',provider_message_id=$3,accepted_at=now(),last_error=NULL,lease_until=NULL
        WHERE id=$1 AND lease_until=$2 RETURNING id`,[r.id,leaseUntil,response.messageId]);
      if(changed.rowCount)result.dispatched++;
    }else{
      const terminal=r.attempts>=maxAttempts;
      const changed=await client.query(`UPDATE notification_outbox SET status=$3,last_error=$4,next_retry_at=$5,lease_until=NULL
        WHERE id=$1 AND lease_until=$2 RETURNING id`,[r.id,leaseUntil,terminal?'DEAD':'FAILED',
        (response.error??'PROVIDER_ACK_MISSING').slice(0,200),new Date(now.getTime()+backoffMs(r.attempts))]);
      if(changed.rowCount){if(terminal)result.dead++;else result.failed++;}
    }
  }
  return result;
}
