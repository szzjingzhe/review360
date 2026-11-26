import '../../../scripts/test-db-setup.cjs';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { purgeCycles } from '../../api/test/helpers/cycle-cleanup';

// 测试用 .env（位于仓库根目录）

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
let cycleId = '';
const TEST_MONTH = '2033-01';
const PUBLISH_MONTH = '2033-02';
const FUTURE_MONTH = '2033-03';

const OWNED_MONTHS = [`${TEST_MONTH}-01`, `${PUBLISH_MONTH}-01`, `${FUTURE_MONTH}-01`];

beforeAll(async () => {
  if (!dbAvailable) return;
  db = new Pool({ connectionString: DB_URL });
  // 前置清理：上次运行若被中断，残留的同月周期会命中 uq_cycle_month
  // （cycle_phases / cycle_locks / cycle_state_log 对 cycles 是 ON DELETE CASCADE）
  await purgeCycles(db, OWNED_MONTHS);
  // 直接造一个 REVIEWING 周期（绕过 API，聚焦 worker 行为）
  const { rows: orgs } = await db.query<{ id: string }>(`SELECT id FROM organizations LIMIT 1`);
  const { rows: rs } = await db.query<{ id: string }>(`SELECT id FROM rulesets WHERE status = 'FROZEN' LIMIT 1`);
  const orgId = orgs[0].id;
  const rulesetId = rs[0].id;
  // 用 2033-01-01 月份，避开已有 UNIQUE
  const ins = await db.query<{ id: string }>(
    `INSERT INTO cycles (id, org_id, month, title, status, open_at, close_at, publish_at, ruleset_id)
     VALUES (gen_random_uuid(), $1, $2, 'worker-test', 'REVIEWING', now() - interval '2 days', now() - interval '1 hour', now() - interval '30 minutes', $3)
     RETURNING id`,
    [orgId, `${TEST_MONTH}-01`, rulesetId],
  );
  cycleId = ins.rows[0].id;
  // 写一个已到期的 CLOSE phase（planned_at 1 小时前）
  await db.query(
    `INSERT INTO cycle_phases (cycle_id, phase, planned_at) VALUES ($1, 'CLOSE', now() - interval '1 hour')`,
    [cycleId],
  );
});

afterAll(async () => {
  if (db) {
    if (cycleId) {
      await db.query(`DELETE FROM cycle_state_log WHERE cycle_id = $1`, [cycleId]);
      await db.query(`DELETE FROM cycle_phases WHERE cycle_id = $1`, [cycleId]);
      await db.query(`DELETE FROM cycles WHERE id = $1`, [cycleId]);
    }
    await db.end();
  }
});

describe.skipIf(!dbAvailable)('worker: CLOSE phase', () => {
  it('到点关闭：REVIEWING → CALIBRATING，写状态日志并标记 actual_at', async () => {
    const { executePhase } = await import('../src/phases/handlers.js');
    const outcome = await executePhase('CLOSE', cycleId, new Date(Date.now() - 3600_000));
    expect(outcome.kind).toBe('EXECUTED');
    if (outcome.kind === 'EXECUTED') {
      expect(outcome.fromStatus).toBe('REVIEWING');
      expect(outcome.toStatus).toBe('CALIBRATING');
    }
    if (db) {
      const cyc = await db.query<{ status: string }>(`SELECT status FROM cycles WHERE id = $1`, [cycleId]);
      expect(cyc.rows[0].status).toBe('CALIBRATING');
      const log = await db.query<{ from_status: string; to_status: string; reason: string }>(
        `SELECT from_status, to_status, reason FROM cycle_state_log WHERE cycle_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [cycleId],
      );
      expect(log.rows[0]).toMatchObject({ from_status: 'REVIEWING', to_status: 'CALIBRATING' });
      expect(log.rows[0].reason).toMatch(/worker/);
      const ph = await db.query<{ actual_at: Date | null }>(
        `SELECT actual_at FROM cycle_phases WHERE cycle_id = $1 AND phase = 'CLOSE'`,
        [cycleId],
      );
      expect(ph.rows[0].actual_at).not.toBeNull();
    }
  });

  it('幂等：再次执行返回 ALREADY，不重复转换状态', async () => {
    const { executePhase } = await import('../src/phases/handlers.js');
    const outcome = await executePhase('CLOSE', cycleId, new Date());
    expect(outcome.kind).toBe('ALREADY');
    if (db) {
      const cyc = await db.query<{ status: string }>(`SELECT status FROM cycles WHERE id = $1`, [cycleId]);
      expect(cyc.rows[0].status).toBe('CALIBRATING');
    }
  });
});

describe.skipIf(!dbAvailable)('worker: PUBLISH phase', () => {
  let publishCycleId = '';
  let emptyCycleId = '';
  let targetId = '';
  beforeAll(async () => {
    if (!db) return;
    const { rows: orgs } = await db.query<{ id: string }>(`SELECT id FROM organizations LIMIT 1`);
    const { rows: rs } = await db.query<{ id: string }>(`SELECT id FROM rulesets WHERE status = 'FROZEN' LIMIT 1`);
    const { rows: users } = await db.query<{ id: string; dept_id: string }>(
      `SELECT u.id, m.department_id AS dept_id
         FROM users u
         JOIN department_memberships m ON m.user_id = u.id AND m.valid_to IS NULL
        WHERE u.status = 'ACTIVE'
        ORDER BY u.display_name LIMIT 2`,
    );
    targetId = users[0].id;
    const approverId = users[1].id;
    const ins = await db.query<{ id: string }>(
      `INSERT INTO cycles (id, org_id, month, title, status, open_at, close_at, publish_at, ruleset_id)
       VALUES (gen_random_uuid(), $1, $2, 'worker-test-publish', 'CALIBRATING', now() - interval '2 days', now() - interval '1 hour', now() - interval '5 minutes', $3)
       RETURNING id`,
      [orgs[0].id, `${PUBLISH_MONTH}-01`, rs[0].id],
    );
    publishCycleId = ins.rows[0].id;
    await db.query(
      `INSERT INTO cycle_phases (cycle_id, phase, planned_at) VALUES ($1, 'PUBLISH', now() - interval '5 minutes')`,
      [publishCycleId],
    );
    // 空周期（无任何 build）：用于验证 no_approved_builds 分支
    const empty = await db.query<{ id: string }>(
      `INSERT INTO cycles (id, org_id, month, title, status, open_at, close_at, publish_at, ruleset_id)
       VALUES (gen_random_uuid(), $1, $2, 'worker-test-empty', 'CALIBRATING', now() - interval '2 days', now() - interval '1 hour', now() - interval '5 minutes', $3)
       RETURNING id`,
      [orgs[0].id, `${FUTURE_MONTH}-01`, rs[0].id],
    );
    emptyCycleId = empty.rows[0].id;
    await db.query(
      `INSERT INTO cycle_phases (cycle_id, phase, planned_at) VALUES ($1, 'PUBLISH', now() - interval '5 minutes')`,
      [emptyCycleId],
    );

    // 参与者 + 真实 build（复用 domain buildOne）+ 批准
    await db.query(
      `INSERT INTO cycle_participants (cycle_id, org_id, user_id, dept_snapshot, role_snapshot, template_id)
       SELECT $1, $2, $3, $4, 'MEMBER',
              (SELECT tv.id FROM template_versions tv WHERE tv.ruleset_id = $5 AND tv.role_code = 'MEMBER' LIMIT 1)`,
      [publishCycleId, orgs[0].id, targetId, users[0].dept_id, rs[0].id],
    );
    const { buildOne } = await import('@360/domain');
    // A publishable fixture needs effective peer/self revisions, exact templates and all items.
    const run=(await db.query(`INSERT INTO assignment_runs(id,cycle_id,org_id,version,seed,algorithm_version,input_hash,status)
      VALUES(gen_random_uuid(),$1,$2,1,'worker','fixture','worker-fixture','LOCKED') RETURNING id`,[publishCycleId,orgs[0].id])).rows[0].id;
    const assignment=(await db.query(`INSERT INTO assignments(id,run_id,cycle_id,org_id,reviewer_id,target_id,source_type)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'PEER') RETURNING id`,[run,publishCycleId,orgs[0].id,approverId,targetId])).rows[0].id;
    for(const kind of ['SELF','PEER']) {
      const review=(await db.query(`INSERT INTO reviews(id,cycle_id,org_id,assignment_id,reviewer_id,target_id,kind,status)
        VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,'SUBMITTED') RETURNING id`,[publishCycleId,orgs[0].id,kind==='PEER'?assignment:null,kind==='PEER'?approverId:targetId,targetId,kind])).rows[0].id;
      const revision=(await db.query(`INSERT INTO review_revisions(id,org_id,review_id,revision_no,template_id,score_bp,read_confirmed)
        SELECT gen_random_uuid(),$1,$2,1,id,7000,true FROM template_versions WHERE ruleset_id=$3 AND role_code=$4 RETURNING id,template_id`,[orgs[0].id,review,rs[0].id,kind==='SELF'?'SELF':'MEMBER'])).rows[0];
      await db.query(`INSERT INTO review_item_scores(id,revision_id,org_id,item_id,score) SELECT gen_random_uuid(),$1,$2,id,70 FROM template_items WHERE template_id=$3`,[revision.id,orgs[0].id,revision.template_id]);
      await db.query('UPDATE reviews SET current_revision_id=$1 WHERE id=$2',[revision.id,review]);
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const outcome = await buildOne(client, publishCycleId, orgs[0].id, targetId);
      await client.query(
        `UPDATE result_builds SET status = 'APPROVED' WHERE id = $1`,
        [outcome.buildId],
      );
      await client.query(
        `INSERT INTO result_approvals (id, result_build_id, org_id, approver_id, decision, reason)
         VALUES (gen_random_uuid(), $1, $2, $3, 'APPROVED', 'worker test approve')`,
        [outcome.buildId, orgs[0].id, approverId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    if (db) {
      for (const cid of [publishCycleId, emptyCycleId]) {
        if (!cid) continue;
        await db.query(`DELETE FROM notification_outbox WHERE org_id = (SELECT org_id FROM cycles WHERE id = $1) AND event_key LIKE '%' || $1 || '%'`, [cid]);
        await db.query(`DELETE FROM published_results WHERE cycle_id = $1`, [cid]);
        await db.query(`DELETE FROM result_source_reviews WHERE result_build_id IN (SELECT id FROM result_builds WHERE cycle_id = $1)`, [cid]);
        await db.query(`DELETE FROM result_approvals WHERE result_build_id IN (SELECT id FROM result_builds WHERE cycle_id = $1)`, [cid]);
        await db.query(`DELETE FROM result_builds WHERE cycle_id = $1`, [cid]);
        await db.query(`UPDATE reviews SET current_revision_id=NULL WHERE cycle_id=$1`,[cid]);
        await db.query(`DELETE FROM review_item_scores WHERE revision_id IN(SELECT rr.id FROM review_revisions rr JOIN reviews r ON r.id=rr.review_id WHERE r.cycle_id=$1)`,[cid]);
        await db.query(`DELETE FROM review_revisions WHERE review_id IN(SELECT id FROM reviews WHERE cycle_id=$1)`,[cid]);
        await db.query(`DELETE FROM reviews WHERE cycle_id=$1`,[cid]);
        await db.query(`DELETE FROM assignments WHERE cycle_id=$1`,[cid]);
        await db.query(`DELETE FROM assignment_runs WHERE cycle_id=$1`,[cid]);
        await db.query(`DELETE FROM cycle_participants WHERE cycle_id = $1`, [cid]);
        await db.query(`DELETE FROM cycle_state_log WHERE cycle_id = $1`, [cid]);
        await db.query(`DELETE FROM cycle_phases WHERE cycle_id = $1`, [cid]);
        await db.query(`DELETE FROM cycles WHERE id = $1`, [cid]);
      }
    }
  });

  it('无批准 build 的周期：SKIPPED 且保持 CALIBRATING', async () => {
    const { executePhase } = await import('../src/phases/handlers.js');
    const outcome = await executePhase('PUBLISH', emptyCycleId, new Date());
    expect(outcome.kind).toBe('SKIPPED');
    if (outcome.kind === 'SKIPPED') {
      expect(outcome.reason).toBe('manual_publication_required');
    }
    if (db) {
      const cyc = await db.query<{ status: string }>(`SELECT status FROM cycles WHERE id = $1`, [emptyCycleId]);
      expect(cyc.rows[0].status).toBe('CALIBRATING');
    }
  });

  it('即使已有APPROVED构建，Worker也不得发布或写完成时间',async()=>{
    const {executePhase}=await import('../src/phases/handlers.js');
    const outcome=await executePhase('PUBLISH',publishCycleId,new Date());expect(outcome.kind).toBe('SKIPPED');
    expect((await db!.query('SELECT 1 FROM published_results WHERE cycle_id=$1',[publishCycleId])).rowCount).toBe(0);
    expect((await db!.query("SELECT actual_at FROM cycle_phases WHERE cycle_id=$1 AND phase='PUBLISH'",[publishCycleId])).rows[0].actual_at).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('worker: dispatcher 扫描', () => {
  it('fetchDuePhases 只返回已到期且 actual_at 为空的 phase', async () => {
    if (!db) return;
    const { fetchDuePhases } = await import('../src/phases/dispatcher.js');
    // 准备：再插入一个 planned_at 在未来的 phase，应该被过滤
    const futureId = await db
      .query<{ id: string }>(
        `INSERT INTO cycles (id, org_id, month, title, status, ruleset_id)
         SELECT gen_random_uuid(), org_id, $2, 'worker-test-future', 'REVIEWING', ruleset_id FROM cycles WHERE id = $1
         RETURNING id`,
        [cycleId, `${FUTURE_MONTH}-01`],
      )
      .then((r) => r.rows[0].id);
    await db.query(
      `INSERT INTO cycle_phases (cycle_id, phase, planned_at) VALUES ($1, 'CLOSE', now() + interval '1 day')`,
      [futureId],
    );
    const due = await fetchDuePhases(100);
    // 已执行过 actual_at 的不应该出现；未来时间的也不应该
    expect(due.find((d) => d.cycle_id === cycleId)).toBeUndefined();
    expect(due.find((d) => d.cycle_id === futureId)).toBeUndefined();
    // 清理
    await db.query(`DELETE FROM cycle_phases WHERE cycle_id = $1`, [futureId]);
    await db.query(`DELETE FROM cycles WHERE id = $1`, [futureId]);
  });
});
