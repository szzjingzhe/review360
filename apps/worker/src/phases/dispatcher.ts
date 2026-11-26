import { pool } from '../db.js';
import { env } from '../env.js';
import { executePhase, type PhaseName } from './handlers.js';
import { dispatchPendingNotifications } from '@360/domain';
import { FeishuNotificationGateway } from '../feishu-notification.gateway.js';
import { dispatchCycleReminders } from '../reminders.js';
const notificationGateway=new FeishuNotificationGateway(pool);

export type DuePhase = {
  cycle_id: string;
  phase: PhaseName;
  planned_at: Date;
};

export async function fetchDuePhases(limit = 50): Promise<DuePhase[]> {
  const { rows } = await pool.query<DuePhase>(
    `SELECT p.cycle_id, p.phase, p.planned_at
       FROM cycle_phases p JOIN cycles c ON c.id=p.cycle_id
      WHERE p.actual_at IS NULL AND p.phase IN ('OPEN','CLOSE')
        AND c.status IN ('PENDING_OPEN','REVIEWING')
        AND planned_at <= now()
      ORDER BY planned_at
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function tick(logger: (msg: string, extra?: Record<string, unknown>) => void): Promise<void> {
  const due = await fetchDuePhases();
  if(due.length)logger('scan', { due: due.length });

  // 催办提醒：按时间窗把「该发还没发」的提醒写入 outbox，下面一拍由网关投递。
  try {
    const queued = await dispatchCycleReminders(pool);
    if (queued > 0) logger('reminder_queued', { queued });
  } catch (err) {
    logger('reminder_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // 通知投递：每拍抢占并交由网关真实投递（事务外发，租约防并发）。
  // 本地无凭据时 LocalLogGateway 仅记录并成功；生产由真实网关（飞书/邮件）替换。
  try {
    // Claims/acknowledgements commit separately; never hold a DB transaction across provider I/O.
    const { dispatched, failed, dead } = await dispatchPendingNotifications(pool, notificationGateway, new Date(),30000,1);
    if (dispatched > 0 || failed > 0 || dead > 0) {
      logger('notify_provider_accepted', { accepted:dispatched, failed, dead });
    }
  } catch (err) {
    logger('notify_error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const item of due) {
    const start = Date.now();
    try {
      const outcome = await executePhase(item.phase, item.cycle_id, item.planned_at);
      logger(outcome.kind==='SKIPPED'?'phase_skipped':outcome.kind==='ALREADY'?'phase_already':'phase_done', {
        cycle_id: item.cycle_id,
        phase: item.phase,
        kind: outcome.kind,
        from: 'fromStatus' in outcome ? outcome.fromStatus : null,
        to: 'toStatus' in outcome ? outcome.toStatus : null,
        reason: 'reason' in outcome ? outcome.reason : null,
        elapsed_ms: Date.now() - start,
      });
    } catch (err) {
      logger('phase_failed', {
        cycle_id: item.cycle_id,
        phase: item.phase,
        elapsed_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export type WorkerLogger = (msg: string, extra?: Record<string, unknown>) => void;

export function makeJsonLogger(instanceId: string): WorkerLogger {
  return (msg, extra) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), instance: instanceId, msg, ...extra });
    process.stdout.write(line + '\n');
  };
}

export function makePrettyLogger(instanceId: string): WorkerLogger {
  return (msg, extra) => {
    const tail = extra ? ' ' + JSON.stringify(extra) : '';
    process.stdout.write(`[${instanceId}] ${msg}${tail}\n`);
  };
}

export type LoopHandle = { stop: () => void };

/**
 * 给单次 tick 套超时：数据库卡住时不让 loop 被永久堵死。
 * 注意：超时只是让 loop 放行，不中断已在飞的 SQL（连接池 max=4 防止无限堆积）。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tick_timeout_${ms}ms`)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 用 setTimeout 递归而非 setInterval：保证 tick 串行、不重叠。
 * 启动即刻执行一次，避免第一拍要等一个轮询周期。
 */
export function startLoop(logger: WorkerLogger): LoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, env.WORKER_POLL_MS);
    timer.unref();
  };

  const run = async (): Promise<void> => {
    const start = Date.now();
    try {
      await withTimeout(tick(logger), env.WORKER_TICK_TIMEOUT_MS);
    } catch (err) {
      logger('tick_error', {
        error: err instanceof Error ? err.message : String(err),
        elapsed_ms: Date.now() - start,
      });
    }
    schedule();
  };

  void run();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
