/** Submission requirements are independent of calibration thresholds.
 *  现行口径：75—95 分（含）区间视为常态分，理由选填；低于 75 分或高于 95 分必须说明理由。 */
export const ITEM_REASON_RULES = { lowExclusive: 75, highInclusive: 96, minChars: 30 } as const;
export type ItemReasonRules = { lowExclusive: number; highInclusive: number; minChars: number; mode?:'legacy'|'prd'; overallMinChars?:number; lowOverallMinChars?:number; lowScore?:number };
/** 理由选填的分数区间（闭区间），供界面文案使用。 */
export function reasonFreeRange(rules: ItemReasonRules = ITEM_REASON_RULES): { min: number; max: number } {
  return { min: rules.lowExclusive, max: rules.highInclusive - 1 };
}
export function meaningfulTextLength(value:string|null|undefined):number {
  return [...String(value??'')].filter(char=>/[\p{L}\p{N}]/u.test(char)).length;
}
export function codePointLength(value: string | null | undefined): number {
  return [...String(value ?? '').trim()].length;
}
export function requiresItemReason(score: number | null, rules: ItemReasonRules = ITEM_REASON_RULES): boolean {
  return score !== null && Number.isInteger(score) && score >= 0 && score <= 100
    && (score < rules.lowExclusive || score >= rules.highInclusive);
}
export function itemReasonError(score: number | null, reason: string | null | undefined, rules: ItemReasonRules = ITEM_REASON_RULES): string {
  const count = rules.mode==='prd'?meaningfulTextLength(reason):codePointLength(reason);
  if(!requiresItemReason(score, rules) || count >= rules.minChars) return '';
  const range = reasonFreeRange(rules);
  const where = range.max < range.min ? '' : `（${range.min}—${range.max} 分可不填）`;
  return `该项评分 ${score} 分，需填写至少 ${rules.minChars} 字具体理由${where}，当前 ${count} 字。`;
}
