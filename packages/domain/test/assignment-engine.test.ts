import { describe, expect, it } from 'vitest';
import { generateAssignment, ALGORITHM_VERSION } from '../src/assignment/engine.js';
import type { Participant } from '../src/assignment/types.js';

/** 当前规则 fixture：44 名部门人员、1 位独立监管，不含 HRBP 专项角色。 */
function buildDefaultFixture(): Participant[] {
  const participants: Participant[] = [];
  const departments: Array<[string, string, number]> = [
    ['PD', '产品部', 8],
    ['TECH', '科技部', 8],
    ['RD', '研发部', 8],
    ['ECO', '生态部', 8],
    ['NET', '网监部', 7],
  ];

  for (const [deptCode, deptName, memberCount] of departments) {
    const headId = `${deptCode}-HEAD`;
    participants.push({ userId: headId, deptId: deptCode, role: 'HEAD', displayName: `${deptName}部长` });
    for (let i = 1; i <= memberCount; i++) {
      const userId = `${deptCode}-M${i}`;
      participants.push({ userId, deptId: deptCode, role: 'MEMBER', displayName: `${deptName}成员${i}` });
    }
  }

  // 独立监管
  participants.push({ userId: 'SUPER-1', deptId: 'PD', role: 'SUPERVISOR', displayName: '监管' });
  return participants;
}

describe('评审分配器（技术文档 §7）', () => {
  it('单人部门的部长在不人工指定时可由其他部门补足他评', () => {
    const participants = [...buildDefaultFixture(), {userId:'TC-HEAD',deptId:'TC',role:'HEAD' as const,displayName:'教学事务委员会部长'}];
    const result = generateAssignment({participants, history:[], avoidPairs:[], seed:'2026-11'});
    expect(result.feasible).toBe(true);
    expect(result.indegrees['TC-HEAD']).toBeGreaterThanOrEqual(4);
    expect(result.edges.some(e=>e.targetId==='TC-HEAD' && e.sourceType==='PEER_CROSS_DEPT')).toBe(true);
    expect(result.edges.every(e=>e.reviewerId!==e.targetId)).toBe(true);
    expect(Math.max(...Object.values(result.outdegrees))).toBeLessThanOrEqual(5);
  });
  it('人工关系优先保留，自动补足不产生重复或超额，变更关系使预览摘要失效',()=>{
    const participants=buildDefaultFixture();
    const base={participants,history:[],avoidPairs:[],seed:'2026-10'};
    const manualEdges=[{reviewerId:'PD-M1',targetId:'PD-M8'},{reviewerId:'TECH-M2',targetId:'TECH-M5'}];
    const r=generateAssignment({...base,manualEdges});
    expect(r.feasible).toBe(true);
    for(const edge of manualEdges)expect(r.edges.filter(e=>e.reviewerId===edge.reviewerId&&e.targetId===edge.targetId)).toEqual([{...edge,sourceType:'MANUAL',isFixed:true}]);
    expect(Math.max(...Object.values(r.outdegrees))).toBeLessThanOrEqual(5);
    expect(Math.max(...Object.values(r.indegrees))).toBeLessThanOrEqual(5);
    expect(r.inputHash).not.toBe(generateAssignment(base).inputHash);
    expect(r.inputHash).toBe(generateAssignment({...base,manualEdges:[...manualEdges].reverse()}).inputHash);
  });
  it('非法、本人及重复人工关系不能正式生效',()=>{
    const base={participants:buildDefaultFixture(),history:[],avoidPairs:[],seed:'2026-10'};
    for(const manualEdges of [[{reviewerId:'PD-M1',targetId:'PD-M1'}],[{reviewerId:'missing',targetId:'PD-M1'}],[{reviewerId:'PD-M1',targetId:'PD-M2'},{reviewerId:'PD-M1',targetId:'PD-M2'}]])expect(generateAssignment({...base,manualEdges}).feasible).toBe(false);
  });
  it('跨部门人工关系保留在生成预览中',()=>{
    const result=generateAssignment({participants:buildDefaultFixture(),history:[],avoidPairs:[],seed:'2026-10',manualEdges:[{reviewerId:'PD-M1',targetId:'TECH-M1'}]});
    expect(result.edges.filter(e=>e.reviewerId==='PD-M1'&&e.targetId==='TECH-M1')).toEqual([{reviewerId:'PD-M1',targetId:'TECH-M1',sourceType:'MANUAL',isFixed:true}]);
  });
  it('默认 44 人 fixture 可生成可行分配，任务数在合理区间', () => {
    const participants = buildDefaultFixture();
    const result = generateAssignment({
      participants,
      history: [],
      avoidPairs: [],
      seed: '2026-01',
      algorithmVersion: ALGORITHM_VERSION,
    });

    expect(result.feasible).toBe(true);
    // 44 个目标各收 4–5 份评价，任务总数应在同一量级。
    expect(result.edges.length).toBeGreaterThanOrEqual(185);
    expect(result.edges.length).toBeLessThanOrEqual(200);

    // 每位普通成员/部长入度 4-5
    for (const p of participants) {
      if (p.role === 'SUPERVISOR') continue;
      const d = result.indegrees[p.userId];
      expect(d).toBeGreaterThanOrEqual(4);
      expect(d).toBeLessThanOrEqual(5);
    }

    // 无自环、无重复边
    const seen = new Set<string>();
    for (const e of result.edges) {
      expect(e.reviewerId).not.toBe(e.targetId);
      expect(seen.has(`${e.reviewerId}->${e.targetId}`)).toBe(false);
      seen.add(`${e.reviewerId}->${e.targetId}`);
    }
  });

  it('相同输入与 seed 得到相同输出（确定性）', () => {
    const participants = buildDefaultFixture();
    const args = { participants, history: [], avoidPairs: [] as Array<[string, string]>, seed: '2026-01' };
    const a = generateAssignment(args);
    const b = generateAssignment(args);
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.edges).toEqual(b.edges);
  });

  it('连续 12 个月轮换：动态边集合随月份变化，固定边保持稳定', () => {
    const participants = buildDefaultFixture();
    const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);

    let prevDynamic = new Set<string>();
    let prevFixed = new Set<string>();
    for (const month of months) {
      const result = generateAssignment({
        participants,
        history: [],
        avoidPairs: [],
        seed: month,
        algorithmVersion: ALGORITHM_VERSION,
      });
      expect(result.feasible).toBe(true);

      const dynamic = new Set(
        result.edges.filter((e) => !e.isFixed).map((e) => `${e.reviewerId}->${e.targetId}`),
      );
      const fixed = new Set(result.edges.filter((e) => e.isFixed).map((e) => `${e.reviewerId}->${e.targetId}`));

      // 固定边业务上必须稳定（部长评价全部直属成员）
      if (prevFixed.size > 0) {
        expect([...fixed].every((k) => prevFixed.has(k))).toBe(true);
      }

      // 动态边允许在部门内轮换；新规则以每位评价人最多 5 个任务为优先约束，
      // 因而不再要求每月动态边集合低于 50% 重叠。
      if (prevDynamic.size > 0) {
        const overlap = [...dynamic].filter((k) => prevDynamic.has(k)).length;
        expect(overlap).toBeLessThan(dynamic.size);
      }

      prevDynamic = dynamic;
      prevFixed = fixed;
    }
  });

  it('历史重复边在候选足够时被降权（动态边重复率 < 50%）', () => {
    const participants = buildDefaultFixture();
    const base = generateAssignment({ participants, history: [], avoidPairs: [], seed: '2026-01' });
    const history = base.edges
      .filter((e) => !e.isFixed)
      .map((e) => ({ cycleMonth: '2026-01', reviewerId: e.reviewerId, targetId: e.targetId }));
    const next = generateAssignment({ participants, history, avoidPairs: [], seed: '2026-02' });

    const historySet = new Set(history.map((h) => `${h.reviewerId}->${h.targetId}`));
    const nextDynamic = next.edges.filter((e) => !e.isFixed);
    const repeated = nextDynamic.filter((e) => historySet.has(`${e.reviewerId}->${e.targetId}`)).length;
    expect(repeated).toBeLessThan(nextDynamic.length / 2);
  });

  it('回避名单：回避对之间不产生边', () => {
    const participants = buildDefaultFixture();
    const a = 'TECH-M1';
    const b = 'TECH-M2';
    const result = generateAssignment({
      participants,
      history: [],
      avoidPairs: [[a, b]],
      seed: '2026-01',
      algorithmVersion: ALGORITHM_VERSION,
    });
    for (const e of result.edges) {
      const pair = `${e.reviewerId}->${e.targetId}`;
      expect(pair).not.toBe(`${a}->${b}`);
      expect(pair).not.toBe(`${b}->${a}`);
    }
  });

  it('取消 HRBP 专项后只生成普通成员、部长、监管和同级评价来源', () => {
    const participants = buildDefaultFixture();
    const result = generateAssignment({
      participants,
      history: [],
      avoidPairs: [],
      seed: '2026-01',
      algorithmVersion: ALGORITHM_VERSION,
    });
    expect(result.feasible).toBe(true);

    expect(result.edges.every((e) => !e.sourceType.includes('HRPB'))).toBe(true);
    for (const p of participants.filter((p) => p.role !== 'SUPERVISOR')) {
      expect(result.indegrees[p.userId]).toBeGreaterThanOrEqual(4);
      expect(result.indegrees[p.userId]).toBeLessThanOrEqual(5);
    }

    // 监管不被评价（不进入被评价池）
    expect(result.indegrees['SUPER-1']).toBe(0);
  });
});
