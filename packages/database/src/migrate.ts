/**
 * 轻量 SQL 迁移运行器（前向迁移，不生成回滚）。
 * - 迁移文件：packages/database/migrations/NNN_name.sql，按文件名排序执行
 * - 每个文件在单个事务中执行，成功后记录到 schema_migrations
 * - 依赖 pg 的事务与 advisory lock，避免并发重复执行
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool, loadEnvFile, verifyTestPool } from './env.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main(): Promise<void> {
  loadEnvFile();
  const pool = createPool();
  await verifyTestPool(pool);
  const client = await pool.connect();
  try {
    // 全局 advisory lock：串行化并发迁移
    await client.query(`SELECT pg_advisory_lock(360001)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ filename: string }>(`SELECT filename FROM schema_migrations`)).rows.map(
        (r) => r.filename,
      ),
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('没有待执行的迁移文件');
    }

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`应用迁移: ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`迁移失败（已回滚）: ${file}`);
        throw err;
      }
    }
    console.log('迁移完成');
  } finally {
    await client.query(`SELECT pg_advisory_unlock(360001)`).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
