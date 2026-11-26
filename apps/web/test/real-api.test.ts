import { afterEach, describe, expect, it, vi } from 'vitest';
import { realApi, realUserName } from '../src/api/real';
import { itemAllowed, WORKSPACES } from '../src/lib/workspaces';
import { requestId } from '../src/lib/requestId';

function mockServer(routes: Record<string, unknown>) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url}`;
    if (!(key in routes)) throw new Error(`Unexpected request: ${key}`);
    return new Response(JSON.stringify({ data: routes[key] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

it('HTTP-compatible request IDs retain cryptographic randomness and UUID v4 format',()=>{
  const values=Array.from({length:30},()=>requestId());
  expect(new Set(values).size).toBe(values.length);
  for(const value of values)expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

describe('真实接口与页面数据契约', () => {
  it('周期列表保留真实参评计数，不用空的详情数组替代人数',async()=>{
    mockServer({'GET /api/v1/cycles':[{id:'c',month:'2026-10-01',participant_count:43}]});
    expect((await realApi.listCycles())[0].participantCount).toBe(43);
  });
  it('组织页面读取正式名录，演示登录单独使用演示接口',async()=>{
    const fetcher=mockServer({'GET /api/v1/organization/members':[{id:'member',display_name:'正式成员',org_id:'org',dept_id:'dept',dept_name:'研发部',roles:['HEAD']}],
      'GET /api/v1/auth/demo-users':[{id:'demo',display_name:'仅本地演示',roles:[],capabilities:[]}]});
    expect(await realApi.listUsers()).toEqual([{id:'member',displayName:'正式成员',orgId:'org',deptId:'dept',deptName:'研发部',roles:['HEAD'],capabilities:[]}]);
    expect(fetcher).toHaveBeenCalledTimes(1);expect((await realApi.listDemoUsers())[0].id).toBe('demo');
  });
  it('规则导航使用后端已有的 org.manage 能力', () => {
    const nav = WORKSPACES.flatMap(w => w.items).find(item => item.to === '/management/rules')!;
    expect(itemAllowed(nav, { roles: [], capabilities: ['org.manage'] })).toBe(true);
    expect(itemAllowed(nav, { roles: [], capabilities: [] })).toBe(false);
  });

  it('结果导航按读取权限开放，不把审批权限当作读取权限', () => {
    const nav = WORKSPACES.flatMap(w => w.items).find(item => item.to === '/management/archives')!;
    expect(itemAllowed(nav, { roles: [], capabilities: ['result.read_published'] })).toBe(true);
    expect(itemAllowed(nav, { roles: [], capabilities: ['result.confirm'] })).toBe(false);
  });

  it('规则详情保留服务端角色、指标和数值权重', async () => {
    mockServer({ 'GET /api/v1/rulesets/rules-1': {
      id: 'rules-1', version: 3, status: 'FROZEN',
      templates: [{ role_code: 'SELF', name: '自评模板', items: [{ code: 'reflection', label: '反思', weight: '100' }] }],
    } });
    const rules = await realApi.getRuleset('rules-1');
    expect(rules.templateCount).toBe(1);
    expect(rules.templates[0]).toEqual({ roleCode: 'SELF', roleLabel: '自评模板', items: [{ id: 'reflection', label: '反思', weight: 100 }] });
  });

  it('审批发送明确决策，响应不会覆盖列表已有分数与维度', async () => {
    const fetcher = mockServer({ 'POST /api/v1/result-builds/build-1/approve': { id: 'build-1', status: 'APPROVED', decision: 'APPROVED' } });
    const updated = await realApi.approveBuild('build-1');
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ decision: 'APPROVED' });
    expect(updated).not.toHaveProperty('dimensionJson');
    expect(updated).not.toHaveProperty('exactScore');
    expect(updated.status).toBe('APPROVED');
  });

  it('审批列表保留维度并解析被评价人姓名', async () => {
    const dimensions = { peerItems: [{ itemId: 'quality', avgScore: 80 }], selfItems: [], peerCount: 4, selfPresent: false };
    mockServer({ 'GET /api/v1/cycles/cycle-real/result-builds': [{ id: 'build-1', cycle_id: 'cycle-real', target_id: 'member-1', target_name: '成员甲', status: 'BUILT', exact_score: '80', dimension_json: dimensions }] });
    const [build] = await realApi.listResultBuilds('cycle-real');
    expect(build.cycleId).toBe('cycle-real');
    expect(build.dimensionJson).toEqual(dimensions);
    expect(realUserName('member-1')).toBe('成员甲');
  });

  it('评价期首次进入自评会创建并读取表单', async () => {
    const fetcher = mockServer({
      'GET /api/v1/cycles/cycle-real/assignments/me': { cycle: { status: 'REVIEWING' }, self: { reviewId: null } },
      'POST /api/v1/cycles/cycle-real/self-review': { reviewId: 'self-1' },
      'GET /api/v1/reviews/self-1': { review: { id: 'self-1', cycleId: 'cycle-real', kind: 'SELF', status: 'DRAFT' }, template: { items: [] } },
    });
    expect((await realApi.getSelfReview('member-1', 'cycle-real'))?.id).toBe('self-1');
    expect(fetcher.mock.calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'GET /api/v1/cycles/cycle-real/assignments/me', 'POST /api/v1/cycles/cycle-real/self-review', 'GET /api/v1/reviews/self-1',
    ]);
  });

  it('已关闭周期读取已有自评，不创建新记录', async () => {
    const fetcher = mockServer({
      'GET /api/v1/cycles/closed/assignments/me': { cycle: { status: 'CALIBRATING' }, self: { reviewId: 'self-old' } },
      'GET /api/v1/reviews/self-old': { review: { id: 'self-old', kind: 'SELF', status: 'SUBMITTED' }, template: { items: [] } },
    });
    expect((await realApi.getSelfReview('member-1', 'closed'))?.id).toBe('self-old');
    expect(fetcher.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it.each(['DRAFT', 'CALIBRATING', 'PUBLISHED'])('%s 周期没有自评时不发创建请求', async status => {
    const fetcher = mockServer({ 'GET /api/v1/cycles/cycle-real/assignments/me': { cycle: { status }, self: { reviewId: null } } });
    expect(await realApi.getSelfReview('member-1', 'cycle-real')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('开期使用预检返回的真实 run id，待开期状态可重试', async () => {
    const fetcher = mockServer({
      'GET /api/v1/cycles/cycle-real': { id: 'cycle-real', status: 'PENDING_OPEN' },
      'POST /api/v1/cycles/cycle-real/assignment/preview': { id: 'run-real', feasible: true },
      'POST /api/v1/cycles/cycle-real/open': { edge_count: 4 },
    });
    const preview = await realApi.previewCycle('cycle-real');
    await realApi.confirmAssignment('cycle-real',preview[0].id);
    const open = fetcher.mock.calls.find(([url]) => url.endsWith('/open'))!;
    expect(JSON.parse(open[1].body as string)).toEqual({ run_id: 'run-real' });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/submit'))).toBe(false);
  });
  it('核验按真实嵌套字段显示姓名、触发原因和分数；处置后保留上下文',async()=>{
    mockServer({'GET /api/v1/calibration-cases?page=1&page_size=100&cycle_id=cycle-real':[{id:'case-real',cycle:{id:'cycle-real'},reasonCode:'HIGH_TOTAL',detail:'高分核验',status:'OPEN',target:{id:'target-real',displayName:'被评价人'},source:{scoreBp:9200,reviewer:{id:'reviewer-real',displayName:'评价人'}}}],
      'POST /api/v1/calibration-cases/case-real/actions':{id:'case-real',status:'OPEN',action:'VOID_REQUEST'}});
    const [item]=await realApi.listCalibrationCases('cycle-real');expect(item).toMatchObject({trigger:'HIGH_TOTAL',reason:'高分核验',totalScore:92,targetId:'target-real'});
    expect(realUserName('target-real')).toBe('被评价人');
    expect(await realApi.takeCalibrationAction('case-real','VOID_REQUEST','申请核验','actor')).toMatchObject({status:'OPEN',totalScore:92,targetId:'target-real',resolvedAction:'VOID_REQUEST'});
  });
  it('两端入口授权不自动包含组织设置或评分身份权限',()=>{
    const ctx={capabilities:['management.access','progress.read','assignment.manage'],roles:['HEAD']};
    expect(WORKSPACES.filter(w=>w.items.some(i=>itemAllowed(i,ctx))).map(w=>w.key)).toEqual(['personal','oversight']);
    const raw=WORKSPACES.flatMap(w=>w.items).find(i=>i.to==='/management/archives')!;
    const rules=WORKSPACES.flatMap(w=>w.items).find(i=>i.to==='/management/rules')!;
    expect(itemAllowed(raw,ctx)).toBe(false);expect(itemAllowed(rules,ctx)).toBe(false);
  });

  it('服务端拒绝创建时保留错误，不回退到模拟自评', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { cycle: { status: 'REVIEWING' }, self: { reviewId: null } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'NOT_CYCLE_PARTICIPANT' }), { status: 403 })));
    await expect(realApi.getSelfReview('supervisor', 'cycle-real')).rejects.toThrow('NOT_CYCLE_PARTICIPANT');
  });

  it('退出登录撤销服务端会话', async () => {
    const fetcher = mockServer({ 'POST /api/v1/auth/logout': { ok: true } });
    await realApi.logout();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].credentials).toBe('include');
  });
});
