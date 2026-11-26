/**
 * 结果构建（技术文档 §10）。
 *
 * 新结果公式：有效他评算术平均。
 *   - 个人最终分 = 所有有效他评综合分的算术平均；自评单列
 *   - 自评必须与他评一起完成，且保留自评/他评分项明细
 *   - 结果指标分对同一 item_id 取平均；跨模板周期只展示各期结果，不合并同名指标
 *
 * 纯函数：不碰数据库、不看时钟，全部输入显式传入，便于单测与重算复现。
 */

import { createHash } from 'node:crypto';

export const RESULT_FORMULA_VERSION = 'equal_weight_peer_avg_self_separate@v2.0';

/** 一份有效评分（已提交 revision）。scoreBp 为基点整数（0—10000，90 分 = 9000）。 */
export interface ResultSourceReview {
  revisionId: string;
  scoreBp: number;
  /** 指标明细，score 为 0—100 整数分 */
  items: ReadonlyArray<{ itemId: string; score: number }>;
}

export interface ResultBuildInput {
  cycleId: string;
  targetId: string;
  /** ruleset 冻结时的 checksum，参与 input_hash，规则变更即重算 */
  rulesetChecksum: string;
  /** 分配版本号，替补/改派后变化 */
  assignmentVersion: number;
  /** 报告锁定版本；无材料要求时为 null */
  reportVersionId: string | null;
  /** 合并反馈版本；无反馈时为 0 */
  feedbackVersion: number;
  /** 有效他评，顺序无关（内部排序后再计算，保证确定性） */
  peers: ReadonlyArray<ResultSourceReview>;
  /** 自评；未提交时为 null */
  self: ResultSourceReview | null;
  /** 最少他评份数（来自 ruleset ratio.min_reviews），仅用于告警，不做完整性判定 */
  minReviews?: number;
  formulaVersion?: string;
}

export interface ResultItemAverage {
  itemId: string;
  /** 该指标在有效他评中的平均分（0—100，保留 4 位小数） */
  avgScore: number;
  /** 参与该指标平均的评分数 */
  count: number;
}

export interface ResultDraftBuild {
  /** 最终分：有效他评算术平均（0—100，4 位小数） */
  exactScore: number | null;
  /** 自评综合分（0—100，4 位小数）；无自评时为 null */
  selfScore: number | null;
  dimensionJson: {
    peerItems: ResultItemAverage[];
    selfItems: ResultItemAverage[];
    peerCount: number;
    selfPresent: boolean;
  };
  /** 本次构建全部输入与来源 revision 的确定性摘要 */
  inputHash: string;
  /** 参与构建的 revision，按 revisionId 升序，供 result_source_reviews 落库 */
  sourceRevisionIds: string[];
  formulaVersion: string;
  /** 非阻断告警，供服务层决定是否仍允许构建 */
  warnings: string[];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 对 items 按 itemId 求平均，输出按 itemId 升序，保证确定性 */
function averageItems(
  sources: ReadonlyArray<ResultSourceReview>,
): ResultItemAverage[] {
  const acc = new Map<string, { sum: number; count: number }>();
  for (const s of sources) {
    for (const it of s.items) {
      const cur = acc.get(it.itemId) ?? { sum: 0, count: 0 };
      cur.sum += it.score;
      cur.count += 1;
      acc.set(it.itemId, cur);
    }
  }
  return [...acc.entries()]
    .map(([itemId, { sum, count }]) => ({
      itemId,
      avgScore: round4(sum / count),
      count,
    }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

/**
 * 构建结果草稿。不判完整性——「任务未齐不得发布」由服务层结合 assignments 判定，
 * 这里只在份数不足最少要求时给出告警。
 */
export function buildResult(input: ResultBuildInput): ResultDraftBuild {
  const formulaVersion = input.formulaVersion ?? RESULT_FORMULA_VERSION;
  if (formulaVersion !== RESULT_FORMULA_VERSION) throw new Error('RESULT_FORMULA_UNSUPPORTED');
  const warnings: string[] = [];

  // 排序：同一组输入无论调用顺序如何，hash 与结果都一致
  const peers = [...input.peers].sort((a, b) =>
    a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0,
  );

  if(peers.some(p=>!Number.isInteger(p.scoreBp)||p.scoreBp<0||p.scoreBp>10000))throw new Error('RESULT_SOURCE_INVALID');
  if (peers.length === 0) warnings.push('NO_PEER_REVIEWS');
  if (!input.self) warnings.push('NO_SELF_REVIEW');
  if (input.minReviews !== undefined && peers.length > 0 && peers.length < input.minReviews) {
    warnings.push('BELOW_MIN_REVIEWS');
  }

  // 他评等权平均：先以基点求和再除，避免逐项浮点累加误差
  const selfScore = input.self ? round4(input.self.scoreBp / 100) : null;
  const exactScore = peers.length ? Math.round(peers.reduce((sum,p)=>sum+p.scoreBp,0)*100/peers.length)/10000 : null;

  const sourceRevisionIds = [
    ...peers.map((p) => p.revisionId),
    ...(input.self ? [input.self.revisionId] : []),
  ].sort();

  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        formulaVersion,
        cycleId: input.cycleId,
        targetId: input.targetId,
        rulesetChecksum: input.rulesetChecksum,
        assignmentVersion: input.assignmentVersion,
        reportVersionId: input.reportVersionId,
        feedbackVersion: input.feedbackVersion,
        peers: peers.map((p) => [p.revisionId, p.scoreBp, [...p.items].sort((a,b)=>a.itemId.localeCompare(b.itemId))]),
        self: input.self ? [input.self.revisionId, input.self.scoreBp, [...input.self.items].sort((a,b)=>a.itemId.localeCompare(b.itemId))] : null,
      }),
    )
    .digest('hex');

  return {
    exactScore,
    selfScore,
    dimensionJson: {
      peerItems: averageItems(peers),
      selfItems: input.self ? averageItems([input.self]) : [],
      peerCount: peers.length,
      selfPresent: input.self !== null,
    },
    inputHash,
    sourceRevisionIds,
    formulaVersion,
    warnings,
  };
}
