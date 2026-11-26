import '../../../scripts/test-db-setup.cjs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';


const DB_URL = process.env.DATABASE_URL!;
const dbAvailable = await (async () => {
  try {
    const p = new Pool({ connectionString: DB_URL });
    await p.query('SELECT 1');
    await p.end();
    return true;
  } catch {
    return false;
  }
})();

let db: Pool | undefined;
let app: INestApplication | undefined;
let baseUrl = '';

async function raw(method: string, url: string, cookie?: string) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: cookie ? { cookie } : {},
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    contentType: res.headers.get('content-type') ?? '',
    disposition: res.headers.get('content-disposition') ?? '',
  };
}
async function loginAs(name: string): Promise<string> {
  const { rows } = await db!.query(`SELECT id FROM users WHERE display_name = $1`, [name]);
  if (!rows[0]) throw new Error(`用户不存在: ${name}`);
  const res = await fetch(baseUrl + '/api/v1/auth/demo-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: rows[0].id }),
  });
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}
async function loginAsId(id: string): Promise<string> {
  const res = await fetch(baseUrl + '/api/v1/auth/demo-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: id }),
  });
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}
async function grantCap(userId: string, capability: string): Promise<void> {
  await db!.query(
    `INSERT INTO capability_grants (id, org_id, user_id, capability, scope_type, reason)
     VALUES (gen_random_uuid(), (SELECT org_id FROM users WHERE id = $1), $1, $2, 'ORG', 'M7 测试临时授权')`,
    [userId, capability],
  );
}
async function revokeTempCaps(): Promise<void> {
  await db!.query(`DELETE FROM capability_grants WHERE reason = 'M7 测试临时授权'`);
}

let adminId = '';
let orgId = '';
let adminCookie = '';
let otherCookie = '';

beforeAll(async () => {
  if (!dbAvailable) return;
  db = new Pool({ connectionString: DB_URL });
  const u = await db.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM users ORDER BY created_at LIMIT 2`,
  );
  if (u.rowCount < 2) throw new Error('测试用户不足 2 个');
  adminId = u.rows[0].id;
  orgId = u.rows[0].org_id;
  const otherId = u.rows[1].id;

  // audit_events 为追加写日志（触发器禁止 DELETE），仅插入固定样本，断言按内容而非计数
  await db.query(
    `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason, request_id)
     VALUES
       ($1, $2, 'result.publish', 'published_result', 'pr-1', 'v1', 'm7-r-1'),
       ($1, $2, 'feedback.resolve', 'feedback', 'fb-3', 'APPROVED', 'm7-r-2'),
       ($1, $2, 'award.manage', 'award_decision', 'aw-2', '评定优秀', 'm7-r-3')`,
    [orgId, adminId],
  );
  await grantCap(adminId, 'audit.export');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  adminCookie = await loginAsId(adminId);
  otherCookie = await loginAsId(otherId);
}, 60000);

afterAll(async () => {
  // audit_events 触发器禁止 DELETE（只追加），样本保留不影响断言；仅回撤临时授权
  if (db) await revokeTempCaps().catch(() => undefined);
  if (app) await app.close();
  if (db) await db.end();
});

describe.skipIf(!dbAvailable)('M7 审计报表导出', () => {
  it('audit.export 导出 CSV → 200 + 表头 + 下载头', async () => {
    const res = await raw('GET', '/api/v1/audit/export?format=csv', adminCookie);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/csv');
    expect(res.disposition).toContain('attachment');
    expect(res.disposition).toContain('audit-events-');
    expect(res.text).toContain('序号,时间,操作人,操作,资源类型,资源ID,原因,请求ID');
    expect(res.text).toContain('result.publish');
    expect(res.text).toContain('award.manage');
  });

  it('audit.export 导出 PDF（打印 HTML）→ 200 + text/html + 表格', async () => {
    const res = await raw('GET', '/api/v1/audit/export?format=pdf', adminCookie);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.text).toContain('<table');
    expect(res.text).toContain('审计事件导出');
    expect(res.text).toContain('@media print');
  });

  it('audit.export 列表预览 → 200 + JSON data 数组', async () => {
    const res = await fetch(baseUrl + '/api/v1/audit/events', { headers: { cookie: adminCookie } });
    const json = (await res.json()) as { data: unknown[] };
    expect(res.status).toBe(200);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(3);
  });

  it('audit.export 能力缺失 → 403', async () => {
    const res = await raw('GET', '/api/v1/audit/export?format=csv', otherCookie);
    expect(res.status).toBe(403);
  });
});
