import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// .env 位于仓库根目录（worker 在 apps/worker，向上一级到 apps，再上一级到根）
const envPath = resolve(process.cwd(), '../../.env');
try {
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (!(k in process.env)) process.env[k] = v;
  }
} catch {
  // .env 不存在时回退到 process.env（生产/演示用注入环境变量）
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

export const env = {
  DATABASE_URL: need('DATABASE_URL'),
  WORKER_POLL_MS: Number(process.env.WORKER_POLL_MS ?? 5000),
  WORKER_TICK_TIMEOUT_MS: Number(process.env.WORKER_TICK_TIMEOUT_MS ?? 30000),
  WORKER_LOG_JSON: process.env.WORKER_LOG_JSON === '1',
  WORKER_INSTANCE_ID: process.env.WORKER_INSTANCE_ID ?? `worker-${process.pid}`,
};
