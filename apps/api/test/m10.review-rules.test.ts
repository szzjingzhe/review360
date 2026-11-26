import '../../../scripts/test-db-setup.cjs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { purgeCycles } from './helpers/cycle-cleanup';
import {
  ITEM_REASON_OK,
  OVERALL_STATEMENT_OK,
  SHORT_OVERALL,
} from './helpers/review-text';


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

const TEST_MONTH = '2034-08';
const PREREQ_MONTH = '2034-09';
const OWNED_MONTHS = [`${TEST_MONTH}-01`, `${PREREQ_MONTH}-01`];
let db: Pool | undefined;
let app: INestApplication | undefined;
let baseUrl = '';

async function req(
  method: string,
  url: string,
  body?: unknown,
  cookie?: string,
  extraHeaders?: Record<string, string>,
) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(extraHeaders ?? {}),
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

/** 保存草稿并提交；返回提交响应，便于断言状态码与错误码 */
async function draftAndSubmit(
  reviewId: string,
  reviewerId: string,
  opts: {
    score?: number;
    lowFirst?: boolean;
    reason?: string;
    overall?: string;
    idempotencyKey?: string;
  } = {},
) {
  const cookie = await loginAsId(reviewerId);
  const detail = await req('GET', `/api/v1/reviews/${reviewId}`, undefined, cookie);
  expect(detail.status).toBe(200);
  const items: Array<{ id: string }> = detail.body.data.template.items;
  const score = opts.score ?? 80;
  const save = await req('PUT', `/api/v1/reviews/${reviewId}/draft`, {
    items: items.map((it, i) => ({
      itemId: it.id,
      score: opts.lowFirst && i === 0 ? 50 : score,
      reason: opts.reason ?? ITEM_REASON_OK,
    })),
    overallReason: opts.overall ?? OVERALL_STATEMENT_OK,
    comment: '继续保持',
    readConfirmed: true,
  }, cookie);
  expect(save.status).toBe(200);
  return req(
    'POST',
    `/api/v1/reviews/${reviewId}/submit`,
    {},
    cookie,
    opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : undefined,
  );
}

interface PoolRow {
  assignment_id: string;
  reviewer_id: string;
  review_id: string;
  target_id: string;
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
    await purgeCycles(db, OWNED_MONTHS).catch((err) => {
      console.error('[m10] 清理失败:', err instanceof Error ? err.message : err);
    });
  }
  if (app) await app.close();
  if (db) await db.end();
});

describe.skipIf(!dbAvailable)('M10 提交期校验与安全（A09–A14 / B3 / B4 / B8 / C8）', () => {
  let cycleId = '';
  let adminCookie = '';
  let supervisorCookie = '';
  let pool: PoolRow[] = [];
  /** 预分配给 A11（高分比例）的行：某位任务数最多的评价人的前 4 份任务 */
  let a11ReviewerId = '';
  let a11Rows: PoolRow[] = [];
  /** 其余用例使用的行，与 a11Rows 不重叠，避免"已提交"互相踩 */
  let rest: PoolRow[] = [];
  /** 记录被临时停用的任命，测试结束必须恢复 */
  const revokedAppointmentIds: string[] = [];

  it('准备：开期 2034-08 并预分配候选评价任务', async () => {
    adminCookie = await loginAs('示例成员18');
    supervisorCookie = await loginAs('示例成员50');
    const rs = await db!.query<{ id: string }>(`SELECT id FROM rulesets WHERE status = 'FROZEN' LIMIT 1`);
    const c = await req('POST', '/api/v1/cycles', {
      month: TEST_MONTH,
      title: 'M10 review rules test',
      open_at: new Date(Date.now() - 60_000).toISOString(),
      close_at: new Date(Date.now() + 86_400_000).toISOString(),
      publish_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      ruleset_id: rs.rows[0].id,
    }, adminCookie);
    expect(c.status).toBe(201);
    cycleId = c.body.data.id;

    expect((await req('POST', `/api/v1/cycles/${cycleId}/submit`, {}, adminCookie)).status).toBe(200);
    const prev = await req('POST', `/api/v1/cycles/${cycleId}/assignment/preview`, {}, adminCookie);
    expect(prev.status).toBe(200);
    const open = await req('POST', `/api/v1/cycles/${cycleId}/open`, { run_id: prev.body.data.id }, adminCookie);
    expect(open.status).toBe(200);

    const rows = await db!.query<PoolRow>(
      `SELECT a.id AS assignment_id, a.reviewer_id, r.id AS review_id, a.target_id
         FROM assignments a
         JOIN reviews r ON r.assignment_id = a.id AND r.kind = 'PEER'
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE'
        ORDER BY a.reviewer_id, r.id`,
      [cycleId],
    );
    pool = rows.rows;
    expect(pool.length).toBeGreaterThanOrEqual(10);

    // A11 需要同一评价人的 4 份任务；选任务数最多者，避免与其它用例抢行
    const best = await db!.query<{ reviewer_id: string }>(
      `SELECT a.reviewer_id
         FROM assignments a
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE'
        GROUP BY a.reviewer_id HAVING count(*) >= 4
        ORDER BY count(*) DESC, a.reviewer_id LIMIT 1`,
      [cycleId],
    );
    expect(best.rowCount).toBe(1);
    a11ReviewerId = best.rows[0].reviewer_id;
    const mine = pool.filter((r) => r.reviewer_id === a11ReviewerId);
    a11Rows = mine.slice(0, 4);
    rest = pool.filter((r) => r.reviewer_id !== a11ReviewerId);
    expect(a11Rows.length).toBe(4);
    expect(rest.length).toBeGreaterThanOrEqual(6);
  }, 60000);

  it('per-item boundaries reject short reasons, allow 60–79, and accept exactly 100 characters',async()=>{
    const row=rest[0];
    for(const score of [0,59,80,100]){
      const bad=await draftAndSubmit(row.review_id,row.reviewer_id,{score,reason:'字'.repeat(99),overall:''});
      expect(bad.status).toBe(400);expect(bad.body.violations[0]).toMatchObject({requiredChars:100,actualChars:99});
      expect(bad.body.violations[0].itemId).toBeTruthy();
    }
    for(const [index,score] of [60,79].entries()){
      const ok=await draftAndSubmit(rest[index+2].review_id,rest[index+2].reviewer_id,{score,reason:'',overall:''});expect(ok.status).toBe(200);
    }
    for(const [index,score] of [0,59,80,100].entries()){
      const target=rest[[0,1,4,7][index]];
      const ok=await draftAndSubmit(target.review_id,target.reviewer_id,{score,reason:'😀'.repeat(100),overall:''});expect(ok.status).toBe(200);
    }
  },60000);

  it('A11 高分比例 >50%（3/4）不再要求额外整体说明', async () => {
    // 前三份都是高分（各自理由/整体说明达标）
    expect((await draftAndSubmit(a11Rows[0].review_id, a11ReviewerId, { score: 92 })).status).toBe(200);
    expect((await draftAndSubmit(a11Rows[1].review_id, a11ReviewerId, { score: 91 })).status).toBe(200);
    expect((await draftAndSubmit(a11Rows[2].review_id, a11ReviewerId, { score: 90 })).status).toBe(200);

    // 第 4 份：综合 80（不含高分线），理由无需按比例填写
    const ok = await draftAndSubmit(a11Rows[3].review_id, a11ReviewerId, {
      score: 80,
      overall: '说'.repeat(30),
    });
    expect(ok.status).toBe(200);
  }, 90000);

  it('B4 同一 Idempotency-Key 重复提交只产生一份有效评分', async () => {
    const row = rest[5];
    const key = `m10-idem-${Date.now()}`;
    const first = await draftAndSubmit(row.review_id, row.reviewer_id, { score: 75, idempotencyKey: key });
    expect(first.status).toBe(200);
    const firstRevision = first.body.data.revisionId;

    // 模拟网络重试：直接重发同一 submit（带同一 Idempotency-Key）；
    // 注意不能先存草稿——已提交的评分不允许再改草稿
    const cookie = await loginAsId(row.reviewer_id);
    const second = await req(
      'POST',
      `/api/v1/reviews/${row.review_id}/submit`,
      {},
      cookie,
      { 'idempotency-key': key },
    );
    expect(second.status).toBe(200);
    expect(second.body.data.revisionId).toBe(firstRevision); // 回放同一结果

    const revs = await db!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM review_revisions WHERE review_id = $1`,
      [row.review_id],
    );
    expect(Number(revs.rows[0].n)).toBe(1);
  }, 60000);

  it('B8 已提交的任务不可替补；未提交的可替补', async () => {
    // rest[1] 已在 A09 提交成功
    const blocked = await req(
      'POST',
      `/api/v1/cycles/${cycleId}/assignments/${rest[1].assignment_id}/replace`,
      { reason: '尝试替换已提交任务' },
      adminCookie,
    );
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('ASSIGNMENT_ALREADY_SUBMITTED');

    // 另找一个未提交的 ACTIVE 任务
    const free = await db!.query<{ id: string }>(
      `SELECT a.id FROM assignments a
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.assignment_id = a.id AND r.status = 'SUBMITTED')
        LIMIT 1`,
      [cycleId],
    );
    expect(free.rowCount).toBe(1);
    const ok = await req(
      'POST',
      `/api/v1/cycles/${cycleId}/assignments/${free.rows[0].id}/replace`,
      { reason: '正常替补' },
      adminCookie,
    );
    expect(ok.status).toBe(200);
  }, 60000);

  it('A14 他评未齐时不得构建结果', async () => {
    // 找一个仍有未提交他评的 target
    const t = await db!.query<{ target_id: string }>(
      `SELECT a.target_id FROM assignments a
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.assignment_id = a.id AND r.status = 'SUBMITTED')
        LIMIT 1`,
      [cycleId],
    );
    expect(t.rowCount).toBe(1);
    const build = await req(
      'POST',
      `/api/v1/cycles/${cycleId}/results/build`,
      { targetId: t.rows[0].target_id },
      supervisorCookie,
    );
    expect(build.status).toBe(400);
    expect(build.body.code).toBe('RESULT_INCOMPLETE');
  }, 60000);

  it('B3 评价截止后不可提交（草稿仍可保存）', async () => {
    const row = rest[6];
    const cookie = await loginAsId(row.reviewer_id);
    const detail = await req('GET', `/api/v1/reviews/${row.review_id}`, undefined, cookie);
    const items: Array<{ id: string }> = detail.body.data.template.items;

    // 把周期整体平移到过去（须满足 open_at < close_at <= publish_at 约束）
    await db!.query(
      `UPDATE cycles SET open_at = now() - interval '3 hours', close_at = now() - interval '1 hour' WHERE id = $1`,
      [cycleId],
    );
    try {
      const save = await req('PUT', `/api/v1/reviews/${row.review_id}/draft`, {
        items: items.map((it) => ({ itemId: it.id, score: 80, reason: ITEM_REASON_OK })),
        overallReason: OVERALL_STATEMENT_OK,
        readConfirmed: true,
      }, cookie);
      expect(save.status).toBe(200); // 草稿仍可保存

      const submit = await req('POST', `/api/v1/reviews/${row.review_id}/submit`, {}, cookie);
      expect(submit.status).toBe(400);
      expect(submit.body.code).toBe('REVIEW_PERIOD_CLOSED');
    } finally {
      await db!.query(`UPDATE cycles SET close_at = now() + interval '1 day' WHERE id = $1`, [cycleId]);
      await db!.query(`UPDATE cycles SET open_at = now() - interval '60 seconds' WHERE id = $1`, [cycleId]);
    }
  }, 60000);

  it('缺监管时阻止正式开期并列出缺项', async () => {
    const rs = await db!.query<{ id: string }>(`SELECT id FROM rulesets WHERE status = 'FROZEN' LIMIT 1`);
    const c = await req('POST', '/api/v1/cycles', {
      month: PREREQ_MONTH,
      title: 'M10 prerequisite test',
      open_at: new Date(Date.now() - 60_000).toISOString(),
      close_at: new Date(Date.now() + 86_400_000).toISOString(),
      publish_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      ruleset_id: rs.rows[0].id,
    }, adminCookie);
    expect(c.status).toBe(201);
    const prereqCycleId = c.body.data.id;

    // 先提交（DRAFT → PENDING_OPEN），否则开期会先报 STATE_CONFLICT
    expect((await req('POST', `/api/v1/cycles/${prereqCycleId}/submit`, {}, adminCookie)).status).toBe(200);

    // 临时停用 SUPERVISOR 任命
    const appts = await db!.query<{ id: string }>(
      `UPDATE appointments SET valid_to = current_date - 1
        WHERE org_id = (SELECT org_id FROM cycles WHERE id = $1)
          AND role = 'SUPERVISOR' AND valid_to IS NULL
        RETURNING id`,
      [prereqCycleId],
    );
    revokedAppointmentIds.push(...appts.rows.map((r) => r.id));

    try {
      const open = await req('POST', `/api/v1/cycles/${prereqCycleId}/open`, {}, adminCookie);
      expect(open.status).toBe(400);
      expect(open.body.code).toBe('OPEN_PREREQUISITE_MISSING');
      expect(open.body.missing).toEqual(
        expect.arrayContaining(['SUPERVISOR_NOT_CONFIGURED']),
      );
    } finally {
      // 恢复任命，避免污染共享库
      await db!.query(
        `UPDATE appointments SET valid_to = NULL WHERE id = ANY($1::uuid[])`,
        [revokedAppointmentIds],
      );
      revokedAppointmentIds.length = 0;
    }

    // 恢复后可以正常开期
    const preview = await req('POST', `/api/v1/cycles/${prereqCycleId}/assignment/preview`, {}, adminCookie);
    const ok = await req('POST', `/api/v1/cycles/${prereqCycleId}/open`, {run_id:preview.body.data.id}, adminCookie);
    expect(ok.status).toBe(200);
  }, 60000);
});
