import type { FeedbackFilter, FeedbackRecord } from '../contracts/feedback';

const closedStates = new Set(['DONE', 'REJECTED', 'REREVIEW_DONE', 'REREVIEW_REJECTED']);
export function feedbackState(status: string): FeedbackFilter | 'other' {
  return status === 'PENDING' ? 'pending' : status === 'REREVIEW_PENDING' ? 'rereview' : closedStates.has(status) ? 'closed' : 'other';
}
export function feedbackStatus(status: string): string {
  return ({ PENDING: '待处理', DONE: '已办结', REJECTED: '已驳回', REREVIEW_PENDING: '待复核',
    REREVIEW_DONE: '二次申诉成立', REREVIEW_REJECTED: '维持原结论' } as Record<string, string>)[status] ?? `历史状态：${status}`;
}
export function isRereview(record: FeedbackRecord): boolean {
  return record.status.startsWith('REREVIEW_') || !!record.rereviewOpenedAt;
}
export function feedbackStage(record: FeedbackRecord): string { return isRereview(record) ? '二次复核' : '首次申诉'; }
export function feedbackTitle(record: FeedbackRecord): string { return `${record.cycleMonth || '历史周期'} 评价结果申诉`; }
export function feedbackTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
export function filterFeedback(records: FeedbackRecord[], options: { cycle: string; query: string; state: FeedbackFilter; stage: string; sort: string }): FeedbackRecord[] {
  const query = options.query.trim().toLocaleLowerCase();
  return records.filter(record => (!options.cycle || record.cycleId === options.cycle)
    && (options.state === 'all' || feedbackState(record.status) === options.state)
    && (options.stage === 'all' || isRereview(record) === (options.stage === 'rereview'))
    && (!query || [record.applicantName, record.departmentName, record.reason, record.rereviewReason, record.id]
      .some(value => value?.toLocaleLowerCase().includes(query))))
    .sort((a, b) => (options.sort === 'asc' ? 1 : -1) * a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function feedbackError(error: unknown): string {
  const e = error as { code?: string; status?: number; message?: string };
  if (e.status === 401) return '登录已过期，请重新登录后继续。';
  if (e.status === 403) return '当前账号没有执行此操作的权限。';
  if (e.status === 409) return '该申诉状态已变化，请刷新后查看最新处理结果。';
  if (e.status === 404) return '申诉记录不存在或当前账号无法访问。';
  if (e.status && e.status >= 500) return '服务暂不可用，请稍后重试；本次操作未确认成功。';
  if (e.code === 'FIELD_INVALID') return '处理信息不完整，请填写处理意见后重试。';
  return e.message && !/^(HTTP_|Failed to fetch|fetch failed|NetworkError)/.test(e.message)
    ? e.message : '服务暂不可用，请检查网络后重试。';
}
