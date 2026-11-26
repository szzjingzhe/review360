/** New applications use this mapping; historical reason text is never rewritten. */
export const APPEAL_SCOPES: Readonly<Record<string, readonly string[]>> = {
  '评价结果异议': ['整体成长分析', '个人优势', '待提升方面', '成长建议', '成长趋势'],
  '评价依据异议': ['月度成果材料', '自评内容', '他评文字反馈', '其他评价依据'],
  '评价流程问题': ['评价对象分配', '评价任务', '评价提交', '评价截止与锁定', '结果发布'],
  '评价数据问题': ['成员身份信息', '部门归属', '材料记录', '评价记录', '历史周期数据'],
  '其他问题': [],
};
export const appealTypes = Object.keys(APPEAL_SCOPES);
export function scopeOptions(type: string): readonly string[] { return Object.hasOwn(APPEAL_SCOPES, type) ? APPEAL_SCOPES[type] : []; }
export function needsScope(type: string): boolean { return appealTypes.includes(type) && type !== '其他问题'; }
export function validAppealScope(type: string, scope: unknown): boolean {
  return appealTypes.includes(type) && (type === '其他问题' ? scope === '' : typeof scope === 'string' && scopeOptions(type).includes(scope));
}
export const charCount = (text: string): number => [...text.trim()].length;
export function encodeAppeal(type: string, scopes: string[], reason: string): string {
  return `【申诉类型】${type}\n【涉及范围】${type === '其他问题' ? '未指定' : scopes.join('、') || '未指定'}\n\n${reason.trim()}`;
}
/** Lenient reads preserve historical multi-select scopes and plain reasons. */
export function decodeAppeal(text: string) {
  const m = /^【申诉类型】([^\n]+)\n【涉及范围】([^\n]*)\n\n([\s\S]*)$/.exec(text);
  return m && appealTypes.includes(m[1]) ? { type: m[1], scope: m[2], reason: m[3] } : { type: '历史反馈', scope: '未记录', reason: text };
}
/** Strict writes count only the reason body toward the 500-character limit. */
export function validateAppealReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('FEEDBACK_REASON_INVALID');
  const m = /^【申诉类型】([^\n]+)\n【涉及范围】([^\n]*)\n\n([\s\S]*)$/.exec(value);
  if (!m || !appealTypes.includes(m[1])) throw new Error('FEEDBACK_TYPE_INVALID');
  if (!validAppealScope(m[1], m[1] === '其他问题' && m[2] === '未指定' ? '' : m[2])) throw new Error('FEEDBACK_SCOPE_INVALID');
  if (!charCount(m[3]) || charCount(m[3]) > 500) throw new Error('FEEDBACK_REASON_INVALID');
  return encodeAppeal(m[1], m[1] === '其他问题' ? [] : [m[2]], m[3]);
}
