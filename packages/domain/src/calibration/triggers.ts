/**
 * 核验项触发判定（PRD §8.3、技术文档 §9.3）。
 *
 * 触发条件（分数阈值为 0—100 分口径，比例只看他评）：
 *   - 本份评价加权综合分 ≥ 95 → EXCELLENT（重点抽查，不自动判错）
 *   - 本份评价加权综合分 ≥ 90 → HIGH_TOTAL（进入高分核验）
 *   - 任一指标 < 60            → LOW_SCORE（纳入低分核验，需事实/事例说明）
 *   - 有效他评 ≥ 4 且 ≥90 分占比 > 50% → HIGH_RATIO（比例复核，不自动降分）
 *
 * 不在此处判定的项：
 *   - 「任一指标 ≥ 90」只是提交门槛（需 30 字理由），由提交流程保证，不建核验项
 *   - MANUAL_FLAG 由人工显式发起
 *
 * 阈值来源：ruleset.config_json.score（high_bp / excellent_bp / low_bp）与
 * ratio（threshold_pct / min_reviews）。本模块只接收已解析的数值，不读配置。
 */

export type CalibrationReasonCode =
  | 'HIGH_TOTAL'
  | 'EXCELLENT'
  | 'LOW_SCORE'
  | 'HIGH_RATIO'
  | 'MISSING_REASON'
  | 'MANUAL_FLAG';

export const CALIBRATION_REASON_CODES: readonly CalibrationReasonCode[] = [
  'HIGH_TOTAL',
  'EXCELLENT',
  'LOW_SCORE',
  'HIGH_RATIO',
  'MISSING_REASON',
  'MANUAL_FLAG',
];

export interface CalibrationThresholds {
  /** 高分阈值（基点），默认 9000 */
  highBp: number;
  /** 重点抽查阈值（基点），默认 9500 */
  excellentBp: number;
  /** 低分阈值（指标分，0—100），默认 60 */
  lowScore: number;
  /** 比例复核阈值（百分比整数），默认 50 */
  ratioThresholdPct: number;
  /** 比例复核最少份数，默认 4 */
  ratioMinReviews: number;
}

export const DEFAULT_THRESHOLDS: CalibrationThresholds = {
  highBp: 9000,
  excellentBp: 9500,
  lowScore: 60,
  ratioThresholdPct: 50,
  ratioMinReviews: 4,
};

export interface CalibrationTriggerInput {
  includeItemExcellent?: boolean;
  /** 本份评价的加权综合分（基点） */
  scoreBp: number;
  /** 本份评价的指标分（0—100） */
  itemScores: ReadonlyArray<{ itemId: string; score: number }>;
  /** 含本次在内，该评价人在本周期已有效提交的他评份数 */
  reviewerCyclePeerCount: number;
  /** 上述份数中综合分 ≥ highBp 的份数（含本次） */
  reviewerCycleHighCount: number;
  thresholds?: Partial<CalibrationThresholds>;
}

export interface CalibrationTrigger {
  reasonCode: CalibrationReasonCode;
  /** 触发事实的可读说明，落库供核验人员判断，不含评价人身份 */
  detail: string;
}

/**
 * 返回该份评分需要建立的核验项。空数组表示无需核验。
 * 综合分同时满足 ≥95 与 ≥90 时只取 EXCELLENT，避免同一事实建两条冗余记录。
 */
export function detectCalibrationTriggers(input: CalibrationTriggerInput): CalibrationTrigger[] {
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const triggers: CalibrationTrigger[] = [];

  if (input.scoreBp >= t.excellentBp || (input.includeItemExcellent!==false && input.itemScores.some(item => item.score * 100 >= t.excellentBp))) {
    triggers.push({
      reasonCode: 'EXCELLENT',
      detail: `综合分或单项评分达到 ${t.excellentBp / 100} 分线，需说明超出正常要求的表现`,
    });
  } else if (input.scoreBp >= t.highBp) {
    triggers.push({
      reasonCode: 'HIGH_TOTAL',
      detail: `综合分 ${(input.scoreBp / 100).toFixed(2)} 达到 ${t.highBp / 100} 分线`,
    });
  }

  const lowItems = input.itemScores.filter((it) => it.score < t.lowScore);
  if (lowItems.length > 0) {
    triggers.push({
      reasonCode: 'LOW_SCORE',
      detail: `以下指标低于 ${t.lowScore} 分：${lowItems
        .map((it) => `${it.itemId}=${it.score}`)
        .join('、')}`,
    });
  }

  // 比例复核：含本次在内，严格大于阈值才触发（2/4 = 50% 不触发）
  if (
    input.reviewerCyclePeerCount >= t.ratioMinReviews &&
    input.reviewerCycleHighCount * 100 > input.reviewerCyclePeerCount * t.ratioThresholdPct
  ) {
    triggers.push({
      reasonCode: 'HIGH_RATIO',
      detail: `本周期有效他评 ${input.reviewerCyclePeerCount} 份中 ${input.reviewerCycleHighCount} 份达到 ${t.highBp / 100} 分线，超过 ${t.ratioThresholdPct}%`,
    });
  }

  return triggers;
}
