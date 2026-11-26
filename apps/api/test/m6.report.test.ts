import '../../../scripts/test-db-setup.cjs';
import { ITEM_REASON_OK } from './helpers/review-text';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { purgeCycles } from './helpers/cycle-cleanup';


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

const TEST_MONTH = '2034-06';
const OWNED_MONTHS = [`${TEST_MONTH}-01`];
let db: Pool | undefined;
let app: INestApplication | undefined;
let baseUrl = '';

async function req(method: string, url: string, body?: unknown, cookie?: string) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* */ }
  const setCookie = res.headers.get('set-cookie')?.split(';')[0];
  return { status: res.status, body: json, setCookie };
}

async function loginAs(name: string): Promise<string> {
  const { rows } = await db!.query(`SELECT id FROM users WHERE display_name = $1`, [name]);
  if (!rows[0]) throw new Error(`用户不存在: ${name}`);
  const res = await req('POST', '/api/v1/auth/demo-login', { user_id: rows[0].id });
  return res.setCookie!;
}
async function loginAsId(id: string): Promise<string> {
  const res = await req('POST', '/api/v1/auth/demo-login', { user_id: id });
  return res.setCookie!;
}
async function grantCap(userId: string, capability: string): Promise<void> {
  await db!.query(
    `INSERT INTO capability_grants (id, org_id, user_id, capability, scope_type, reason)
     VALUES (gen_random_uuid(), (SELECT org_id FROM users WHERE id = $1), $1, $2, 'ORG', 'M6 测试临时授权')`,
    [userId, capability],
  );
}
async function revokeTempCaps(): Promise<void> {
  await db!.query(`DELETE FROM capability_grants WHERE reason = 'M6 测试临时授权'`);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  db = new Pool({ connectionString: DB_URL });
  await purgeCycles(db, OWNED_MONTHS);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
}, 60000);

afterAll(async () => {
  if (db) {
    await revokeTempCaps().catch(() => undefined);
    await purgeCycles(db, OWNED_MONTHS).catch(() => undefined);
  }
  if (app) await app.close();
  if (db) await db.end();
});

describe.skipIf(!dbAvailable)('M6 月报生成', () => {
  const PEER_SCORES = [76, 82, 68, 89];
  const SELF_SCORE = 88;
  let cycleId = '';
  let adminCookie = '';
  let supervisorCookie = '';
  let adminId = '';
  let targetId = '';

  it('准备：开期、提交评价、构建、审批、发布', async () => {
    adminCookie = await loginAs('示例成员18');
    supervisorCookie = await loginAs('示例成员50');
    adminId = (await db!.query<{ id: string }>(`SELECT id FROM users WHERE display_name = '示例成员18'`)).rows[0].id;

    const rs = await db!.query<{ id: string }>(
      `SELECT rs.id FROM rulesets rs
        WHERE rs.status = 'FROZEN'
          AND (SELECT count(DISTINCT tv.role_code) FROM template_versions tv WHERE tv.ruleset_id = rs.id) = 5
        ORDER BY rs.created_at LIMIT 1`,
    );
    if (!rs.rowCount) throw new Error('无含 5 类模板的 FROZEN 规则集');
    const c = await req('POST', '/api/v1/cycles', {
      month: TEST_MONTH, title: 'M6 test',
      open_at: new Date(Date.now() - 60_000).toISOString(),
      close_at: new Date(Date.now() + 86_400_000).toISOString(),
      publish_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      ruleset_id: rs.rows[0].id,
    }, adminCookie);
    expect(c.status).toBe(201);
    cycleId = c.body.data.id;
    expect((await req('POST', `/api/v1/cycles/${cycleId}/submit`, {}, adminCookie)).status).toBe(200);
    const prev = await req('POST', `/api/v1/cycles/${cycleId}/assignment/preview`, {}, adminCookie);
    const open = await req('POST', `/api/v1/cycles/${cycleId}/open`, { run_id: prev.body.data.id }, adminCookie);
    expect(open.status).toBe(200);

    const cand = await db!.query<{ target_id: string }>(
      `SELECT a.target_id FROM assignments a
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE' AND a.target_id <> $2
        GROUP BY a.target_id HAVING count(*) = 4 LIMIT 1`,
      [cycleId, adminId],
    );
    if (!cand.rowCount) throw new Error('无入度=4 的 target');
    targetId = cand.rows[0].target_id;

    const reviews = await db!.query<{ id: string; reviewer_id: string }>(
      `SELECT r.id, r.reviewer_id FROM reviews r
         JOIN assignments a ON a.id = r.assignment_id
        WHERE r.cycle_id = $1 AND r.target_id = $2 AND r.kind = 'PEER'`,
      [cycleId, targetId],
    );
    for (let i = 0; i < reviews.rows.length; i++) {
      const cookie = await loginAsId(reviews.rows[i].reviewer_id);
      const detail = await req('GET', `/api/v1/reviews/${reviews.rows[i].id}`, undefined, cookie);
      const items: Array<{ id: string }> = detail.body.data.template.items;
      await req('PUT', `/api/v1/reviews/${reviews.rows[i].id}/draft`, {
        items: items.map((it) => ({ itemId: it.id, score: PEER_SCORES[i], reason: ITEM_REASON_OK })),
        overallReason: '整体说明', readConfirmed: true,
      }, cookie);
      expect((await req('POST', `/api/v1/reviews/${reviews.rows[i].id}/submit`, {}, cookie)).status).toBe(200);
    }
    const targetCookie = await loginAsId(targetId);
    const self = await req('POST', `/api/v1/cycles/${cycleId}/self-review`, {}, targetCookie);
    const selfDetail = await req('GET', `/api/v1/reviews/${self.body.data.reviewId}`, undefined, targetCookie);
    const selfItems: Array<{ id: string }> = selfDetail.body.data.template.items;
    await req('PUT', `/api/v1/reviews/${self.body.data.reviewId}/draft`, {
      items: selfItems.map((it) => ({ itemId: it.id, score: SELF_SCORE, reason: ITEM_REASON_OK })),
      overallReason: '自评说明', nextPlan: '下季重点', readConfirmed: true,
    }, targetCookie);
    expect((await req('POST', `/api/v1/reviews/${self.body.data.reviewId}/submit`, {}, targetCookie)).status).toBe(200);

    const scan = await req('POST', `/api/v1/cycles/${cycleId}/calibration-scan`, {}, supervisorCookie);
    expect(scan.status).toBe(200);
    const build = await req('POST', `/api/v1/cycles/${cycleId}/results/build`, { targetId }, supervisorCookie);
    expect(build.status).toBe(200);
    const buildId = build.body.data.items[0].buildId;

    await grantCap(adminId, 'result.publish');
    await grantCap(targetId, 'result.confirm');
    const supervisorId = (await db!.query<{ id: string }>(`SELECT id FROM users WHERE display_name = '示例成员50'`)).rows[0].id;
    await grantCap(supervisorId, 'result.confirm');
    expect((await req('POST', `/api/v1/result-builds/${buildId}/approve`, { decision: 'APPROVED', reason: '依据有效' }, supervisorCookie)).status).toBe(200);
    await db!.query(`UPDATE cycles SET status = 'CALIBRATING' WHERE id = $1`, [cycleId]);
    const publish = await req('POST', `/api/v1/result-builds/${buildId}/publish`, {}, adminCookie);
    expect(publish.status).toBe(200);
  });

  it('月报：report.view 生成 → 200 且聚合结构正确', async () => {
    await grantCap(adminId, 'report.view');
    const res = await req('GET', `/api/v1/cycles/${cycleId}/monthly-report`, undefined, adminCookie);
    expect(res.status).toBe(200);
    const org = res.body.data.org;
    expect(org.publishedCount).toBeGreaterThanOrEqual(1);
    expect(typeof org.avgScore).toBe('number');
    // final_score 为百分制（M4 exact_score = round(score_bp)/100）；本周期已发布结果约 78.75 → 入 qualified 档。
    expect(org.distribution).toHaveProperty('qualified');
    expect(org.distribution.qualified).toBeGreaterThan(0);
    const snap = await db!.query<{ id: string }>(
      `SELECT id FROM result_monthly_reports WHERE cycle_id = $1 AND scope = 'ORG'`, [cycleId],
    );
    expect(snap.rowCount).toBe(1);
  });

  it('月报：report.view 缺失 → 403', async () => {
    const targetCookie = await loginAsId(targetId);
    const res = await req('GET', `/api/v1/cycles/${cycleId}/monthly-report`, undefined, targetCookie);
    expect(res.status).toBe(403);
  });

  it('月报：幂等生成应更新同一快照（ORG 唯一约束）', async () => {
    const first = await db!.query<{ id: string }>(
      `SELECT id FROM result_monthly_reports WHERE cycle_id = $1 AND scope = 'ORG'`, [cycleId],
    );
    await req('GET', `/api/v1/cycles/${cycleId}/monthly-report`, undefined, adminCookie);
    const second = await db!.query<{ id: string }>(
      `SELECT id FROM result_monthly_reports WHERE cycle_id = $1 AND scope = 'ORG'`, [cycleId],
    );
    expect(second.rows[0].id).toBe(first.rows[0].id);
  });
});
