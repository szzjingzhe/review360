import '../../../scripts/test-db-setup.cjs';
/**
 * M2.4 集成测试：开期预检、锁定与替补（需要真实 PostgreSQL，已迁移+播种）。
 * 流程：创建周期 → submit → preview → open → replace → 校验状态与数据。
 */
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { purgeCycles } from './helpers/cycle-cleanup';

let app: INestApplication;
let baseUrl: string;
let db = null as unknown as Pool;

const probe = new Pool({
  connectionString:
    process.env.DATABASE_URL!,
});
let dbAvailable = false;
try {
  await probe.query('SELECT 1');
  const { rows } = await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  dbAvailable = rows[0].n > 0;
} catch {
  dbAvailable = false;
}
if (dbAvailable) {
  db = probe;
} else {
  await probe.end().catch(() => undefined);
  console.warn('[SKIP] PostgreSQL 不可达：M2.4 集成测试跳过');
}

async function request(method: string, url: string, body?: unknown, cookie?: string) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.get('set-cookie')?.split(';')[0];
  return { status: res.status, body: json, setCookie };
}

async function loginAs(name: string): Promise<string> {
  const { rows } = await db.query(`SELECT id FROM users WHERE display_name = $1`, [name]);
  const res = await request('POST', '/api/v1/auth/demo-login', { user_id: rows[0].id });
  return res.setCookie!;
}

const TEST_MONTH = '2032-09';
// 本文件会创建的所有周期月份（含测试内的守卫用例），用于前置清理与收尾清理
const OWNED_MONTHS = [`${TEST_MONTH}-01`, '2032-10-01'];
let cycleId = '';
let adminCookie = '';
let memberCookie = '';
let manualEdge:{reviewer_id:string;target_id:string}|undefined;

beforeAll(async () => {
  if (!dbAvailable) return;
  // 先清残留：上一次运行若被中断，残留周期会让 createCycle 返回 400 CYCLE_MONTH_EXISTS
  await purgeCycles(db!, OWNED_MONTHS);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  adminCookie = await loginAs('示例成员18');
  memberCookie = await loginAs('示例成员01');

  // 建周期并提交开期
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM rulesets WHERE status = 'FROZEN' ORDER BY created_at LIMIT 1`,
  );
  const created = await request(
    'POST',
    '/api/v1/cycles',
    {
      month: TEST_MONTH,
      ruleset_id: rows[0].id,
      open_at: `${TEST_MONTH}-25T00:00:00+08:00`,
      close_at: `${TEST_MONTH}-27T18:00:00+08:00`,
      publish_at: `${TEST_MONTH}-28T22:00:00+08:00`,
    },
    adminCookie,
  );
  expect(created.status).toBe(201);
  cycleId = created.body.data.id;
  const submitted = await request('POST', `/api/v1/cycles/${cycleId}/submit`, {}, adminCookie);
  expect(submitted.status).toBe(200);
});

afterAll(async () => {
  if (db) {
    await purgeCycles(db, OWNED_MONTHS).catch((err) => {
      console.error('[m2.assignment] 清理失败:', err instanceof Error ? err.message : err);
    });
    await db.end();
  }
  if (app) await app.close();
});

describe.skipIf(!dbAvailable)('M2.4 预检、开期锁定与替补（真实数据库）', () => {
  it('部长授权仅能指定本部门；人工关系优先预览，修改使旧预览失效',async()=>{
    const participants=(await db.query(`SELECT p.user_id,p.dept_snapshot,p.role_snapshot FROM cycle_participants p WHERE p.cycle_id=$1 AND p.eligibility='ELIGIBLE' ORDER BY p.user_id`,[cycleId])).rows;
    const head=participants.find(p=>p.role_snapshot==='HEAD');
    const local=participants.filter(p=>p.dept_snapshot===head.dept_snapshot&&p.role_snapshot==='MEMBER');
    const foreign=participants.find(p=>p.dept_snapshot!==head.dept_snapshot&&p.role_snapshot==='MEMBER');
    // Explicit fixture grant, not automatic production role expansion.
    const grant=(await db.query(`INSERT INTO capability_grants(id,org_id,user_id,capability,scope_type,scope_id,reason)
      SELECT gen_random_uuid(),org_id,$2,'assignment.manage','DEPARTMENT',$3,'isolated manual assignment test' FROM cycles WHERE id=$1 RETURNING id`,[cycleId,head.user_id,head.dept_snapshot])).rows[0].id;
    try {
      const response=await request('POST','/api/v1/auth/demo-login',{user_id:head.user_id});const cookie=response.setCookie!;
      const list=await request('GET',`/api/v1/cycles/${cycleId}/assignment/manual`,undefined,cookie);
      expect(list.status).toBe(200);expect(list.body.data.participants.every((p:any)=>p.dept_snapshot===head.dept_snapshot)).toBe(true);
      const denied=await request('POST',`/api/v1/cycles/${cycleId}/assignment/manual`,{reviewer_id:foreign.user_id,target_id:local[0].user_id},cookie);
      expect(denied.status).toBe(400);
      manualEdge={reviewer_id:local[0].user_id,target_id:local[1].user_id};
      expect((await request('POST',`/api/v1/cycles/${cycleId}/assignment/manual`,manualEdge,cookie)).status).toBe(200);
      expect((await request('POST',`/api/v1/cycles/${cycleId}/assignment/manual`,manualEdge,cookie)).status).toBe(409);
      const preview=await request('POST',`/api/v1/cycles/${cycleId}/assignment/preview`,{},adminCookie);
      expect(preview.body.data.edges).toContainEqual(expect.objectContaining({reviewerId:manualEdge.reviewer_id,targetId:manualEdge.target_id,sourceType:'MANUAL',isFixed:true}));
      expect((await request('DELETE',`/api/v1/cycles/${cycleId}/assignment/manual`,manualEdge,cookie)).status).toBe(200);
      expect((await request('POST',`/api/v1/cycles/${cycleId}/open`,{run_id:preview.body.data.id},adminCookie)).status).toBe(400);
      expect((await request('POST',`/api/v1/cycles/${cycleId}/assignment/manual`,manualEdge,cookie)).status).toBe(200);
    }finally{await db.query('DELETE FROM capability_grants WHERE id=$1',[grant]);}
  });
  it('预检：普通成员 403；管理员生成 FEASIBLE run，44 人边数 185-200，入度 4-5', async () => {
    const forbidden = await request('POST', `/api/v1/cycles/${cycleId}/assignment/preview`, {}, memberCookie);
    expect(forbidden.status).toBe(403);

    const preview = await request('POST', `/api/v1/cycles/${cycleId}/assignment/preview`, {}, adminCookie);
    expect(preview.status).toBe(200);
    expect(preview.body.data.feasible).toBe(true);
    expect(preview.body.data.status).toBe('FEASIBLE');
    expect(preview.body.data.edge_count).toBeGreaterThanOrEqual(185);
    expect(preview.body.data.edge_count).toBeLessThanOrEqual(200);

    // run 列表可见
    const runs = await request('GET', `/api/v1/cycles/${cycleId}/assignment-runs`, undefined, adminCookie);
    expect(runs.status).toBe(200);
    expect(runs.body.data.length).toBeGreaterThanOrEqual(1);
    expect(runs.body.data[0].input_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('开期：DRAFT 周期不可开（状态冲突）；PENDING_OPEN 开期成功并锁定分配', async () => {
    // 用第二个 DRAFT 周期验证状态守卫
    const { rows: rs } = await db.query(`SELECT id FROM rulesets WHERE status = 'FROZEN' ORDER BY created_at LIMIT 1`);
    const draftCycle = await request(
      'POST',
      '/api/v1/cycles',
      {
        month: '2032-10',
        ruleset_id: rs[0].id,
        open_at: '2032-10-25T00:00:00+08:00',
        close_at: '2032-10-27T18:00:00+08:00',
        publish_at: '2032-10-28T22:00:00+08:00',
      },
      adminCookie,
    );
    expect(draftCycle.status).toBe(201);
    const draftOpen = await request('POST', `/api/v1/cycles/${draftCycle.body.data.id}/open`, {}, adminCookie);
    expect(draftOpen.status).toBe(400);
    // 清理该草稿周期
    await db.query(`DELETE FROM cycle_participants WHERE cycle_id = $1`, [draftCycle.body.data.id]);
    await db.query(`DELETE FROM cycles WHERE id = $1`, [draftCycle.body.data.id]);

    // 正式开期
    const preview = await request('POST', `/api/v1/cycles/${cycleId}/assignment/preview`, {}, adminCookie);
    const opened = await request('POST', `/api/v1/cycles/${cycleId}/open`, {run_id:preview.body.data.id}, adminCookie);
    expect(opened.status).toBe(200);
    expect(opened.body.data.status).toBe('REVIEWING');
    expect(opened.body.data.edge_count).toBeGreaterThanOrEqual(185);
    expect((await db.query(`SELECT id FROM assignments WHERE cycle_id=$1 AND reviewer_id=$2 AND target_id=$3 AND is_fixed=true AND reason='MANUAL'`,[cycleId,manualEdge!.reviewer_id,manualEdge!.target_id])).rowCount).toBe(1);
    expect((await request('POST',`/api/v1/cycles/${cycleId}/assignment/manual`,manualEdge,adminCookie)).status).toBe(409);

    // DB 校验：assignments 已写入、run LOCKED、cycle_locks 存在、OPEN 阶段已落账
    const { rows: lockRows } = await db.query(
      `SELECT assignment_run_id FROM cycle_locks WHERE cycle_id = $1`,
      [cycleId],
    );
    expect(lockRows[0]).toBeDefined();
    const { rows: runRows } = await db.query(
      `SELECT status FROM assignment_runs WHERE id = $1`,
      [lockRows[0].assignment_run_id],
    );
    expect(runRows[0].status).toBe('LOCKED');

    const { rows: edgeCount } = await db.query(
      `SELECT count(*)::int n FROM assignments WHERE cycle_id = $1 AND status = 'ACTIVE'`,
      [cycleId],
    );
    expect(edgeCount[0].n).toBeGreaterThanOrEqual(185);

    // 入度校验（被评价者 4-5）
    const { rows: indeg } = await db.query(
      `SELECT target_id, count(*)::int d FROM assignments
       WHERE cycle_id = $1 AND status = 'ACTIVE' GROUP BY target_id
       HAVING count(*) < 4 OR count(*) > 5`,
      [cycleId],
    );
    expect(indeg).toHaveLength(0);

    const { rows: openPhase } = await db.query(
      `SELECT actual_at FROM cycle_phases WHERE cycle_id = $1 AND phase = 'OPEN'`,
      [cycleId],
    );
    expect(openPhase[0].actual_at).not.toBeNull();

    // 重复开期被拒
    const reopen = await request('POST', `/api/v1/cycles/${cycleId}/open`, {}, adminCookie);
    expect(reopen.status).toBe(400);
  });

  it('替补：指定 reviewer 替换一条边；旧边 CANCELLED、新边 REPLACEMENT 并引用', async () => {
    const { rows: edges } = await db.query(
      `SELECT id, reviewer_id, target_id FROM assignments
       WHERE cycle_id = $1 AND status = 'ACTIVE' AND source_type = 'PEER' LIMIT 1`,
      [cycleId],
    );
    expect(edges[0]).toBeDefined();
    const edge = edges[0];

    // 找一个非本人且当前未评价该 target 的人作为替补
    const { rows: cand } = await db.query(
      `SELECT p.user_id FROM cycle_participants p
       WHERE p.cycle_id = $1 AND p.user_id <> $2 AND p.user_id <> $3
         AND NOT EXISTS (
           SELECT 1 FROM assignments a
           WHERE a.cycle_id = $1 AND a.reviewer_id = p.user_id AND a.target_id = $2 AND a.status <> 'CANCELLED'
         ) LIMIT 1`,
      [cycleId, edge.target_id, edge.reviewer_id],
    );

    const replaced = await request(
      'POST',
      `/api/v1/cycles/${cycleId}/assignments/${edge.id}/replace`,
      { reviewer_id: cand[0].user_id, reason: '人员变动测试' },
      adminCookie,
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.source_type).toBe('REPLACEMENT');
    expect(replaced.body.data.replaces_id).toBe(edge.id);

    const { rows: oldEdge } = await db.query(
      `SELECT status FROM assignments WHERE id = $1`,
      [edge.id],
    );
    expect(oldEdge[0].status).toBe('CANCELLED');

    const { rows: newEdge } = await db.query(
      `SELECT status, reviewer_id FROM assignments WHERE id = $1`,
      [replaced.body.data.id],
    );
    expect(newEdge[0].status).toBe('ACTIVE');
    expect(newEdge[0].reviewer_id).toBe(cand[0].user_id);
    const review=(await db.query('SELECT reviewer_id,status FROM reviews WHERE assignment_id=$1',[replaced.body.data.id])).rows;
    expect(review).toEqual([{reviewer_id:cand[0].user_id,status:'DRAFT'}]);
  });

  it('替补守卫：非 REVIEWING 不可替补、自评替换 400、重复替换同一条边 400', async () => {
    // 非 REVIEWING（用 CANCELLED 周期不行，先测自评替换）
    const { rows: edge } = await db.query(
      `SELECT id, target_id FROM assignments WHERE cycle_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [cycleId],
    );
    const self = await request(
      'POST',
      `/api/v1/cycles/${cycleId}/assignments/${edge[0].id}/replace`,
      { reviewer_id: edge[0].target_id },
      adminCookie,
    );
    expect(self.status).toBe(400);

    const twice = await request(
      'POST',
      `/api/v1/cycles/${cycleId}/assignments/${edge[0].id}/replace`,
      {},
      adminCookie,
    );
    expect(twice.status).toBe(200);
    const thrice = await request(
      'POST',
      `/api/v1/cycles/${cycleId}/assignments/${edge[0].id}/replace`,
      {},
      adminCookie,
    );
    expect(thrice.status).toBe(400);

    // 取消后状态守卫
    await db.query(`UPDATE cycles SET status = 'CALIBRATING' WHERE id = $1`, [cycleId]);
    const notReviewing = await request(
      'POST',
      `/api/v1/cycles/${cycleId}/assignments/${edge[0].id}/replace`,
      {},
      adminCookie,
    );
    expect(notReviewing.status).toBe(400);
    await db.query(`UPDATE cycles SET status = 'REVIEWING' WHERE id = $1`, [cycleId]);
  });
});
