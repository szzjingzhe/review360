import '../../../scripts/test-db-setup.cjs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { purgeCycles } from './helpers/cycle-cleanup';
import { ITEM_REASON_OK, OVERALL_STATEMENT_OK } from './helpers/review-text';


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

const TEST_MONTH = '2034-03';
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

/** 临时授 calibration.resolve（用于验证服务层利益冲突而非 Guard 拦截） */
async function grantTempResolve(userId: string): Promise<void> {
  await db!.query(
    `INSERT INTO capability_grants (id, org_id, user_id, capability, scope_type, reason)
     VALUES (gen_random_uuid(),
             (SELECT org_id FROM users WHERE id = $1),
             $1, 'calibration.resolve', 'ORG', 'M4 测试临时授权')`,
    [userId],
  );
}

async function revokeTempResolve(): Promise<void> {
  await db!.query(
    `DELETE FROM capability_grants WHERE capability = 'calibration.resolve' AND reason = 'M4 测试临时授权'`,
  );
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
      console.error('[m4.calibration] 清理失败:', err instanceof Error ? err.message : err);
    });
  }
  if (app) await app.close();
  if (db) await db.end();
});

describe.skipIf(!dbAvailable)('M4.2 核验（calibration）API', () => {
  let cycleId = '';
  let adminCookie = '';
  let supervisorCookie = ''; // 示例成员50：calibration.read_raw + calibration.resolve
  /** 高分 review（触发 HIGH_TOTAL）：reviewer / target / reviewId */
  let highReview: { reviewId: string; reviewerId: string; targetId: string } | null = null;
  let highCaseId = '';

  it('准备：开期 2034-03 并提交一份 92 分他评 + 一份含低分指标的他评', async () => {
    adminCookie = await loginAs('示例成员18');
    supervisorCookie = await loginAs('示例成员50');
    const rs = await db!.query<{ id: string }>(`SELECT id FROM rulesets WHERE status = 'FROZEN' LIMIT 1`);
    const c = await req('POST', '/api/v1/cycles', {
      month: TEST_MONTH,
      title: 'M4 calibration test',
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

    // 找两个互不相同的 reviewer 各提交一份
    const assigns = await db!.query<{ reviewer_id: string; review_id: string }>(
      `SELECT a.reviewer_id, r.id AS review_id
         FROM assignments a JOIN reviews r ON r.assignment_id = a.id AND r.kind = 'PEER'
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE' LIMIT 2`,
      [cycleId],
    );
    expect(assigns.rowCount).toBeGreaterThanOrEqual(2);

    async function submitScore(
      reviewId: string,
      reviewerId: string,
      score: number,
      lowFirst?: boolean,
    ) {
      const cookie = await loginAsId(reviewerId);
      const detail = await req('GET', `/api/v1/reviews/${reviewId}`, undefined, cookie);
      expect(detail.status).toBe(200);
      const items: Array<{ id: string }> = detail.body.data.template.items;
      // 92 分属高分：单项理由需 ≥30 字、整体说明需 ≥50 字（PRD §8.3）
      const save = await req('PUT', `/api/v1/reviews/${reviewId}/draft`, {
        items: items.map((it, i) => ({
          itemId: it.id,
          score: lowFirst && i === 0 ? 50 : score,
          reason: ITEM_REASON_OK,
        })),
        overallReason: OVERALL_STATEMENT_OK,
        comment: '继续保持',
        readConfirmed: true,
      }, cookie);
      expect(save.status).toBe(200);
      const submit = await req('POST', `/api/v1/reviews/${reviewId}/submit`, {}, cookie);
      expect(submit.status).toBe(200);
      return submit.body.data.scoreBp;
    }

    const bp1 = await submitScore(assigns.rows[0].review_id, assigns.rows[0].reviewer_id, 92);
    expect(bp1).toBe(9200);
    highReview = {
      reviewId: assigns.rows[0].review_id,
      reviewerId: assigns.rows[0].reviewer_id,
      targetId: '',
    };
    const tgt = await db!.query<{ target_id: string }>(`SELECT target_id FROM reviews WHERE id = $1`, [highReview.reviewId]);
    highReview.targetId = tgt.rows[0].target_id;

    // 第二份：首指标 50 分（触发 LOW_SCORE），其余 72 分
    const bp2 = await submitScore(assigns.rows[1].review_id, assigns.rows[1].reviewer_id, 72, true);
    expect(bp2).toBeGreaterThan(5000);
    expect(bp2).toBeLessThan(7300);
  });

  it('扫描建立核验项：92 分触发 HIGH_TOTAL，幂等重复扫描不新建', async () => {
    const scan = await req('POST', `/api/v1/cycles/${cycleId}/calibration-scan`, {}, supervisorCookie);
    expect(scan.status).toBe(200);
    // Submission now scans the current revision immediately; the explicit scan is idempotent.
    const triggered = await db!.query(`SELECT id FROM calibration_cases WHERE cycle_id=$1 AND reason_code='HIGH_TOTAL'`, [cycleId]);
    expect(triggered.rowCount).toBeGreaterThanOrEqual(1);

    const again = await req('POST', `/api/v1/cycles/${cycleId}/calibration-scan`, {}, supervisorCookie);
    expect(again.status).toBe(200);
    expect(again.body.data.created).toBe(0); // UNIQUE(review_revision_id, reason_code) 幂等
  });

  it('核验列表：需 calibration.read_raw（普通成员 403）；含 HIGH_TOTAL 项与白名单投影', async () => {
    const memberCookie = await loginAs('示例成员01');
    const denied = await req('GET', '/api/v1/calibration-cases?cycle_id=' + cycleId, undefined, memberCookie);
    expect(denied.status).toBe(403);

    const list = await req('GET', `/api/v1/calibration-cases?cycle_id=${cycleId}&status=OPEN`, undefined, supervisorCookie);
    expect(list.status).toBe(200);
    const items = list.body.data;
    expect(items.length).toBeGreaterThanOrEqual(1);
    const high = items.find((c: any) => c.reasonCode === 'HIGH_TOTAL');
    expect(high).toBeDefined();
    expect(high.detail).toContain('92.00');
    expect(high.target.displayName).toBeTruthy();
    expect(high.source.scoreBp).toBe(9200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    highCaseId = high.id;
  });

  it('本人（被评价人）处置自身核验项 403 SELF_CONFLICT', async () => {
    // 临时授予能力，验证的是服务层利益冲突而非 Guard 拦截
    await grantTempResolve(highReview!.targetId);
    const targetCookie = await loginAsId(highReview!.targetId);
    const res = await req('POST', `/api/v1/calibration-cases/${highCaseId}/actions`, {
      action: 'CONFIRM', reason: '自己说了算',
    }, targetCookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_CONFLICT');
    await revokeTempResolve();
  });

  it('原评分作者处置自己的评分 403 AUTHOR_CONFLICT', async () => {
    await grantTempResolve(highReview!.reviewerId);
    const reviewerCookie = await loginAsId(highReview!.reviewerId);
    const res = await req('POST', `/api/v1/calibration-cases/${highCaseId}/actions`, {
      action: 'CONFIRM', reason: '我给自己背书',
    }, reviewerCookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHOR_CONFLICT');
    await revokeTempResolve();
  });

  it('无 calibration.resolve 能力的管理员 403', async () => {
    const res = await req('POST', `/api/v1/calibration-cases/${highCaseId}/actions`, {
      action: 'CONFIRM', reason: '管理员越权处置',
    }, adminCookie);
    expect(res.status).toBe(403);
  });

  it('监管 CONFIRM 关闭核验项；终态后重复操作 409 CASE_FINAL', async () => {
    const confirm = await req('POST', `/api/v1/calibration-cases/${highCaseId}/actions`, {
      action: 'CONFIRM', reason: '理由充分，依据有效',
    }, supervisorCookie);
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.status).toBe('RESOLVED');

    const again = await req('POST', `/api/v1/calibration-cases/${highCaseId}/actions`, {
      action: 'DISMISS', reason: '再关一次',
    }, supervisorCookie);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CASE_FINAL');
  });

  it('作废流程：VOID_REQUEST 后同人批准 403 SAME_APPROVER，第二独立批准人可 RESOLVED', async () => {
    // 新开一条 case：72 分那份首指标 50，应已触发 LOW_SCORE
    const low = await db!.query<{ id: string }>(
      `SELECT cc.id FROM calibration_cases cc WHERE cc.cycle_id = $1 AND cc.reason_code = 'LOW_SCORE' LIMIT 1`,
      [cycleId],
    );
    if (!low.rowCount) {
      throw new Error('LOW_SCORE case 未建立（首指标 50 分应触发）');
    }
    const caseId = low.rows[0].id;

    const req1 = await req('POST', `/api/v1/calibration-cases/${caseId}/actions`, {
      action: 'VOID_REQUEST', reason: '评分依据存疑，申请作废',
    }, supervisorCookie);
    expect(req1.status).toBe(200);
    expect(req1.body.data.status).toBe('OPEN');

    const same = await req('POST', `/api/v1/calibration-cases/${caseId}/actions`, {
      action: 'VOID_APPROVE', reason: '自己批准自己的作废',
    }, supervisorCookie);
    expect(same.status).toBe(403);
    expect(same.body.code).toBe('SAME_APPROVER');

    // 给示例成员18临时授 calibration.resolve 作为第二独立批准人
    await grantTempResolve((await db!.query<{ id: string }>(`SELECT id FROM users WHERE display_name = '示例成员18'`)).rows[0].id);
    const approve = await req('POST', `/api/v1/calibration-cases/${caseId}/actions`, {
      action: 'VOID_APPROVE', reason: '复核同意作废，已安排替补',
    }, adminCookie);
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('RESOLVED');

    await revokeTempResolve();
  });

  it('动作与理由校验：未知动作/空理由 400', async () => {
    const bad1 = await req('POST', `/api/v1/calibration-cases/${highCaseId}/actions`, {
      action: 'DELETE_ALL', reason: 'x',
    }, supervisorCookie);
    expect(bad1.status).toBe(400);
    const bad2 = await req('POST', `/api/v1/calibration-cases/${highCaseId}/actions`, {
      action: 'CONFIRM', reason: '  ',
    }, supervisorCookie);
    expect(bad2.status).toBe(400);
    expect(bad2.body.code).toBe('FIELD_INVALID');
  });

  it('更正修订版：核验建议更正 → 原评价人提交修订版（revision_no+1）→ 核验项结案', async () => {
    // 取一份尚未提交的任务，提交 93 分以触发 HIGH_TOTAL
    const free = await db!.query<{ reviewer_id: string; review_id: string }>(
      `SELECT a.reviewer_id, r.id AS review_id
         FROM assignments a
         JOIN reviews r ON r.assignment_id = a.id AND r.kind = 'PEER'
        WHERE a.cycle_id = $1 AND a.status = 'ACTIVE' AND r.status <> 'SUBMITTED'
        ORDER BY r.id LIMIT 1`,
      [cycleId],
    );
    expect(free.rowCount).toBe(1);
    const reviewId = free.rows[0].review_id;
    const reviewerId = free.rows[0].reviewer_id;

    // 提交 93 分（理由/整体说明需满足 PRD §8.3 的字数门槛）
    const reviewerCookie0 = await loginAsId(reviewerId);
    const d0 = await req('GET', `/api/v1/reviews/${reviewId}`, undefined, reviewerCookie0);
    expect(d0.status).toBe(200);
    const items0: Array<{ id: string }> = d0.body.data.template.items;
    const save0 = await req('PUT', `/api/v1/reviews/${reviewId}/draft`, {
      items: items0.map((it) => ({ itemId: it.id, score: 93, reason: ITEM_REASON_OK })),
      overallReason: OVERALL_STATEMENT_OK,
      readConfirmed: true,
    }, reviewerCookie0);
    expect(save0.status).toBe(200);
    const sub0 = await req('POST', `/api/v1/reviews/${reviewId}/submit`, {}, reviewerCookie0);
    expect(sub0.status).toBe(200);
    expect(sub0.body.data.scoreBp).toBe(9300);

    expect((await req('POST', `/api/v1/cycles/${cycleId}/calibration-scan`, {}, supervisorCookie)).status).toBe(200);

    const caseRow = await db!.query<{ id: string }>(
      `SELECT cc.id FROM calibration_cases cc
         JOIN reviews r ON r.current_revision_id = cc.review_revision_id
        WHERE r.id = $1 AND cc.status = 'OPEN'
        ORDER BY cc.created_at LIMIT 1`,
      [reviewId],
    );
    expect(caseRow.rowCount).toBeGreaterThanOrEqual(1);
    const caseId = caseRow.rows[0].id;

    // 核验方（既非本人、也非原作者）建议更正
    const suggest = await req('POST', `/api/v1/calibration-cases/${caseId}/actions`, {
      action: 'SUGGEST_REVISION', reason: '高分理由未说明超出正常要求的表现，请原评价人更正',
    }, supervisorCookie);
    expect(suggest.status).toBe(200);
    expect(suggest.body.data.status).toBe('OPEN');

    // 已开出独立的修订截止时间（PRD §8.1）
    const due = await db!.query<{ revision_due_at: Date | null }>(
      `SELECT revision_due_at FROM calibration_cases WHERE id = $1`,
      [caseId],
    );
    expect(due.rows[0].revision_due_at).not.toBeNull();

    // 详情暴露修订请求，供前端展示入口
    const reviewerCookie = await loginAsId(reviewerId);
    const detail = await req('GET', `/api/v1/reviews/${reviewId}`, undefined, reviewerCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data.revisionRequest?.caseId).toBe(caseId);
    expect(detail.body.data.revisionRequest?.expired).toBe(false);

    // 已提交后原本不可改草稿；存在修订请求时放开（先改分再提交修订版）
    const items: Array<{ id: string }> = detail.body.data.template.items;
    const incomplete=await req('PUT', `/api/v1/reviews/${reviewId}/draft`,{
      items:items.map(it=>({itemId:it.id,score:80,reason:'字'.repeat(99)})),readConfirmed:true,
    },reviewerCookie);
    expect(incomplete.status).toBe(200);
    const rejected=await req('POST', `/api/v1/reviews/${reviewId}/revision`,{},reviewerCookie);
    expect(rejected.status).toBe(400);expect(rejected.body.violations[0]).toMatchObject({requiredChars:100,actualChars:99});
    const unchanged=await req('GET', `/api/v1/reviews/${reviewId}`,undefined,reviewerCookie);
    expect(unchanged.body.data.latestRevision.revisionNo).toBe(1);
    const save = await req('PUT', `/api/v1/reviews/${reviewId}/draft`, {
      items: items.map((it) => ({ itemId: it.id, score: 70, reason: '按核验意见更正，实际表现未达高分要求' })),
      overallReason: '按核验意见更正说明：实际交付质量与协作表现均属正常水平，未达到超出正常要求的标准。',
      readConfirmed: true,
    }, reviewerCookie);
    expect(save.status).toBe(200);

    // 修订窗口过期 → 拒绝
    await db!.query(
      `UPDATE calibration_cases SET revision_due_at = now() - interval '1 hour' WHERE id = $1`,
      [caseId],
    );
    const expired = await req('POST', `/api/v1/reviews/${reviewId}/revision`, {}, reviewerCookie);
    expect(expired.status).toBe(400);
    expect(expired.body.code).toBe('REVISION_WINDOW_CLOSED');
    await db!.query(
      `UPDATE calibration_cases SET revision_due_at = now() + interval '48 hours' WHERE id = $1`,
      [caseId],
    );

    // 正式提交修订版
    const rev = await req('POST', `/api/v1/reviews/${reviewId}/revision`, {}, reviewerCookie);
    expect(rev.status).toBe(200);
    expect(rev.body.data.revisionNo).toBe(2);
    expect(rev.body.data.scoreBp).toBe(7000);

    // 版本留痕：两条修订版，当前指向新版
    const revs = await db!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM review_revisions WHERE review_id = $1`,
      [reviewId],
    );
    expect(Number(revs.rows[0].n)).toBe(2);
    const cur = await db!.query<{ revision_no: number }>(
      `SELECT rv.revision_no FROM reviews r
         JOIN review_revisions rv ON rv.id = r.current_revision_id
        WHERE r.id = $1`,
      [reviewId],
    );
    expect(cur.rows[0].revision_no).toBe(2);

    // 核验项结案，动作与审计留痕
    const closed = await db!.query<{ status: string }>(
      `SELECT status FROM calibration_cases WHERE id = $1`,
      [caseId],
    );
    expect(closed.rows[0].status).toBe('RESOLVED');
    const acts = await db!.query<{ action: string }>(
      `SELECT action FROM calibration_actions WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [caseId],
    );
    expect(acts.rows[0].action).toBe('REVISION_SUBMITTED');
    const audit = await db!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'review.revise' AND resource_id = $1`,
      [reviewId],
    );
    expect(Number(audit.rows[0].n)).toBe(1);

    // 无修订请求时不可再提交修订版
    const again = await req('POST', `/api/v1/reviews/${reviewId}/revision`, {}, reviewerCookie);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('REVISION_NOT_REQUESTED');
  });
});
