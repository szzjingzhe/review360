/**
 * 核验动作与状态机（PRD §9.1、技术文档 §9.3）。
 *
 * 核心原则：
 *   - 核验不自动扣分；不提供「直接覆盖原始分」，更正必须由原评价人形成修订版
 *   - 本人、原评分作者不得处置／批准自身相关的核验项（利益冲突）
 *   - 作废需与申请人不同的第二名独立人员批准，并配套替补计划
 *   - RESOLVED / DISMISSED 为终态，之后只能读取
 */

export type CalibrationAction =
  | 'CONFIRM'           // 依据有效
  | 'REQUEST_SUPPLEMENT' // 退回补充（等原评价人补充材料/理由）
  | 'SUGGEST_REVISION'   // 建议更正（等原评价人在受控窗口提交修订版）
  | 'VOID_REQUEST'       // 提出作废申请
  | 'VOID_APPROVE'       // 批准作废（需与申请人不同）
  | 'VOID_REJECT'        // 驳回作废申请
  | 'DISMISS'            // 关闭核验项（无需处理）
  | 'REVISION_SUBMITTED'; // 系统记录：原评价人已提交修订版（不由用户直接调用）

export type CalibrationCaseStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

/** 可由用户调用的核验动作（REVISION_SUBMITTED 由提交修订版的路径自动记录，不在此列） */
export const CALIBRATION_ACTIONS: readonly CalibrationAction[] = [
  'CONFIRM',
  'REQUEST_SUPPLEMENT',
  'SUGGEST_REVISION',
  'VOID_REQUEST',
  'VOID_APPROVE',
  'VOID_REJECT',
  'DISMISS',
];

/** 动作 → 处置后的 case 状态。终态动作关闭核验项。 */
const ACTION_RESULT_STATUS: Record<CalibrationAction, CalibrationCaseStatus> = {
  CONFIRM: 'RESOLVED',
  REQUEST_SUPPLEMENT: 'OPEN',
  SUGGEST_REVISION: 'OPEN',
  VOID_REQUEST: 'OPEN',
  VOID_APPROVE: 'RESOLVED',
  VOID_REJECT: 'RESOLVED',
  DISMISS: 'DISMISSED',
  // 修订版已提交 → 针对"旧版本"的这个核验项结案；新版本若仍触发会重新开项
  REVISION_SUBMITTED: 'RESOLVED',
};

export function isCalibrationAction(value: string): value is CalibrationAction {
  return (CALIBRATION_ACTIONS as readonly string[]).includes(value);
}

export function statusAfterAction(action: CalibrationAction): CalibrationCaseStatus {
  return ACTION_RESULT_STATUS[action];
}

export interface CalibrationActorContext {
  actorId: string;
  /** 核验对象（被评价人） */
  targetId: string;
  /** 原评分作者 */
  reviewerId: string;
  /** 该核验项当前状态 */
  caseStatus: CalibrationCaseStatus;
  /** 已存在的作废申请人（仅 VOID_REQUEST 后存在） */
  voidRequestedBy?: string | null;
}

export type ConflictReason = 'CASE_FINAL' | 'SELF_CONFLICT' | 'AUTHOR_CONFLICT' | 'SAME_APPROVER' | 'VOID_REQUEST_REQUIRED';

/** 返回冲突原因；null 表示允许操作（能力校验由 authz 层另行负责）。 */
export function checkCalibrationActor(
  ctx: CalibrationActorContext,
  action: CalibrationAction,
): ConflictReason | null {
  if (ctx.caseStatus !== 'OPEN') return 'CASE_FINAL';
  // 本人不得处置与自己结果相关的核验项
  if (ctx.actorId === ctx.targetId) return 'SELF_CONFLICT';
  // 原评分作者不得处置自己的评分
  if (ctx.actorId === ctx.reviewerId) return 'AUTHOR_CONFLICT';
  if ((action==='VOID_APPROVE'||action==='VOID_REJECT') && !ctx.voidRequestedBy) return 'VOID_REQUEST_REQUIRED';
  // 作废必须由提出人之外的第二人批准
  if (action === 'VOID_APPROVE' && ctx.voidRequestedBy && ctx.voidRequestedBy === ctx.actorId) {
    return 'SAME_APPROVER';
  }
  return null;
}
