import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '../src/db.js';
import {
  dispatchPendingNotifications,
  LocalLogGateway,
  type NotificationGateway,
  type OutboundNotification,
} from '../src/notification.js';

interface Row {
  id: string;
  status: string;
  attempts: number;
  next_retry_at: Date;
  lease_until: Date | null;
  channel: string;
  recipient_id: string;
  payload_json: Record<string, unknown>;
}

/**
 * 内存版 DbClient，仅响应 dispatchPendingNotifications 涉及的 5 类 SQL。
 * 用于纯单测投递链路（成功/退避/死信），不引入 pg 依赖。
 */
function makeDb(seed: Row[]): DbClient {
 const store=new Map(seed.map(r=>[r.id,{...r,org_id:'test-org'}]));
 return {async query(sql:string,params:unknown[]=[]){
  if(sql.includes('WITH candidates AS')){
   const [now,lease,limit,max]=params as [Date,Date,number,number];
   const rows=[...store.values()].filter(r=>['PENDING','FAILED'].includes(r.status)&&r.next_retry_at<=now&&(!r.lease_until||r.lease_until<now)&&r.attempts<max).slice(0,limit);
   rows.forEach(r=>{r.lease_until=lease;r.attempts++;});return {rows:rows.map(r=>({...r})),rowCount:rows.length};
  }
  if(sql.includes('FROM notification_outbox WHERE id = ANY')){const rows=(params[0] as string[]).map(id=>store.get(id)).filter(Boolean);return {rows,rowCount:rows.length};}
  const row=store.get(params[0] as string);if(!row||row.lease_until!==params[1])return {rows:[],rowCount:0};
  if(sql.includes("status='ACCEPTED'")){row.status='ACCEPTED';row.lease_until=null;}
  else if(sql.includes('status=$3')){row.status=params[2] as string;row.next_retry_at=params[4] as Date;row.lease_until=null;}
  return {rows:[{id:row.id}],rowCount:1};
 }} as unknown as DbClient;
}

const base = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  status: 'PENDING',
  attempts: 0,
  next_retry_at: new Date(Date.now() - 1000),
  lease_until: null,
  channel: 'IN_APP',
  recipient_id: 'u1',
  payload_json: { type: 'RESULT_PUBLISHED' },
  ...over,
});

describe('M9 通知投递链路（domain 纯单测，本地无凭据）', () => {
  it('provider acknowledgement is ACCEPTED, not a delivery receipt', async () => {
    const db = makeDb([base('n1'), base('n2', { channel: 'FEISHU' })]);
    const res = await dispatchPendingNotifications(db, {send:async()=>({ok:true,accepted:true,messageId:'om_test'})}, new Date());
    expect(res).toEqual({ dispatched: 2, failed: 0, dead: 0 });
    const { rows } = await db.query<Row>(`SELECT id, status FROM notification_outbox WHERE id = ANY($1)`, [['n1', 'n2']]);
    expect(rows.every((r) => r.status === 'ACCEPTED')).toBe(true);
  });

  it('网关失败 → FAILED 退避，且延后重试前不被二次抢占', async () => {
    const failGateway: NotificationGateway = { send: async () => ({ ok: false, error: 'boom' }) };
    const db = makeDb([base('n1')]);
    const res = await dispatchPendingNotifications(db, failGateway, new Date(), 30_000, 50, 5);
    expect(res).toEqual({ dispatched: 0, failed: 1, dead: 0 });

    const peek = await db.query<Row>(`SELECT id, status, next_retry_at FROM notification_outbox WHERE id = ANY($1)`, [['n1']]);
    expect(peek.rows[0].status).toBe('FAILED');
    expect(peek.rows[0].next_retry_at.getTime()).toBeGreaterThan(Date.now());

    // 同一 now 下不应再次抢占
    const again = await dispatchPendingNotifications(db, failGateway, new Date(), 30_000, 50, 5);
    expect(again).toEqual({ dispatched: 0, failed: 0, dead: 0 });
  });

  it('超过 maxAttempts → DEAD 死信', async () => {
    const failGateway: NotificationGateway = { send: async () => ({ ok: false, error: 'boom' }) };
    // 预置 attempts=4，maxAttempts=5 → 抢占后 attempts=5 达上限 → DEAD
    const db = makeDb([base('n1', { attempts: 4 })]);
    const res = await dispatchPendingNotifications(db, failGateway, new Date(), 30_000, 50, 5);
    expect(res).toEqual({ dispatched: 0, failed: 0, dead: 1 });
    const peek = await db.query<Row>(`SELECT id, status FROM notification_outbox WHERE id = ANY($1)`, [['n1']]);
    expect(peek.rows[0].status).toBe('DEAD');
  });

  it('网关按消息逐条调用，携带 channel/recipient/payload', async () => {
    const calls: OutboundNotification[] = [];
    const spy: NotificationGateway = {
      send: vi.fn(async (msg) => {
        calls.push(msg);
        return { ok: true,accepted:true,messageId:'om_test' };
      }),
    };
    const db = makeDb([base('n1'), base('n2', { channel: 'FEISHU', recipient_id: 'u2' })]);
    await dispatchPendingNotifications(db, spy, new Date());
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: 'n1', channel: 'IN_APP', recipientId: 'u1' });
    expect(calls[1]).toMatchObject({ id: 'n2', channel: 'FEISHU', recipientId: 'u2' });
    expect(calls[1].payload).toMatchObject({ type: 'RESULT_PUBLISHED' });
  });
});

it('logging alone never marks delivery or provider acceptance',async()=>{
 const result=await dispatchPendingNotifications(makeDb([base('log-only')]),LocalLogGateway,new Date());
 expect(result).toEqual({dispatched:0,failed:1,dead:0});
});
