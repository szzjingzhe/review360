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

const TEST_MONTH = '2034-04';
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
     VALUES (gen_random_uuid(), (SELECT org_id FROM users WHERE id = $1), $1, $2, 'ORG', 'M4 测试临时授权')`,
    [userId, capability],
  );
}

async function revokeTempCaps(): Promise<void> {
  await db!.query(`DELETE FROM capability_grants WHERE reason = 'M4 测试临时授权'`);
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
    await purgeCycles(db, OWNED_MONTHS).catch((err) => {
      console.error('[m4.results] 清理失败:', err instanceof Error ? err.message : err);
    });
  }
  if (app) await app.close();
  if (db) await db.end();
});

describe.skipIf(!dbAvailable)('M4.3/M4.4 结果构建-审批-发布链路', () => {
  let cycleId = '';
  let adminCookie = '';
  let supervisorCookie = '';
  let adminId = '';
  let targetId = '';
  let buildId = '';

  /** 76/82/68/89 四份他评 + 自评 88 */
  const PEER_SCORES = [76, 82, 68, 89];
  const SELF_SCORE = 88;

  it('准备：开期、选定 target、提交其全部他评与自评', async () => {
    adminCookie = await loginAs('示例成员18');
    supervisorCookie = await loginAs('示例成员50');
    adminId = (await db!.query<{ id: string }>(`SELECT id FROM users WHERE display_name = '示例成员18'`)).rows[0].id;

    // 必须选含当前全部 5 类模板（含 SELF/UPWARD）的 FROZEN 规则集；
    // 库里还有 M2 测试冻结的旧副本（复制时 seed 尚无 SELF/UPWARD）
    const rs = await db!.query<{ id: string }>(
      `SELECT rs.id FROM rulesets rs
        WHERE rs.status = 'FROZEN'
          AND (SELECT count(DISTINCT tv.role_code) FROM template_versions tv
                WHERE tv.ruleset_id = rs.id) = 5
        ORDER BY rs.created_at LIMIT 1`,
    );
    if (!rs.rowCount) throw new Error('无含 5 类模板的 FROZEN 规则集（请先重跑 seed）');
    const c = await req('POST', '/api/v1/cycles', {
      month: TEST_MONTH,
      title: 'M4 results test',
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

    // 选一个不是 admin 的 target，且其评价人数量 == PEER_SCORES 长度（4 或 5 均可）
    const cand = await db!.query<{ target_id: string; n: string }>(
      `SELECT a.target_id, count(*) AS n FROM assignments a
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE' AND a.target_id <> $2
        GROUP BY a.target_id HAVING count(*) = 4 LIMIT 1`,
      [cycleId, adminId],
    );
    if (!cand.rowCount) {
      throw new Error('无入度=4 的 target（fixture 与分配器约定不符）');
    }
    targetId = cand.rows[0].target_id;

    // 提交该 target 的全部他评
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
      expect(detail.status).toBe(200);
      const items: Array<{ id: string }> = detail.body.data.template.items;
      const save = await req('PUT', `/api/v1/reviews/${reviewId}/draft`, {
        items: items.map((it) => ({ itemId: it.id, score: PEER_SCORES[i], reason: ITEM_REASON_OK })),
        overallReason: '整体说明',
        readConfirmed: true,
      }, cookie);
      expect(save.status).toBe(200);
      const submit = await req('POST', `/api/v1/reviews/${reviewId}/submit`, {}, cookie);
      expect(submit.status).toBe(200);
    }

    // 自评
    const targetCookie = await loginAsId(targetId);
    const self = await req('POST', `/api/v1/cycles/${cycleId}/self-review`, {}, targetCookie);
    expect(self.status).toBe(201);
    const selfDetail = await req('GET', `/api/v1/reviews/${self.body.data.reviewId}`, undefined, targetCookie);
    if (selfDetail.status !== 200) {
      throw new Error(`selfDetail ${selfDetail.status}: ${JSON.stringify(selfDetail.body)} reviewId=${self.body.data.reviewId}`);
    }
    const selfItems: Array<{ id: string }> = selfDetail.body.data.template.items;
    const selfSave = await req('PUT', `/api/v1/reviews/${self.body.data.reviewId}/draft`, {
      items: selfItems.map((it) => ({ itemId: it.id, score: SELF_SCORE, reason: ITEM_REASON_OK })),
      overallReason: '自评说明',
      nextPlan: '下季重点',
      readConfirmed: true,
    }, targetCookie);
    expect(selfSave.status).toBe(200);
    const selfSubmit = await req('POST', `/api/v1/reviews/${self.body.data.reviewId}/submit`, {}, targetCookie);
    expect(selfSubmit.status).toBe(200);
  });

  it('扫描无未决核验项后构建：最终分 = 有效他评平均 78.75；自评88单列', async () => {
    const scan = await req('POST', `/api/v1/cycles/${cycleId}/calibration-scan`, {}, supervisorCookie);
    expect(scan.status).toBe(200);
    if (scan.body.data.created !== 0) {
      const cases = await db!.query(
        `SELECT cc.reason_code, rr.score_bp FROM calibration_cases cc
           JOIN review_revisions rr ON rr.id = cc.review_revision_id WHERE cc.cycle_id = $1`,
        [cycleId],
      );
      throw new Error(`意外建立核验项: ${JSON.stringify(cases.rows)} scan=${JSON.stringify(scan.body.data)}`);
    }

    const build = await req('POST', `/api/v1/cycles/${cycleId}/results/build`, { targetId }, supervisorCookie);
    expect(build.status).toBe(200);
    expect(build.body.data.items).toHaveLength(1);
    const item = build.body.data.items[0];
    expect(item.status).toBe('BUILT');
    expect(item.exactScore).toBe(78.75);
    expect(item.selfScore).toBe(88);
    expect(item.warnings).toEqual([]);
    buildId = item.buildId;
  });

  it('重复构建同输入 REUSED（input_hash 唯一约束）', async () => {
    const again = await req('POST', `/api/v1/cycles/${cycleId}/results/build`, { targetId }, supervisorCookie);
    expect(again.status).toBe(200);
    expect(again.body.data.items[0].status).toBe('REUSED');
    expect(again.body.data.items[0].buildId).toBe(buildId);
  });

  it('审批列表包含页面需要的周期、姓名和评分维度', async () => {
    const result = await req('GET', `/api/v1/cycles/${cycleId}/result-builds`, undefined, supervisorCookie);
    expect(result.status).toBe(200);
    const build = result.body.data.find((row: any) => row.id === buildId);
    expect(build.cycle_id).toBe(cycleId);
    expect(build.target_name).toBeTruthy();
    expect(build.dimension_json.peerItems.length).toBeGreaterThan(0);
    expect(build.dimension_json.peerCount).toBe(4);
    expect(build.dimension_json.selfPresent).toBe(true);
  });

  it('未审批先发布 409 APPROVAL_REQUIRED；本人审批 403 SELF_AUDIT_FORBIDDEN', async () => {
    await grantCap(adminId, 'result.publish');
    await grantCap(targetId, 'result.confirm');

    const early = await req('POST', `/api/v1/result-builds/${buildId}/publish`, {}, adminCookie);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('APPROVAL_REQUIRED');

    const targetCookie = await loginAsId(targetId);
    const selfApprove = await req('POST', `/api/v1/result-builds/${buildId}/approve`, {
      decision: 'APPROVED', reason: '自己确认自己',
    }, targetCookie);
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.code).toBe('SELF_AUDIT_FORBIDDEN');
  });

  it('监管审批 APPROVED → 发布 v1 → outbox 落库 → 周期 PARTIALLY_PUBLISHED', async () => {
    // 监管已有 calibration.resolve；审批另需 result.confirm
    const supervisorId = (await db!.query<{ id: string }>(`SELECT id FROM users WHERE display_name = '示例成员50'`)).rows[0].id;
    await grantCap(supervisorId, 'result.confirm');

    const approve = await req('POST', `/api/v1/result-builds/${buildId}/approve`, {
      decision: 'APPROVED', reason: '来源完整，依据有效',
    }, supervisorCookie);
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('APPROVED');

    // 模拟 CLOSE 相位已过：周期进入 CALIBRATING
    await db!.query(`UPDATE cycles SET status = 'CALIBRATING' WHERE id = $1`, [cycleId]);

    const publish = await req('POST', `/api/v1/result-builds/${buildId}/publish`, {}, adminCookie);
    expect(publish.status).toBe(200);
    expect(publish.body.data.publicationVersion).toBe(1);
    expect(Number(publish.body.data.exactScore)).toBe(78.75);

    const outbox = await db!.query<{ recipient_id: string; status: string }>(
      `SELECT recipient_id, status FROM notification_outbox
        WHERE event_key = $1 AND channel = 'IN_APP'`,
      [`result.published:${cycleId}:${targetId}:v1`],
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].recipient_id).toBe(targetId);

    const cyc = await db!.query<{ status: string }>(`SELECT status FROM cycles WHERE id = $1`, [cycleId]);
    expect(cyc.rows[0].status).toBe('PARTIALLY_PUBLISHED');
  });

  it('已发布 build 再发布 409 ALREADY_PUBLISHED', async () => {
    const again = await req('POST', `/api/v1/result-builds/${buildId}/publish`, {}, adminCookie);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_PUBLISHED');
  });

  it('本人结果只读匿名投影：无 review_id/reviewer_id/source_type/精确提交时间', async () => {
    const targetCookie = await loginAsId(targetId);
    const mine = await req('GET', '/api/v1/me/results', undefined, targetCookie);
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBe(1);
    const pub = mine.body.data[0];
    expect(pub.payload_json.final_score).toBe(78.75);
    expect(pub.payload_json.peer_count).toBe(4);
    expect(pub.payload_json.self_present).toBe(true);
    // 匿名性：payload 序列化后不含来源身份字段
    const raw = JSON.stringify(pub);
    expect(raw).not.toContain('review_id');
    expect(raw).not.toContain('reviewer_id');
    expect(raw).not.toContain('source_type');
    expect(pub.payload_json.peer_items.length).toBeGreaterThan(0);
    expect(pub.payload_json.peer_items[0].label).toBeTruthy();
    expect(pub.cycle_id).toBe(cycleId);
    expect(pub.display_metadata.cycle.id).toBe(cycleId);
    expect(pub.display_metadata.peerItems).toHaveLength(pub.payload_json.peer_items.length);
    expect(pub.display_metadata.peerItems.every((item:any)=>item&&typeof item.weight==='number'&&typeof item.key==='string'&&typeof item.position==='number')).toBe(true);
    expect(pub.display_metadata.selfItems).toHaveLength(pub.payload_json.self_items.length);
    expect(raw).not.toContain('dimension_json');expect(raw).not.toContain('revisionId');expect(raw).not.toContain('input_hash');

  });

  it('他人 /me/results 看不到该发布结果（本人隔离）', async () => {
    const otherCookie = await loginAs('示例成员01');
    const mine = await req('GET', '/api/v1/me/results', undefined, otherCookie);
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBe(0);
  });

  it('反馈申请：本人 201，重复 409；他人 403', async () => {
    const targetCookie = await loginAsId(targetId);
    const pubs = await req('GET', '/api/v1/me/results', undefined, targetCookie);
    const publicationId = pubs.body.data[0].id;

    const create = await req('POST', `/api/v1/published-results/${publicationId}/feedback-requests`, {
      reason: '【申诉类型】其他问题\n【涉及范围】未指定\n\n对指标汇总有疑问，希望补充说明',
    }, targetCookie);
    expect(create.status).toBe(201);

    const dup = await req('POST', `/api/v1/published-results/${publicationId}/feedback-requests`, {
      reason: '【申诉类型】其他问题\n【涉及范围】未指定\n\n再问一次',
    }, targetCookie);
    expect(dup.status).toBe(409);

    const otherCookie = await loginAs('示例成员01');
    const foreign = await req('POST', `/api/v1/published-results/${publicationId}/feedback-requests`, {
      reason: '【申诉类型】其他问题\n【涉及范围】未指定\n\n别人的结果我也要反馈',
    }, otherCookie);
    expect(foreign.status).toBe(403);
  });

  it('评优候选：需 award.manage（无能力 403），有能力可见已发布结果按分数排序', async () => {
    const denied = await req('GET', `/api/v1/cycles/${cycleId}/award-candidates`, undefined, adminCookie);
    expect(denied.status).toBe(403);

    await grantCap(adminId, 'award.manage');
    const list = await req('GET', `/api/v1/cycles/${cycleId}/award-candidates`, undefined, adminCookie);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(1);
    expect(Number(list.body.data[0].final_score)).toBe(78.75);
    expect(list.body.data[0].target_name).toBeTruthy();
  });

  it('审批输入校验：decision 白名单、驳回必须给理由', async () => {
    await grantCap(adminId, 'result.confirm');
    const bad = await req('POST', `/api/v1/result-builds/${buildId}/approve`, {
      decision: 'MAYBE',
    }, adminCookie);
    expect(bad.status).toBe(400);

    const noReason = await req('POST', `/api/v1/result-builds/${buildId}/approve`, {
      decision: 'REJECTED',
    }, adminCookie);
    expect(noReason.status).toBe(400);
  });
});
