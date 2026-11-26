import { describe, it, expect } from 'vitest';
import { aggregateReport } from '../src/report.js';

describe('aggregateReport (M6 月报统计)', () => {
  it('按百分制阈值分桶并计算组织均分 / 部门汇总', () => {
    // final_score 为百分制（M4 exact_score = round(score_bp)/100）。
    const rows = [
      { deptId: 'd1', deptName: '研发中心', finalScore: 96 },
      { deptId: 'd1', deptName: '研发中心', finalScore: 92 },
      { deptId: 'd2', deptName: '产品部', finalScore: 88 },
      { deptId: 'd2', deptName: '产品部', finalScore: 55 },
    ];
    const r = aggregateReport(rows);
    expect(r.distribution).toEqual({ excellent: 1, good: 1, qualified: 1, low: 1 });
    expect(r.avgScore).toBe(83); // round((96+92+88+55)/4)
    expect(r.departments).toHaveLength(2);
    const d1 = r.departments.find((d) => d.deptId === 'd1')!;
    expect(d1.count).toBe(2);
    expect(d1.maxScore).toBe(96);
    expect(d1.minScore).toBe(92);
    expect(d1.avgScore).toBe(94);
  });

  it('空输入返回全零与空部门', () => {
    const r = aggregateReport([]);
    expect(r.avgScore).toBe(0);
    expect(r.departments).toHaveLength(0);
    expect(r.distribution).toEqual({ excellent: 0, good: 0, qualified: 0, low: 0 });
  });

  it('部门按均分降序排列', () => {
    const rows = [
      { deptId: 'd1', deptName: 'A', finalScore: 70 },
      { deptId: 'd2', deptName: 'B', finalScore: 95 },
    ];
    const r = aggregateReport(rows);
    expect(r.departments[0].deptId).toBe('d2');
  });

  it('边界值：90 与 60 归入正确档位', () => {
    const rows = [
      { deptId: 'x', deptName: 'X', finalScore: 90 }, // good（>=GOOD 且 <EXCELLENT）
      { deptId: 'x', deptName: 'X', finalScore: 60 }, // qualified（>=QUALIFIED 且 <GOOD）
    ];
    const r = aggregateReport(rows);
    expect(r.distribution.good).toBe(1);
    expect(r.distribution.qualified).toBe(1);
  });
});
