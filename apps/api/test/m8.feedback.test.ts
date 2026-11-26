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
     VALUES (gen_random_uuid(), (SELECT org_id FROM users WHERE id = $1), $1, $2, 'ORG', 'M8 测试临时授权')`,
    [userId, capability],
  );
}
async function revokeTempCaps(): Promise<void> {
  await db!.query(`DELETE FROM capability_grants WHERE reason = 'M8 测试临时授权'`);
}

let ownerId = '';
let otherId = '';
let orgId = '';
let ownerCookie = '';
let otherCookie = '';

// 自包含夹具：构造 cycle → result_build → published_result → feedback_requests
// （不依赖其它测试的残留数据，避免 published_results 被清理后无样本）
let cycleId = '';
let buildId = '';
let pubId = '';
let cycleId2 = '';
let buildId2 = '';
let pubId2 = '';
let fbDoneId = '';
let fbPendId = '';

beforeAll(async () => {
  if (!dbAvailable) return;
  db = new Pool({ connectionString: DB_URL });

  const org = await db.query<{ id: string }>(`SELECT id FROM organizations LIMIT 1`);
  if (!org.rowCount) throw new Error('无组织');
  orgId = org.rows[0].id;

  const u = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE org_id = $1 ORDER BY created_at LIMIT 2`,
    [orgId],
  );
  if (u.rowCount < 2) throw new Error('测试用户不足 2 个');
  ownerId = u.rows[0].id;
  otherId = u.rows[1].id;

  // 构造最小发布结果链（month 取随机远月且必须为每月 1 号，避免中断残留触发 uq_cycle_month 唯一约束）
  const fixtureMonth = new Date(Date.UTC(2100, Math.floor(Math.random() * 300), 1))
    .toISOString()
    .slice(0, 10);
  const c = await db.query<{ id: string }>(
    `INSERT INTO cycles (id, org_id, month, title, status, open_at, close_at, publish_at)
     VALUES (gen_random_uuid(), $1, $2, 'M8 测试周期', 'PUBLISHED',
             now() - interval '3 days', now() - interval '2 days', now() - interval '1 day')
     RETURNING id`,
    [orgId, fixtureMonth],
  );
  cycleId = c.rows[0].id;
  await db.query(`INSERT INTO cycle_participants(cycle_id,org_id,user_id,dept_snapshot,role_snapshot)
    SELECT $1,$2,$3,id,'MEMBER' FROM departments WHERE org_id=$2 LIMIT 1`,[cycleId,orgId,ownerId]);
  const b = await db.query<{ id: string }>(
    `INSERT INTO result_builds (id, cycle_id, org_id, target_id, input_hash, formula_version, status)
     VALUES (gen_random_uuid(), $1, $2, $3, 'm8-fixture', 'v1', 'PUBLISHED')
     RETURNING id`,
    [cycleId, orgId, ownerId],
  );
  buildId = b.rows[0].id;
  const p = await db.query<{ id: string }>(
    `INSERT INTO published_results (id, cycle_id, org_id, target_id, publication_version, result_build_id, payload_json, published_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, '{"final_score": 78.75}', now())
     RETURNING id`,
    [cycleId, orgId, ownerId, buildId],
  );
  pubId = p.rows[0].id;

  // 样本：owner 名下一条 DONE（可发起二次申诉，挂在 pub1）
  const fbDone = await db.query<{ id: string }>(
    `INSERT INTO feedback_requests (id, publication_id, org_id, applicant_id, reason, status)
     VALUES (gen_random_uuid(), $1, $2, $3, '一级已闭环，申请二次复核', 'DONE')
     RETURNING id`,
    [pubId, orgId, ownerId],
  );
  fbDoneId = fbDone.rows[0].id;
  // 第二条周期 + 发布结果（uq_published_result 为 cycle_id+target_id 唯一，PENDING 样本必须挂不同周期）
  const fixtureMonth2 = new Date(Date.UTC(2200, Math.floor(Math.random() * 300), 1))
    .toISOString()
    .slice(0, 10);
  const c2 = await db.query<{ id: string }>(
    `INSERT INTO cycles (id, org_id, month, title, status, open_at, close_at, publish_at)
     VALUES (gen_random_uuid(), $1, $2, 'M8 测试周期2', 'PUBLISHED',
             now() - interval '3 days', now() - interval '2 days', now() - interval '1 day')
     RETURNING id`,
    [orgId, fixtureMonth2],
  );
  cycleId2 = c2.rows[0].id;
  const b2 = await db.query<{ id: string }>(
    `INSERT INTO result_builds (id, cycle_id, org_id, target_id, input_hash, formula_version, status)
     VALUES (gen_random_uuid(), $1, $2, $3, 'm8-fixture-2', 'v1', 'PUBLISHED')
     RETURNING id`,
    [cycleId2, orgId, ownerId],
  );
  buildId2 = b2.rows[0].id;
  const p2 = await db.query<{ id: string }>(
    `INSERT INTO published_results (id, cycle_id, org_id, target_id, publication_version, result_build_id, payload_json, published_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, '{"final_score": 61.0}', now())
     RETURNING id`,
    [cycleId2, orgId, ownerId, buildId2],
  );
  pubId2 = p2.rows[0].id;
  const fbPend = await db.query<{ id: string }>(
    `INSERT INTO feedback_requests (id, publication_id, org_id, applicant_id, reason, status)
     VALUES (gen_random_uuid(), $1, $2, $3, '待处理反馈', 'PENDING')
     RETURNING id`,
    [pubId2, orgId, ownerId],
  );
  fbPendId = fbPend.rows[0].id;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  ownerCookie = await loginAsId(ownerId);
  otherCookie = await loginAsId(otherId);
}, 60000);

afterAll(async () => {
  if (db) {
    await revokeTempCaps().catch(() => undefined);
    await db.query(`DELETE FROM feedback_requests WHERE id IN ($1, $2)`, [fbDoneId, fbPendId]).catch(() => undefined);
    await db.query(`DELETE FROM published_results WHERE id IN ($1, $2)`, [pubId, pubId2]).catch(() => undefined);
    await db.query(`DELETE FROM result_builds WHERE id IN ($1, $2)`, [buildId, buildId2]).catch(() => undefined);
    await db.query(`DELETE FROM cycle_participants WHERE cycle_id IN ($1,$2)`,[cycleId,cycleId2]);
    await db.query(`DELETE FROM cycles WHERE id IN ($1, $2)`, [cycleId, cycleId2]).catch(() => undefined);
  }
  if (app) await app.close();
  if (db) await db.end();
});

async function postJson(url: string, body: unknown, cookie: string) {
  const res = await fetch(baseUrl + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: () => { try { return JSON.parse(text); } catch { return null; } } };
}

describe.skipIf(!dbAvailable)('M8 二次申诉评审', () => {
  it('本人对一级结案记录发起二次申诉 → 200 + REREVIEW_PENDING', async () => {
    const res = await postJson(`/api/v1/feedback-requests/${fbDoneId}/rereview`, { reason: '对闭环结论仍存异议' }, ownerCookie);
    expect(res.status).toBe(200);
    expect(res.json()?.data?.status).toBe('REREVIEW_PENDING');
  });

  it('非本人发起二次申诉 → 403 NOT_OWN_RESULT', async () => {
    const res = await postJson(`/api/v1/feedback-requests/${fbDoneId}/rereview`, { reason: '冒名' }, otherCookie);
    expect(res.status).toBe(403);
  });

  it('对 PENDING 记录发起二次申诉 → 409 REREVIEW_NOT_ALLOWED', async () => {
    const res = await postJson(`/api/v1/feedback-requests/${fbPendId}/rereview`, { reason: '未结案就申诉' }, ownerCookie);
    expect(res.status).toBe(409);
  });

  it('无 feedback.manage 二审 → 403', async () => {
    const res = await postJson(`/api/v1/feedback-requests/${fbDoneId}/rereview/resolve`, { decision: 'APPROVED' }, otherCookie);
    expect(res.status).toBe(403);
  });

  it('feedback.manage 二审 → 200 + REREVIEW_DONE + 审计落库', async () => {
    await grantCap(otherId, 'feedback.manage');
    const res = await postJson(`/api/v1/feedback-requests/${fbDoneId}/rereview/resolve`, { decision: 'APPROVED', note: '复核支持' }, otherCookie);
    expect(res.status).toBe(200);
    expect(res.json()?.data?.status).toBe('REREVIEW_DONE');
    const aud = await db!.query<{ id: string }>(
      `SELECT id FROM audit_events WHERE action = 'feedback.rereview.resolve' AND resource_id = $1`,
      [fbDoneId],
    );
    expect(aud.rowCount).toBeGreaterThanOrEqual(1);
  });
});
