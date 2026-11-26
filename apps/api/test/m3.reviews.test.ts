import '../../../scripts/test-db-setup.cjs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { purgeCycles as purgeCycles } from './helpers/cycle-cleanup';


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

const TEST_MONTH = '2034-01';
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
      console.error('[m3.reviews] 清理失败:', err instanceof Error ? err.message : err);
    });
  }
  if (app) await app.close();
  if (db) await db.end();
});

describe.skipIf(!dbAvailable)('M3 reviewer API', () => {
  let cycleId = '';
  let adminCookie = '';

  it('准备：bootstrap admin 创建并开期 2034-01', async () => {
    adminCookie = await loginAs('示例成员18');
    const rs = await db!.query<{ id: string }>(`SELECT id FROM rulesets WHERE status = 'FROZEN' LIMIT 1`);
    const c = await req('POST', '/api/v1/cycles', {
      month: TEST_MONTH,
      title: 'M3 reviewer test',
      open_at: new Date(Date.now() - 60_000).toISOString(),
      close_at: new Date(Date.now() + 86_400_000).toISOString(),
      publish_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      ruleset_id: rs.rows[0].id,
    }, adminCookie);
    expect(c.status).toBe(201);
    cycleId = c.body.data.id;

    // DRAFT → PENDING_OPEN
    const submitCycle = await req('POST', `/api/v1/cycles/${cycleId}/submit`, {}, adminCookie);
    expect(submitCycle.status).toBe(200);

    const prev = await req('POST', `/api/v1/cycles/${cycleId}/assignment/preview`, {}, adminCookie);
    expect(prev.status).toBe(200);

    const open = await req('POST', `/api/v1/cycles/${cycleId}/open`, { run_id: prev.body.data.id }, adminCookie);
    expect(open.status).toBe(200);
    expect(open.body.data.edge_count).toBeGreaterThan(0);
  });

  it('任务清单：任意 reviewer 能看到自评与他评', async () => {
    const one = await db!.query<{ reviewer_id: string }>(
      `SELECT reviewer_id FROM assignments WHERE cycle_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [cycleId],
    );
    const cookie = await loginAsId(one.rows[0].reviewer_id);
    const tasks = await req('GET', `/api/v1/cycles/${cycleId}/assignments/me`, undefined, cookie);
    expect(tasks.status).toBe(200);
    expect(tasks.body.data.peers.length).toBeGreaterThan(0);
    // 自评 reviewId 可能为 null（首次进入）
    expect(['string', 'object']).toContain(typeof tasks.body.data.self.reviewId);
  });

  it('草稿保存→提交→二次提交拒绝', async () => {
    const one = await db!.query<{ review_id: string; reviewer_id: string }>(
      `SELECT r.id AS review_id, a.reviewer_id FROM assignments a
         JOIN reviews r ON r.assignment_id = a.id AND r.kind = 'PEER'
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE' LIMIT 1`,
      [cycleId],
    );
    const reviewId = one.rows[0].review_id;
    const cookie = await loginAsId(one.rows[0].reviewer_id);
    const { rows: pre } = await db!.query<{ id: string; status: string; reviewer_id: string; org_id: string }>(
      `SELECT id, status, reviewer_id, org_id FROM reviews WHERE id = $1`, [reviewId],
    );
    if (!pre[0]) throw new Error(`review ${reviewId} 不在 db`);
    const detail = await req('GET', `/api/v1/reviews/${reviewId}`, undefined, cookie);
    if (detail.status !== 200) {
      throw new Error(`detail 失败 status=${detail.status} body=${JSON.stringify(detail.body)} db=${JSON.stringify(pre[0])}`);
    }
    expect(detail.status).toBe(200);
    const items: Array<{ id: string }> = detail.body.data.template.items;
    expect(items.length).toBeGreaterThan(0);

    const draftPayload = {
      items: items.map((it) => ({ itemId: it.id, score: 75, reason: 'OK' })),
      overallReason: '整体良好',
      comment: '继续努力',
      nextPlan: '下季重点',
      readConfirmed: true,
    };
    const save = await req('PUT', `/api/v1/reviews/${reviewId}/draft`, draftPayload, cookie);
    expect(save.status).toBe(200);
    expect(save.body.data.rowVersion).toBeGreaterThanOrEqual(1);

    const submit = await req('POST', `/api/v1/reviews/${reviewId}/submit`, {}, cookie);
    expect(submit.status).toBe(200);
    expect(submit.body.data.revisionNo).toBe(1);
    expect(submit.body.data.scoreBp).toBeGreaterThanOrEqual(0);

    const dup = await req('POST', `/api/v1/reviews/${reviewId}/submit`, {}, cookie);
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('REVIEW_ALREADY_SUBMITTED');
  });

  it('非本人 reviewer 访问 review 详情 403', async () => {
    const one = await db!.query<{ reviewer_id: string }>(
      `SELECT reviewer_id FROM assignments WHERE cycle_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [cycleId],
    );
    const other = await db!.query<{ id: string }>(
      `SELECT id FROM users WHERE id <> $1 LIMIT 1`,
      [one.rows[0].reviewer_id],
    );
    const cookie = await loginAsId(other.rows[0].id);
    const review = await db!.query<{ id: string }>(
      `SELECT r.id FROM reviews r
         JOIN assignments a ON a.id = r.assignment_id
        WHERE a.cycle_id = $1 LIMIT 1`,
      [cycleId],
    );
    const detail = await req('GET', `/api/v1/reviews/${review.rows[0].id}`, undefined, cookie);
    expect(detail.status).toBe(403);
    expect(detail.body.code).toBe('NOT_REVIEW_OWNER');
  });

  it('未认证访问任务清单 401', async () => {
    const r = await req('GET', `/api/v1/cycles/${cycleId}/assignments/me`);
    expect(r.status).toBe(401);
  });

  it('自评 endpoint 幂等创建', async () => {
    const cookie = await loginAs('示例成员12');
    const a = await req('POST', `/api/v1/cycles/${cycleId}/self-review`, {}, cookie);
    expect(a.status).toBe(201);
    const b = await req('POST', `/api/v1/cycles/${cycleId}/self-review`, {}, cookie);
    expect(b.status).toBe(201);
    expect(a.body.data.reviewId).toBe(b.body.data.reviewId);
  });

  it('非参评监管账号不可创建自评', async () => {
    const cookie = await loginAs('示例成员50');
    const result = await req('POST', `/api/v1/cycles/${cycleId}/self-review`, {}, cookie);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('NOT_CYCLE_PARTICIPANT');
  });

  it('并发首次创建自评返回同一条记录', async () => {
    const cookie = await loginAs('示例成员02');
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      req('POST', `/api/v1/cycles/${cycleId}/self-review`, {}, cookie)));
    expect(results.map(r => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map(r => r.body.data.reviewId)).size).toBe(1);
  });

  it('截止后不能新建自评，已存在的自评仍可获取', async () => {
    const original = (await db!.query('SELECT close_at FROM cycles WHERE id = $1', [cycleId])).rows[0].close_at;
    try {
      await db!.query("UPDATE cycles SET close_at = now() - interval '1 second' WHERE id = $1", [cycleId]);
      const cookie = await loginAs('示例成员03');
      const result = await req('POST', `/api/v1/cycles/${cycleId}/self-review`, {}, cookie);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('REVIEW_PERIOD_CLOSED');
      const existing = await req('POST', `/api/v1/cycles/${cycleId}/self-review`, {}, await loginAs('示例成员12'));
      expect(existing.status).toBe(201);
    } finally {
      await db!.query('UPDATE cycles SET close_at = $2 WHERE id = $1', [cycleId, original]);
    }
  });

  it('草稿未确认 read_confirmed 提交 400', async () => {
    // 找一条未 SUBMITTED 的 review
    const one = await db!.query<{ id: string; reviewer_id: string; status: string }>(
      `SELECT r.id, r.reviewer_id, r.status FROM reviews r
         JOIN assignments a ON a.id = r.assignment_id
        WHERE a.cycle_id = $1 AND r.status = 'DRAFT' LIMIT 1`,
      [cycleId],
    );
    if (!one.rowCount) {
      // 全员已提交则跳过；用 throw 让 vitest 在 stderr 提示这是 skip
      throw new Error(`草稿未确认测试跳过：cycleId=${cycleId} 无 DRAFT review（可能全员已提交）`);
    }
    const cookie = await loginAsId(one.rows[0].reviewer_id);
    const submit = await req('POST', `/api/v1/reviews/${one.rows[0].id}/submit`, {}, cookie);
    if (submit.status !== 400) {
      throw new Error(`submit 期望 400 实际 ${submit.status} body=${JSON.stringify(submit.body)} one=${JSON.stringify(one.rows[0])}`);
    }
    expect(submit.status).toBe(400);
    expect(submit.body.code).toBe('READ_CONFIRM_REQUIRED');
  });
});
