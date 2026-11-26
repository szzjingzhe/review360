import '../../../scripts/test-db-setup.cjs';
/**
 * M2.2 集成测试：周期与规则集 API（需要真实 PostgreSQL，已迁移+播种）。
 * 数据库不可达时显式跳过。测试用独立月份，互不冲突；结束后清理创建的周期。
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
  await probe.query('SELECT 1 FROM schema_migrations LIMIT 1');
  const { rows } = await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  dbAvailable = rows[0].n > 0;
} catch {
  dbAvailable = false;
}
if (dbAvailable) {
  db = probe;
} else {
  await probe.end().catch(() => undefined);
  console.warn('[SKIP] PostgreSQL 不可达：M2.2 集成测试跳过');
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
  if (!rows[0]) throw new Error(`用户不存在: ${name}`);
  const res = await request('POST', '/api/v1/auth/demo-login', { user_id: rows[0].id });
  return res.setCookie!;
}

/** 默认规则集 id 与种子人数一致校验用 */
let frozenRulesetId = '';
const TEST_MONTH = '2031-05'; // 避开真实数据
const createdCycleIds: string[] = [];
// 本文件会创建的周期月份（含校验用例用的 2031-06 / 2031-07）
const OWNED_MONTHS = [`${TEST_MONTH}-01`, '2031-06-01', '2031-07-01'];

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
});

afterAll(async () => {
  if (db) {
    await purgeCycles(db, OWNED_MONTHS).catch((err) => {
      console.error('[m2.cycles] 清理失败:', err instanceof Error ? err.message : err);
    });
    await db.end();
  }
  if (app) await app.close();
});

describe.skipIf(!dbAvailable)('M2.2 周期与规则集 API（真实数据库）', () => {
  it('规则集列表：登录可读，含种子默认规则集（FROZEN）与 6 类模板', async () => {
    const cookie = await loginAs('示例成员01');
    const res = await request('GET', '/api/v1/rulesets', undefined, cookie);
    expect(res.status).toBe(200);
    const list = res.body.data;
    expect(list.length).toBeGreaterThanOrEqual(1);
    const def = list.find((r: any) => r.status === 'FROZEN');
    expect(def).toBeDefined();
    // HRBP 专项已取消，保留 5 类模板。
    expect(def.template_count).toBe(5);

    const detail = await request('GET', `/api/v1/rulesets/${def.id}`, undefined, cookie);
    expect(detail.status).toBe(200);
    frozenRulesetId = detail.body.data.id;
    const roles = detail.body.data.templates.map((t: any) => t.role_code).sort();
    expect(roles).toEqual(['HEAD', 'MEMBER', 'SELF', 'SUPERVISOR', 'UPWARD']);
    for (const t of detail.body.data.templates) {
      const total = t.items.reduce((s: number, i: any) => s + i.weight, 0);
      expect(total).toBe(100);
    }
  });

  it('规则集写入需 org.manage：普通成员 403', async () => {
    const cookie = await loginAs('示例成员01');
    const res = await request('POST', '/api/v1/rulesets', { config: { schema_version: 1 } }, cookie);
    expect(res.status).toBe(403);
  });

  it('管理员创建规则集草稿并冻结：版本递增、checksum 更新、重复冻结 400', async () => {
    const cookie = await loginAs('示例成员18'); // bootstrap admin（org.manage）
    const created = await request(
      'POST',
      '/api/v1/rulesets',
      { base_ruleset_id: frozenRulesetId },
      cookie,
    );
    expect(created.status).toBe(201);
    const draftId = created.body.data.id;
    expect(created.body.data.status).toBe('DRAFT');

    const frozen = await request('POST', `/api/v1/rulesets/${draftId}/freeze`, {}, cookie);
    expect(frozen.status).toBe(200);
    expect(frozen.body.data.status).toBe('FROZEN');
    expect(frozen.body.data.checksum).toMatch(/^[0-9a-f]{64}$/);

    const again = await request('POST', `/api/v1/rulesets/${draftId}/freeze`, {}, cookie);
    expect(again.status).toBe(400);
  });

  it('创建周期：快照含 44 名部门人员，原 HRBP 均按产品部普通成员处理', async () => {
    const cookie = await loginAs('示例成员18');
    const res = await request(
      'POST',
      '/api/v1/cycles',
      {
        month: TEST_MONTH,
        ruleset_id: frozenRulesetId,
        open_at: `${TEST_MONTH}-25T00:00:00+08:00`,
        close_at: `${TEST_MONTH}-27T18:00:00+08:00`,
        calibration_at: `${TEST_MONTH}-27T22:00:00+08:00`,
        publish_at: `${TEST_MONTH}-28T22:00:00+08:00`,
      },
      cookie,
    );
    expect(res.status).toBe(201);
    const cycle = res.body.data;
    expect(cycle.status).toBe('DRAFT');
    createdCycleIds.push(cycle.id);

    // 快照：5 部长 + 39 普通成员；监管示例成员50不参与。
    const detail = await request('GET', `/api/v1/cycles/${cycle.id}`, undefined, cookie);
    expect(detail.status).toBe(200);
    const participants = detail.body.data.participants;
    expect(participants.length).toBe(44);

    const byRole: Record<string, number> = {};
    for (const p of participants) byRole[p.role_snapshot] = (byRole[p.role_snapshot] ?? 0) + 1;
    expect(byRole['HEAD']).toBe(5);
    expect(byRole['MEMBER']).toBe(39);
    expect(byRole['EXTERNAL']).toBeUndefined();

    const mayanfeng = participants.find((p: any) => p.display_name === '示例成员43');
    expect(mayanfeng).toBeDefined();
    expect(mayanfeng.role_snapshot).toBe('MEMBER');
    expect(mayanfeng.dept_code).toBe('PD');
    expect(mayanfeng.station_snapshot).toBeNull();

    // 示例成员18仅保留产品部部长身份。
    const exampleHead = participants.find((p: any) => p.display_name === '示例成员18');
    expect(exampleHead.role_snapshot).toBe('HEAD');
    expect(exampleHead.station_snapshot).toBeNull();

    // 监管独立复核人不在参与者中
    const qin = participants.find((p: any) => p.display_name === '示例成员50');
    expect(qin).toBeUndefined();

    // 状态日志
    expect(detail.body.data.state_log[0].to_status).toBe('DRAFT');
  });

  it('周期创建校验：未冻结规则集 400、时间倒置 400、月份重复 400、越权 403', async () => {
    const admin = await loginAs('示例成员18');
    const member = await loginAs('示例成员01');

    // 普通成员 403（无 cycle.manage）
    const forbidden = await request(
      'POST',
      '/api/v1/cycles',
      { month: '2031-06', ruleset_id: frozenRulesetId, open_at: 'x', close_at: 'y', publish_at: 'z' },
      member,
    );
    expect(forbidden.status).toBe(403);

    // 时间倒置
    const badSchedule = await request(
      'POST',
      '/api/v1/cycles',
      {
        month: '2031-06',
        ruleset_id: frozenRulesetId,
        open_at: '2031-06-27T00:00:00+08:00',
        close_at: '2031-06-25T00:00:00+08:00',
        publish_at: '2031-06-28T00:00:00+08:00',
      },
      admin,
    );
    expect(badSchedule.status).toBe(400);
    expect(badSchedule.body.code ?? badSchedule.body?.message?.code).toBeDefined();

    // 同月重复
    const dup = await request(
      'POST',
      '/api/v1/cycles',
      {
        month: TEST_MONTH,
        ruleset_id: frozenRulesetId,
        open_at: `${TEST_MONTH}-25T00:00:00+08:00`,
        close_at: `${TEST_MONTH}-27T18:00:00+08:00`,
        publish_at: `${TEST_MONTH}-28T22:00:00+08:00`,
      },
      admin,
    );
    expect(dup.status).toBe(400);

    // 未冻结规则集
    const draftRs = await request('POST', '/api/v1/rulesets', { config: {} }, admin);
    const withDraft = await request(
      'POST',
      '/api/v1/cycles',
      {
        month: '2031-07',
        ruleset_id: draftRs.body.data.id,
        open_at: '2031-07-25T00:00:00+08:00',
        close_at: '2031-07-27T18:00:00+08:00',
        publish_at: '2031-07-28T22:00:00+08:00',
      },
      admin,
    );
    expect(withDraft.status).toBe(400);
  });

  it('周期状态流：DRAFT → PENDING_OPEN → CANCELLED；非 DRAFT 不能 refresh/submit', async () => {
    const admin = await loginAs('示例成员18');
    const cycleId = createdCycleIds[0];

    const refresh = await request('POST', `/api/v1/cycles/${cycleId}/participants/refresh`, {}, admin);
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.participant_count).toBe(44);

    const submit = await request('POST', `/api/v1/cycles/${cycleId}/submit`, {}, admin);
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('PENDING_OPEN');

    // PENDING_OPEN 后不可再 refresh（快照锁定）
    const refreshAfter = await request('POST', `/api/v1/cycles/${cycleId}/participants/refresh`, {}, admin);
    expect(refreshAfter.status).toBe(400);

    const cancel = await request('POST', `/api/v1/cycles/${cycleId}/cancel`, { reason: '测试取消' }, admin);
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');

    const cancelAgain = await request('POST', `/api/v1/cycles/${cycleId}/cancel`, {}, admin);
    expect(cancelAgain.status).toBe(400);
  });

  it('周期列表：登录成员可见，含参与者数', async () => {
    const member = await loginAs('示例成员01');
    const res = await request('GET', '/api/v1/cycles', undefined, member);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const target = res.body.data.find((c: any) => c.month === `${TEST_MONTH}-01`);
    expect(target).toBeDefined();
    expect(target.participant_count).toBe(44);
    expect(target.status).toBe('CANCELLED');
  });
});
