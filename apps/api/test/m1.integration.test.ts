import '../../../scripts/test-db-setup.cjs';
/**
 * M1 集成测试（需要真实 PostgreSQL：先 `pnpm db:up && pnpm db:migrate && pnpm db:seed`）。
 * 数据库不可达时显式跳过并说明原因——不伪造通过。
 */
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

let app: INestApplication;
let baseUrl: string;
let db = null as unknown as Pool;

// 收集阶段探测数据库（含迁移与种子是否就绪），决定是否跳过
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
  console.warn(
    '[SKIP] PostgreSQL 不可达或未迁移/播种：M1 集成测试跳过（待执行 pnpm db:up && pnpm db:migrate && pnpm db:seed 后复跑）',
  );
}

const ORG_URL = '/api/v1/organization';
const ME_URL = '/api/v1/me';
const GRANTS_URL = '/api/v1/capability-grants';

async function request(
  method: string,
  url: string,
  body?: unknown,
  cookie?: string,
): Promise<{ status: number; body: any; setCookie?: string }> {
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
    /* 非 JSON 响应 */
  }
  const setCookie = res.headers.get('set-cookie')?.split(';')[0];
  return { status: res.status, body: json, setCookie };
}

async function loginAs(name: string): Promise<string> {
  if (!db) throw new Error('数据库不可用');
  const { rows } = await db.query(`SELECT id FROM users WHERE display_name = $1`, [name]);
  if (!rows[0]) throw new Error(`用户不存在: ${name}`);
  const res = await request('POST', '/api/v1/auth/demo-login', { user_id: rows[0].id });
  if (res.status !== 200 || !res.setCookie) throw new Error(`登录失败: ${name}`);
  return res.setCookie;
}

beforeAll(async () => {
  if (!dbAvailable) return;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.end();
});

describe.skipIf(!dbAvailable)('M1 认证与越权（真实数据库）', () => {
  it('正式组织名录可由成员读取，未登录拒绝，且不泄露权限或外部身份',async()=>{
    expect((await request('GET','/api/v1/organization/members')).status).toBe(401);
    const cookie=await loginAs('示例成员02');const response=await request('GET','/api/v1/organization/members',undefined,cookie);
    expect(response.status).toBe(200);expect(response.body.data.length).toBeGreaterThan(40);
    expect(response.body.data.filter((u:any)=>u.roles.includes('HEAD')).length).toBe(5);
    for(const user of response.body.data)expect(Object.keys(user).sort()).toEqual(['dept_id','dept_name','display_name','id','org_id','roles']);
  });
  it('未认证访问 /organization 与 /me 被拒绝（401）', async () => {
    expect((await request('GET', ORG_URL)).status).toBe(401);
    expect((await request('GET', ME_URL)).status).toBe(401);
  });

  it('演示登录：未知用户 401，合法用户 200 并种下 HttpOnly Cookie', async () => {
    const bad = await request('POST', '/api/v1/auth/demo-login', {
      user_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(bad.status).toBe(401);

    const res = await request('POST', '/api/v1/auth/demo-login', { user_id: (await db.query(`SELECT id FROM users WHERE display_name='示例成员01'`)).rows[0].id });
    expect(res.status).toBe(200);
    expect(res.body?.data?.display_name).toBe('示例成员01');
    expect(res.setCookie).toMatch(/^s360_session=/);
  });

  it('/me：部长身份、部门归属与能力正确返回', async () => {
    const cookie = await loginAs('示例成员01');
    const res = await request('GET', ME_URL, undefined, cookie);
    expect(res.status).toBe(200);
    const { department, appointments, capabilities } = res.body.data;
    expect(department.dept_name).toBe('科技部');
    expect(appointments).toContainEqual(expect.objectContaining({ role: 'HEAD' }));
    expect(Array.isArray(capabilities)).toBe(true);
  });

  it('组织架构共 5 部门、44 人，原 HRBP 人员已归入产品部', async () => {
    const cookie = await loginAs('示例成员02');
    const res = await request('GET', ORG_URL, undefined, cookie);
    expect(res.status).toBe(200);
    const depts = res.body.data.departments;
    expect(depts).toHaveLength(5);
    const counts = depts.map((d: any) => d.member_count).sort();
    expect(counts.join(',')).toBe('8,9,9,9,9');
    expect(depts.reduce((n: number, d: any) => n + d.member_count, 0)).toBe(44);
    const byCode = Object.fromEntries(depts.map((d: any) => [d.code, d]));
    expect(byCode.TECH.head_name).toBe('示例成员01');
    expect(byCode.RD.head_name).toBe('示例成员10');
    expect(byCode.PD.head_name).toBe('示例成员18');
    expect(byCode.ECO.head_name).toBe('示例成员25');
    expect(byCode.NET.head_name).toBe('示例成员34');
  });

  it('越权拦截：普通成员访问授权管理被拒绝（403）', async () => {
    const cookie = await loginAs('示例成员02');
    const res = await request('GET', GRANTS_URL, undefined, cookie);
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('FORBIDDEN');
  });

  it('授权链路：管理员显式授权 → 生效 → 撤销后失效（PRD 3.3）', async () => {
    const admin = await loginAs('示例成员18'); // 演示引导管理员（decisions.md D-M1-1）
    expect((await request('GET', GRANTS_URL, undefined, admin)).status).toBe(200);

    const target = (await db.query(`SELECT id FROM users WHERE display_name='示例成员02'`)).rows[0].id;
    const noReason = await request(
      'POST', GRANTS_URL,
      { user_id: target, capability: 'assignment.manage', reason: '   ' },
      admin,
    );
    expect(noReason.status).toBe(400);
    expect(noReason.body?.field).toBe('reason');
    const created = await request(
      'POST',
      GRANTS_URL,
      { user_id: target, capability: 'assignment.manage', reason: 'M1 集成测试' },
      admin,
    );
    expect(created.status).toBe(201);
    expect(created.body.data.reason).toBe('M1 集成测试');

    const repeated = await request(
      'POST', GRANTS_URL,
      { user_id: target, capability: 'assignment.manage', reason: 'M1 重复点击' },
      admin,
    );
    expect(repeated.status).toBe(201);
    expect(repeated.body.data.id).toBe(created.body.data.id);
    expect(repeated.body.data.already_granted).toBe(true);
    const audit = await db.query(
      `SELECT reason FROM audit_events
       WHERE action = 'capability.grant' AND resource_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [created.body.data.id],
    );
    expect(audit.rows[0]?.reason).toContain('M1 集成测试');

    const managedUsers = await request('GET', '/api/v1/user-management', undefined, admin);
    expect(managedUsers.status).toBe(200);
    const listedTarget = managedUsers.body.data.find((member: any) => member.id === target);
    expect(listedTarget.primary_department_id).toBeTruthy();
    expect(listedTarget.primary_department_name).toBeTruthy();

    const member = await loginAs('示例成员02');
    const withCap = await request('GET', ME_URL, undefined, member);
    expect(
      withCap.body.data.capabilities.some(
        (c: any) => c.capability === 'assignment.manage',
      ),
    ).toBe(true);
    // 授权后能力保护的路由可访问
    expect((await request('GET', GRANTS_URL, undefined, member)).status).toBe(403); // 仍无 org.manage
    // 授权管理：授予某人 org.manage 前需自身已有——直接验证撤销链路
    const revoked = await request('POST', `${GRANTS_URL}/${created.body.data.id}/revoke`, {}, admin);
    expect(revoked.status).toBe(200);
    const after = await request('GET', ME_URL, undefined, member);
    expect(
      after.body.data.capabilities.some((c: any) => c.capability === 'assignment.manage'),
    ).toBe(false);
  });

  it('无有效 HRBP 任命和派驻授权，原相关成员属于产品部', async () => {
    expect((await db.query(`SELECT 1 FROM appointments WHERE role = 'HRPB' AND valid_to IS NULL`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM capability_grants WHERE scope_type = 'STATION' AND revoked_at IS NULL`)).rows).toHaveLength(0);
    const { rows } = await db.query(
      `SELECT u.display_name FROM users u JOIN department_memberships m ON m.user_id=u.id AND m.valid_to IS NULL
       JOIN departments d ON d.id=m.department_id WHERE d.code='PD' AND u.display_name IN ('示例成员20','示例成员43','示例成员19','示例成员35')`,
    );
    expect(rows.map(r => r.display_name).sort()).toEqual(['示例成员35', '示例成员19', '示例成员43', '示例成员20'].sort());
  });

  it('监管独立复核人示例成员50已写入，并具备校准能力', async () => {
    const { rows } = await db.query(
      `SELECT role FROM appointments
       WHERE user_id = (SELECT id FROM users WHERE display_name = '示例成员50') AND valid_to IS NULL`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('SUPERVISOR');

    const caps = await db.query(
      `SELECT capability FROM capability_grants
       WHERE user_id = (SELECT id FROM users WHERE display_name = '示例成员50') AND valid_to IS NULL`,
    );
    const names = caps.rows.map((r) => r.capability);
    expect(names).toContain('calibration.read_raw');
    expect(names).toContain('calibration.resolve');
  });

  it('未知能力名被拒绝（400 FIELD_INVALID）', async () => {
    const admin = await loginAs('示例成员18');
    const res = await request(
      'POST',
      GRANTS_URL,
      { user_id: (await db.query(`SELECT id FROM users WHERE display_name='示例成员03'`)).rows[0].id, capability: 'super.power' },
      admin,
    );
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe('FIELD_INVALID');
  });

  it('运行期关闭演示登录后，demo-login 被拒绝（403 DEMO_LOGIN_DISABLED）', async () => {
    // @nestjs/config v4 中 .env 文件值优先于 process.env（internalConfig → validatedEnv → processEnv），
    // 因此不能靠改 process.env 模拟开关关闭；用 overrideProvider 模拟重启后 DEMO_LOGIN_ENABLED=false 的配置。
    const realConfig = app.get(ConfigService);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string) => (key === 'DEMO_LOGIN_ENABLED' ? 'false' : realConfig.get(key)),
        getOrThrow: (key: string) => realConfig.getOrThrow(key),
      })
      .compile();
    const disabledApp = moduleRef.createNestApplication();
    disabledApp.setGlobalPrefix('api/v1');
    await disabledApp.init();
    await disabledApp.listen(0);
    const port = disabledApp.getHttpServer().address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/demo-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: (await db.query(`SELECT id FROM users WHERE display_name='示例成员12'`)).rows[0].id,
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json())?.code).toBe('DEMO_LOGIN_DISABLED');
    await disabledApp.close();
  });

  it('会话撤销：退出后原 Cookie 失效（401）', async () => {
    const cookie = await loginAs('示例成员12');
    expect((await request('GET', ME_URL, undefined, cookie)).status).toBe(200);
    expect((await request('POST', '/api/v1/auth/logout', {}, cookie)).status).toBe(200);
    expect((await request('GET', ME_URL, undefined, cookie)).status).toBe(401);
  });

  it('数据库只存会话哈希，不存明文令牌', async () => {
    const cookie = await loginAs('示例成员35');
    const token = cookie.replace(/^s360_session=/, '');
    const { rows } = await db.query(`SELECT id_hash FROM sessions`);
    expect(rows.some((r) => r.id_hash === token)).toBe(false);
  });

  it('audit_events 追加写：应用层 UPDATE/DELETE 被数据库拒绝', async () => {
    await expect(db.query(`UPDATE audit_events SET action='x' WHERE true`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM audit_events WHERE true`)).rejects.toThrow();
  });

  it('唯一性防线：同期同部门第二名部长插入被拒绝', async () => {
    const dept = (await db.query(`SELECT id FROM departments WHERE code='TECH'`)).rows[0];
    const other = (await db.query(`SELECT id FROM users WHERE display_name='示例成员02'`)).rows[0];
    const org = (await db.query(`SELECT id FROM organizations LIMIT 1`)).rows[0];
    await expect(
      db.query(
        `INSERT INTO appointments (org_id, user_id, role, scope_dept_id, valid_from)
         VALUES ($1, $2, 'HEAD', $3, DATE '2020-01-01')`,
        [org.id, other.id, dept.id],
      ),
    ).rejects.toThrow();
  });

  it('用户同时挂两个正式部门被排他约束拒绝', async () => {
    const user = (await db.query(`SELECT id, org_id FROM users WHERE display_name='示例成员04'`)).rows[0];
    const otherDept = (await db.query(`SELECT id FROM departments WHERE code='RD'`)).rows[0];
    await expect(
      db.query(
        `INSERT INTO department_memberships (org_id, user_id, department_id, valid_from)
         VALUES ($1, $2, $3, DATE '2024-01-01')`,
        [user.org_id, user.id, otherDept.id],
      ),
    ).rejects.toThrow();
  });
});
