import { pool } from './db.js';
import { env } from './env.js';
import { makeJsonLogger, makePrettyLogger, startLoop } from './phases/dispatcher.js';

const logger = env.WORKER_LOG_JSON
  ? makeJsonLogger(env.WORKER_INSTANCE_ID)
  : makePrettyLogger(env.WORKER_INSTANCE_ID);

logger('boot', {
  pid: process.pid,
  poll_ms: env.WORKER_POLL_MS,
  tick_timeout_ms: env.WORKER_TICK_TIMEOUT_MS,
});

// startLoop 内部立即执行首拍，并在每拍结束后按 WORKER_POLL_MS 排下一拍
const loop = startLoop(logger);

let stopping = false;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  loop.stop();
  logger('shutdown', { signal });
  // 给在飞的 tick 一点时间收尾，避免连接被硬切
  setTimeout(async () => {
    await pool.end().catch(() => undefined);
    process.exit(0);
  }, 1500).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger('unhandled_rejection', { error: err instanceof Error ? err.message : String(err) });
});
