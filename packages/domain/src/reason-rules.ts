import { ITEM_REASON_RULES, requiresItemReason, codePointLength, meaningfulTextLength } from './item-reasons.js';
export { ITEM_REASON_RULES, requiresItemReason, itemReasonError } from './item-reasons.js';
/** Calibration thresholds remain configurable; submission reasons use ITEM_REASON_RULES independently. */
export interface ReasonThresholds {
  policy: 'legacy'|'prd';
  /** 高分线（基点，9000 = 90 分） */
  highBp: number;
  /** 重点抽查线（基点，9500 = 95 分） */
  excellentBp: number;
  /** 低分线（基点，6000 = 60 分） */
  lowBp: number;
  /** 单项理由最少字数 */
  itemMinChars: number;
  /** 整体说明最少字数 */
  overallMinChars: number;
  lowOverallMinChars: number;
  /** 高分比例阈值（百分比，> 该值触发） */
  ratioThresholdPct: number;
  /** 触发比例规则所需的最少有效他评份数 */
  ratioMinReviews: number;
}

export const DEFAULT_REASON_THRESHOLDS: ReasonThresholds = {
  policy:'legacy',
  highBp: 9000,
  excellentBp: 9500,
  lowBp: 6000,
  itemMinChars: 30,
  overallMinChars: 50,
  lowOverallMinChars: 30,
  ratioThresholdPct: 50,
  ratioMinReviews: 4,
};

/** 从规则集 config_json 解析阈值；缺失字段回落默认值（兼容早期规则集） */
export function parseReasonThresholds(config: unknown): ReasonThresholds {
  const cfg = (config ?? {}) as {
    score?: { high_bp?: number; excellent_bp?: number; low_bp?: number };
    reasons?: { item_min_chars?: number; overall_min_chars?: number; low_overall_min_chars?:number; policy?:string };
    ratio?: { threshold_pct?: number; min_reviews?: number };
  };
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    policy:cfg.reasons?.policy==='prd_v1'?'prd':'legacy',
    highBp: num(cfg.score?.high_bp, DEFAULT_REASON_THRESHOLDS.highBp),
    excellentBp: num(cfg.score?.excellent_bp, DEFAULT_REASON_THRESHOLDS.excellentBp),
    lowBp: num(cfg.score?.low_bp, DEFAULT_REASON_THRESHOLDS.lowBp),
    itemMinChars: num(cfg.reasons?.item_min_chars, DEFAULT_REASON_THRESHOLDS.itemMinChars),
    overallMinChars: num(cfg.reasons?.overall_min_chars, DEFAULT_REASON_THRESHOLDS.overallMinChars),
    lowOverallMinChars: num(cfg.reasons?.low_overall_min_chars, DEFAULT_REASON_THRESHOLDS.lowOverallMinChars),
    ratioThresholdPct: num(cfg.ratio?.threshold_pct, DEFAULT_REASON_THRESHOLDS.ratioThresholdPct),
    ratioMinReviews: num(cfg.ratio?.min_reviews, DEFAULT_REASON_THRESHOLDS.ratioMinReviews),
  };
}

export interface ReasonRuleItem {
  itemId: string;
  /** 0—100 的整数 */
  score: number;
  reason?: string | null;
}

export interface ReasonRuleInput {
  kind: 'SELF' | 'PEER';
  items: ReasonRuleItem[];
  overallReason?: string | null;
  /** 本份评价的加权综合分（基点，0—10000） */
  scoreBp: number;
  /**
   * **含本次拟提交记录**的评价人本周期有效他评综合分（基点）。
   * 仅他评参与高分比例规则；自评应传空数组。
   */
  peerScoreBpIncludingThis?: number[];
}

export type ReasonViolationCode =
  | 'HIGH_ITEM_REASON_REQUIRED'
  | 'LOW_ITEM_REASON_REQUIRED'
  | 'OVERALL_STATEMENT_REQUIRED'
  | 'HIGH_RATIO_STATEMENT_REQUIRED';

export interface ReasonViolation {
  code: ReasonViolationCode;
  /** 单项类违规带指标 id */
  itemId?: string;
  requiredChars: number;
  actualChars: number;
  detail: string;
}

export { codePointLength } from './item-reasons.js';

/** Apply the current per-item submission policy without changing calibration thresholds. */
export function validateSubmitReasons(
  input: ReasonRuleInput,
  thresholds: ReasonThresholds = DEFAULT_REASON_THRESHOLDS,
): ReasonViolation[] {
  if(thresholds.policy==='prd'){
    const violations:ReasonViolation[]=[];
    const free={min:thresholds.lowBp/100,max:thresholds.highBp/100-1};
    for(const item of input.items){
      const count=meaningfulTextLength(item.reason);
      const bp=item.score*100;
      if(count>=thresholds.itemMinChars)continue;
      if(bp>=thresholds.highBp){
        violations.push({code:'HIGH_ITEM_REASON_REQUIRED',itemId:item.itemId,requiredChars:thresholds.itemMinChars,actualChars:count,
          detail:`该项评分 ${item.score} 分（高于 ${free.max} 分），需填写至少 ${thresholds.itemMinChars} 字具体理由（当前 ${count} 字）`});
      }else if(bp<thresholds.lowBp){
        violations.push({code:'LOW_ITEM_REASON_REQUIRED',itemId:item.itemId,requiredChars:thresholds.itemMinChars,actualChars:count,
          detail:`该项评分 ${item.score} 分（低于 ${free.min} 分），需填写至少 ${thresholds.itemMinChars} 字具体理由（当前 ${count} 字）`});
      }
    }
    const overall=meaningfulTextLength(input.overallReason);
    const required=input.scoreBp>=thresholds.highBp?thresholds.overallMinChars:0;
    if(required&&overall<required)violations.push({code:'OVERALL_STATEMENT_REQUIRED',requiredChars:required,actualChars:overall,detail:`整体评价说明至少 ${required} 字`});
    return violations;
  }
  return input.items.flatMap(item => {
    if (!requiresItemReason(item.score)) return [];
    const actualChars = codePointLength(item.reason);
    if (actualChars >= ITEM_REASON_RULES.minChars) return [];
    return [{code: item.score < ITEM_REASON_RULES.lowExclusive ? 'LOW_ITEM_REASON_REQUIRED' as const : 'HIGH_ITEM_REASON_REQUIRED' as const,
      itemId: item.itemId, requiredChars: ITEM_REASON_RULES.minChars, actualChars,
      detail: `指标得分 ${item.score} 分，需填写至少 ${ITEM_REASON_RULES.minChars} 字具体理由（当前 ${actualChars} 字）`}];
  });
}
