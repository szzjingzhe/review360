import { describe, expect, it } from 'vitest';
import {
  buildResult,
  RESULT_FORMULA_VERSION,
  type ResultBuildInput,
  type ResultSourceReview,
} from '../src/results/build.js';

function peer(id: string, scoreBp: number, items: Array<[string, number]> = []): ResultSourceReview {
  return { revisionId: id, scoreBp, items: items.map(([itemId, score]) => ({ itemId, score })) };
}

function baseInput(over: Partial<ResultBuildInput> = {}): ResultBuildInput {
  return {
    cycleId: 'cyc-1',
    targetId: 'u-1',
    rulesetChecksum: 'checksum-abc',
    assignmentVersion: 1,
    reportVersionId: null,
    feedbackVersion: 0,
    peers: [],
    self: null,
    ...over,
  };
}

describe('M4.1 结果构建（有效他评算术平均，自评单列）', () => {
	it('最终分仅按有效他评平均计算', () => {
    const out = buildResult(
      baseInput({
        peers: [peer('r1', 8600), peer('r2', 9000), peer('r3', 8800), peer('r4', 9200)],
        self: peer('s1', 9500),
        minReviews: 4,
      }),
    );

	    expect(out.exactScore).toBe(89);
    expect(out.selfScore).toBe(95);
    expect(out.dimensionJson.peerCount).toBe(4);
    expect(out.dimensionJson.selfPresent).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(out.formulaVersion).toBe(RESULT_FORMULA_VERSION);
  });

	  it('他评等权平均保留 4 位小数，且不因顺序改变结果', () => {
	    const self = peer('s1', 8200);
	    const a = buildResult(baseInput({ peers: [peer('r1', 8100), peer('r2', 8200), peer('r3', 8300)], self }));
	    const b = buildResult(baseInput({ peers: [peer('r3', 8300), peer('r1', 8100), peer('r2', 8200)], self }));
    expect(a.exactScore).toBe(82);
    expect(b.exactScore).toBe(82);
    expect(a.inputHash).toBe(b.inputHash);
  });

  it('非整除时四舍五入到 4 位小数（基点 8550+8600+8601）', () => {
	    const out = buildResult(baseInput({ peers: [peer('r1', 8550), peer('r2', 8600), peer('r3', 8601)], self: peer('s1', 8550) }));
	    // 先对全部基点求和，再一次性舍入为百分制4位小数。
	    expect(out.exactScore).toBe(85.8367);
  });

  it('无有效他评：exactScore 为 null 且告警 NO_PEER_REVIEWS', () => {
	    const out = buildResult(baseInput({ self: peer('s1', 9000) }));
    expect(out.exactScore).toBeNull();
    expect(out.selfScore).toBe(90);
    expect(out.warnings).toContain('NO_PEER_REVIEWS');
    expect(out.sourceRevisionIds).toEqual(['s1']);
  });

  it('无自评：selfScore 为 null 且告警 NO_SELF_REVIEW', () => {
	    const out = buildResult(baseInput({ peers: [peer('r1', 8800)], self: null }));
    expect(out.selfScore).toBeNull();
    expect(out.warnings).toContain('NO_SELF_REVIEW');
    expect(out.dimensionJson.selfPresent).toBe(false);
    expect(out.dimensionJson.selfItems).toEqual([]);
  });

  it('份数低于 ruleset 最少要求时告警 BELOW_MIN_REVIEWS（不阻断构建）', () => {
	    const out = buildResult(baseInput({ peers: [peer('r1', 8800), peer('r2', 8900)], self: peer('s1', 8800), minReviews: 4 }));
    expect(out.warnings).toContain('BELOW_MIN_REVIEWS');
	    expect(out.exactScore).toBe(88.5);
  });

  it('指标分对同一 item_id 取平均，输出按 itemId 升序', () => {
    const out = buildResult(
      baseInput({
        peers: [
          peer('r1', 8800, [['growth', 80], ['delivery', 90]]),
          peer('r2', 9000, [['growth', 100], ['delivery', 80]]),
        ],
        self: peer('s1', 9500, [['growth', 90]]),
      }),
    );
    expect(out.dimensionJson.peerItems).toEqual([
      { itemId: 'delivery', avgScore: 85, count: 2 },
      { itemId: 'growth', avgScore: 90, count: 2 },
    ]);
    expect(out.dimensionJson.selfItems).toEqual([{ itemId: 'growth', avgScore: 90, count: 1 }]);
  });

  it('input_hash 对任一输入敏感：分数、报告版本、分配版本、反馈版本、规则校验和', () => {
    const base = buildResult(baseInput({ peers: [peer('r1', 8800)] }));
    const variants: ResultBuildInput[] = [
      baseInput({ peers: [peer('r1', 8801)] }),
      baseInput({ peers: [peer('r2', 8800)] }),
      baseInput({ peers: [peer('r1', 8800)], reportVersionId: 'rep-2' }),
      baseInput({ peers: [peer('r1', 8800)], assignmentVersion: 2 }),
      baseInput({ peers: [peer('r1', 8800)], feedbackVersion: 1 }),
      baseInput({ peers: [peer('r1', 8800)], rulesetChecksum: 'other' }),
      baseInput({ peers: [peer('r1', 8800)], cycleId: 'cyc-2' }),
      baseInput({ peers: [peer('r1', 8800)], targetId: 'u-2' }),
    ];
    for (const v of variants) {
      expect(buildResult(v).inputHash).not.toBe(base.inputHash);
    }
  });

  it('自评缺失与存在时 hash 不同（自评不参与计分但参与来源快照）', () => {
    const noSelf = buildResult(baseInput({ peers: [peer('r1', 8800)] }));
    const withSelf = buildResult(baseInput({ peers: [peer('r1', 8800)], self: peer('s1', 9500) }));
    expect(noSelf.inputHash).not.toBe(withSelf.inputHash);
  });

  it('sourceRevisionIds 汇总他评与自评并按 revisionId 升序', () => {
    const out = buildResult(
      baseInput({
        peers: [peer('r3', 8800), peer('r1', 8900)],
        self: peer('s2', 9000),
      }),
    );
    expect(out.sourceRevisionIds).toEqual(['r1', 'r3', 's2']);
  });

  it('input_hash 为 64 位十六进制', () => {
    const out = buildResult(baseInput({ peers: [peer('r1', 8800)] }));
    expect(out.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changing self score never changes final score',()=>{
    for(const score of [0,6000,9500,10000])expect(buildResult(baseInput({peers:[peer('r1',8600),peer('r2',9000),peer('r3',8800),peer('r4',9200)],self:peer('s',score)})).exactScore).toBe(89);
    expect(buildResult(baseInput({peers:[peer('r',8800)]})).exactScore).toBe(88);
  });
  it('cannot create new results with a historical formula label',()=>{
    expect(()=>buildResult(baseInput({formulaVersion:'self30_peer70_same_group@v1.0-m5'}))).toThrow('RESULT_FORMULA_UNSUPPORTED');
  });

});
