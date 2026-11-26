import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * 从环境变量（或仓库根 .env）解析 DATABASE_URL。
 * 不引入 dotenv，保持零额外依赖；tsx 启动前由调用方保证变量存在。
 */
export function loadEnvFile(): void {
  if (process.env.APP_ENV === 'test') return;
  const candidates = ['../../../.env', '../../.env', '../.env', '.env'];
  for (const c of candidates) {
    try {
      const text = readFileSync(new URL(c, import.meta.url), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m && !(m[1] in process.env)) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
      return;
    } catch {
      // 尝试下一个候选路径
    }
  }
}

export function createPool(): Pool {
  if (process.env.APP_ENV === 'test') {
    createRequire(import.meta.url)('../../../scripts/test-db-safety.cjs').assertTestDatabase();
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL 未设置（请参考根目录 .env.example）');
  }
  return new Pool({ connectionString: url, max: 5 });
}

/** Test migrations and fixtures verify the server marker before their first write. */
export async function verifyTestPool(pool: Pool): Promise<void> {
  if(process.env.APP_ENV==='test') await createRequire(import.meta.url)('../../../scripts/test-db-safety.cjs').verifyTestConnection(pool);
}
