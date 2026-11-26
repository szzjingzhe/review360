// Explicitly confirmed local postgres maintenance connection; no business .env loading.
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { assertTestAdmin, assertTestDatabase } = require('./test-db-safety.cjs');
const root = resolve(__dirname, '..');
async function main() {
  const admin = assertTestAdmin(); // Fail before importing pg or making any connection.
  const { Pool } = createRequire(resolve(root, 'packages/database/package.json'))('pg');
  const name = 'review360_test_' + randomBytes(12).toString('hex');
  const target = new URL(admin); target.pathname = '/' + name;
  const env = { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', TEST_DB_ISOLATED: 'true',
    DATABASE_URL: target.toString(), TEST_DATABASE_URL: target.toString() };
  assertTestDatabase(env);
  const db = new Pool({ connectionString: admin.toString(), connectionTimeoutMillis: 5000 });
  let created = false;
  try {
    await db.query('CREATE DATABASE "' + name + '"'); created = true;
    await db.query('COMMENT ON DATABASE "' + name + '" IS \'review360 isolated test v1\'');
    for (const command of ['pnpm db:migrate', 'pnpm db:seed', 'pnpm --filter @360/domain test',
      'pnpm --filter @360/web test', 'pnpm --filter @360/api test', 'pnpm --filter @360/worker test']) {
      const r = spawnSync(command, { cwd: root, env, shell: true, stdio: 'inherit' });
      if (r.error || r.status !== 0) throw new Error('Isolated test command failed: ' + command);
    }
  } finally {
    // Only the random database successfully created by this invocation may be dropped.
    try { if (created) { assertTestDatabase(env); await db.query('DROP DATABASE "' + name + '"'); } }
    finally { await db.end(); }
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
