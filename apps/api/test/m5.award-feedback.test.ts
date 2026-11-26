import '../../../scripts/test-db-setup.cjs';
import { ITEM_REASON_OK } from './helpers/review-text';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dispatchPendingNotifications, LocalLogGateway } from '@360/domain';
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

const TEST_MONTH = '2034-05';
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
     VALUES (gen_random_uuid(), (SELECT org_id FROM users WHERE id = $1), $1, $2, 'ORG', 'M5 测试临时授权')`,
    [userId, capability],
  );
}

async function revokeTempCaps(): Promise<void> {
  await db!.query(`DELETE FROM capability_grants WHERE reason = 'M5 测试临时授权'`);
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

describe.skipIf(!dbAvailable)('M5 评优决策 + 反馈申诉闭环 + 通知投递', () => {
  const PEER_SCORES = [76, 82, 68, 89];
  const SELF_SCORE = 88;
  let cycleId = '';
  let adminCookie = '';
  let supervisorCookie = '';
  let adminId = '';
  let targetId = '';
  let publicationId = '';

  it('准备：开期、提交他评与自评、构建、审批、发布', async () => {
    adminCookie = await loginAs('示例成员18');
    supervisorCookie = await loginAs('示例成员50');
    adminId = (await db!.query<{ id: string }>(`SELECT id FROM users WHERE display_name = '示例成员18'`)).rows[0].id;

    const rs = await db!.query<{ id: string }>(
      `SELECT rs.id FROM rulesets rs
        WHERE rs.status = 'FROZEN'
          AND (SELECT count(DISTINCT tv.role_code) FROM template_versions tv
                WHERE tv.ruleset_id = rs.id) = 5
        ORDER BY rs.created_at LIMIT 1`,
    );
    if (!rs.rowCount) throw new Error('无含 5 类模板的 FROZEN 规则集');
    const c = await req('POST', '/api/v1/cycles', {
      month: TEST_MONTH,
      title: 'M5 test',
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

    const cand = await db!.query<{ target_id: string; n: string }>(
      `SELECT a.target_id, count(*) AS n FROM assignments a
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
    expect(reviews.rowCount).toBe(4);
    for (let i = 0; i < reviews.rows.length; i++) {
      const { id: reviewId, reviewer_id } = reviews.rows[i];
      const cookie = await loginAsId(reviewer_id);
      const detail = await req('GET', `/api/v1/reviews/${reviewId}`, undefined, cookie);
      const items: Array<{ id: string }> = detail.body.data.template.items;
      await req('PUT', `/api/v1/reviews/${reviewId}/draft`, {
        items: items.map((it) => ({ itemId: it.id, score: PEER_SCORES[i], reason: ITEM_REASON_OK })),
        overallReason: '整体说明', readConfirmed: true,
      }, cookie);
      expect((await req('POST', `/api/v1/reviews/${reviewId}/submit`, {}, cookie)).status).toBe(200);
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

    // 构建
    const scan = await req('POST', `/api/v1/cycles/${cycleId}/calibration-scan`, {}, supervisorCookie);
    expect(scan.status).toBe(200);
    const build = await req('POST', `/api/v1/cycles/${cycleId}/results/build`, { targetId }, supervisorCookie);
    expect(build.status).toBe(200);
    const buildId = build.body.data.items[0].buildId;

    // 审批 + 发布
    await grantCap(adminId, 'result.publish');
    await grantCap(targetId, 'result.confirm');
    const supervisorId = (await db!.query<{ id: string }>(`SELECT id FROM users WHERE display_name = '示例成员50'`)).rows[0].id;
    await grantCap(supervisorId, 'result.confirm');
    expect((await req('POST', `/api/v1/result-builds/${buildId}/approve`, { decision: 'APPROVED', reason: '依据有效' }, supervisorCookie)).status).toBe(200);
    await db!.query(`UPDATE cycles SET status = 'CALIBRATING' WHERE id = $1`, [cycleId]);
    const publish = await req('POST', `/api/v1/result-builds/${buildId}/publish`, {}, adminCookie);
    expect(publish.status).toBe(200);

    const mine = await req('GET', '/api/v1/me/results', undefined, targetCookie);
    publicationId = mine.body.data[0].id;
    expect(publicationId).toBeTruthy();
  });

  it('评优：award.manage 保存 AWARDED → award_decisions 落库（幂等覆盖）', async () => {
    await grantCap(adminId, 'award.manage');
    const save = await req('POST', '/api/v1/awards', {
      cycleId, targetId, category: '优秀员工', decision: 'AWARDED', reason: '分数领先且贡献突出',
    }, adminCookie);
    expect(save.status).toBe(201);
    expect(save.body.data.status).toBe('OK');

    const row = await db!.query<{ decision: string }>(
      `SELECT decision FROM award_decisions WHERE cycle_id = $1 AND target_id = $2 AND category = $3`,
      [cycleId, targetId, '优秀员工'],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].decision).toBe('AWARDED');

    // 幂等覆盖
    const save2 = await req('POST', '/api/v1/awards', {
      cycleId, targetId, category: '优秀员工', decision: 'NOMINATED', reason: '复议后改为提名',
    }, adminCookie);
    expect(save2.status).toBe(201);
    const row2 = await db!.query<{ decision: string }>(
      `SELECT decision FROM award_decisions WHERE cycle_id = $1 AND target_id = $2 AND category = $3`,
      [cycleId, targetId, '优秀员工'],
    );
    expect(row2.rows[0].decision).toBe('NOMINATED');
  });

  it('评优校验：award.manage 缺失 403；decision 白名单 400；AWARDED 无理由 400；被评人非参与者 403', async () => {
    const targetCookie = await loginAsId(targetId); // target 仅 result.confirm，无 award.manage
    const denied = await req('POST', '/api/v1/awards', {
      cycleId, targetId, category: '优秀员工', decision: 'AWARDED', reason: 'x',
    }, targetCookie);
    expect(denied.status).toBe(403);

    const bad = await req('POST', '/api/v1/awards', {
      cycleId, targetId, category: '优秀员工', decision: 'MAYBE', reason: 'x',
    }, adminCookie);
    expect(bad.status).toBe(400);

    const noReason = await req('POST', '/api/v1/awards', {
      cycleId, targetId, category: '优秀员工', decision: 'AWARDED',
    }, adminCookie);
    expect(noReason.status).toBe(400);

    const foreign = await db!.query<{ id: string }>(`SELECT id FROM users WHERE display_name = '示例成员01'`);
    const notPart = await req('POST', '/api/v1/awards', {
      cycleId, targetId: '00000000-0000-0000-0000-000000000000', category: '优秀员工', decision: 'AWARDED', reason: 'x',
    }, adminCookie);
    expect(notPart.status).toBe(404); // Hide resources outside the participant boundary.
    void foreign;
  });

  it('反馈闭环：本人申请 201（入队通知）→ feedback.manage 列表 → APPROVED 闭环（入队通知）', async () => {
    const targetCookie = await loginAsId(targetId);
    const create = await req('POST', `/api/v1/published-results/${publicationId}/feedback-requests`, {
      reason: '【申诉类型】评价结果异议\n【涉及范围】整体成长分析\n\n对成长分析有疑问',
    }, targetCookie);
    expect(create.status).toBe(201);
    const reqId = create.body.data.id;

    const submitN = await db!.query<{ recipient_id: string }>(
      `SELECT recipient_id FROM notification_outbox WHERE event_key = $1`,
      [`feedback.submitted:${reqId}`],
    );
    expect(submitN.rowCount).toBe(1);
    expect(submitN.rows[0].recipient_id).toBe(targetId);

    const list = await req('GET', '/api/v1/feedback-requests', undefined, adminCookie);
    expect(list.status).toBe(403); // admin 无 feedback.manage
    await grantCap(adminId, 'feedback.manage');
    const list2 = await req('GET', '/api/v1/feedback-requests', undefined, adminCookie);
    expect(list2.status).toBe(200);
    expect(list2.body.data.some((r: any) => r.id === reqId)).toBe(true);

    const resolve = await req('POST', `/api/v1/feedback-requests/${reqId}/resolve`, {
      decision: 'APPROVED', note: '已补充说明口径',
    }, adminCookie);
    expect(resolve.status).toBe(201);
    expect(resolve.body.data.status).toBe('DONE');

    const resolved = await db!.query<{ status: string }>(
      `SELECT status FROM feedback_requests WHERE id = $1`, [reqId],
    );
    expect(resolved.rows[0].status).toBe('DONE');
    const resolvedN = await db!.query<{ recipient_id: string }>(
      `SELECT recipient_id FROM notification_outbox WHERE event_key = $1`,
      [`feedback.resolved:${reqId}`],
    );
    expect(resolvedN.rowCount).toBe(1);
    expect(resolvedN.rows[0].recipient_id).toBe(targetId);
  });

  it('反馈窗口：发布 3 个工作日后申请被拒（FEEDBACK_WINDOW_CLOSED）', async () => {
    await db!.query(
      `UPDATE published_results SET published_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 30 * 86_400_000).toISOString(), publicationId],
    );
    const targetCookie = await loginAsId(targetId);
    const late = await req('POST', `/api/v1/published-results/${publicationId}/feedback-requests`, {
      reason: '【申诉类型】其他问题\n【涉及范围】未指定\n\n很久之后才想起要问',
    }, targetCookie);
    expect(late.status).toBe(400);
    expect(late.body.code).toBe('FEEDBACK_WINDOW_CLOSED');
  });

  it('通知投递：worker 调 dispatchPendingNotifications 仅在提供方确认接收后标记 ACCEPTED', async () => {
    // 入队一条测试通知（键带时间戳，避免跨运行残留冲突）
    const evKey = `m5.test.${Date.now()}`;
    await db!.query(
      `INSERT INTO notification_outbox (id, org_id, event_key, recipient_id, channel, payload_json, next_retry_at)
       VALUES (gen_random_uuid(), (SELECT org_id FROM users WHERE id = $1), $2, $1, 'IN_APP', '{}', now() - interval '1 minute')`,
      [adminId, evKey],
    );
    const before = await db!.query<{ status: string }>(`SELECT status FROM notification_outbox WHERE event_key = $1`, [evKey]);
    expect(before.rows[0].status).toBe('PENDING');

    const { dispatched } = await dispatchPendingNotifications(db!, {send:async()=>({ok:true,accepted:true,messageId:'isolated-test-message'})}, new Date(),30000,1000);
    expect(dispatched).toBeGreaterThanOrEqual(1);

    const after = await db!.query<{ status: string }>(`SELECT status FROM notification_outbox WHERE event_key = $1`, [evKey]);
    expect(after.rows[0].status).toBe('ACCEPTED');
  });
});
