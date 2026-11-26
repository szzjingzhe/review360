/**
 * 更正修订守卫（PRD §8.1、§9.1）。
 *
 * 规则链：
 *  - PRD §9.1：核验**不提供直接覆盖原始分**，更正必须由**原评价人**形成修订版；
 *  - PRD §8.1：管理员退回的评分需有**单独的修订截止时间**与版本记录；
 *  - 利益冲突：本人不得参与与自己结果相关的处置。
 *
 * 纯函数：api 在提交修订版前调用，前端可用同一口径决定是否展示"提交修订版"入口。
 */

import type { CalibrationAction } from './actions.js';

/** 修订窗口（小时）：核验提出更正/补充后，原评价人可提交修订版的时限。可按运营确认调整。 */
export const REVISION_WINDOW_HOURS = 48;

/** 最新动作是否在"等原评价人处理"（建议更正 / 退回补充） */
export function isRevisionRequested(latestAction: string | null | undefined): boolean {
  const wanted: CalibrationAction[] = ['SUGGEST_REVISION', 'REQUEST_SUPPLEMENT'];
  return !!latestAction && (wanted as string[]).includes(latestAction);
}

export interface RevisionSubmissionContext {
  /** 该核验项最新一次动作 */
  latestAction: string | null | undefined;
  /** 修订截止时间；未设置则不校验时限 */
  dueAt: string | Date | null | undefined;
  now: string | Date;
  actorId: string;
  /** 原评分作者 */
  reviewerId: string;
  /** 被评价人 */
  targetId: string;
  kind?: 'SELF' | 'PEER';
}

export type RevisionBlockReason =
  | 'REVISION_NOT_REQUESTED'
  | 'NOT_ORIGINAL_REVIEWER'
  | 'SELF_CONFLICT'
  | 'REVISION_WINDOW_CLOSED';

/** 返回阻止原因；null 表示允许提交修订版（能力校验由 authz 层负责） */
export function checkRevisionSubmission(ctx: RevisionSubmissionContext): RevisionBlockReason | null {
  if (!isRevisionRequested(ctx.latestAction)) return 'REVISION_NOT_REQUESTED';
  if (ctx.actorId === ctx.targetId && ctx.kind !== 'SELF') return 'SELF_CONFLICT';
  if (ctx.actorId !== ctx.reviewerId) return 'NOT_ORIGINAL_REVIEWER';
  if (ctx.dueAt) {
    const due = ctx.dueAt instanceof Date ? ctx.dueAt : new Date(ctx.dueAt);
    const now = ctx.now instanceof Date ? ctx.now : new Date(ctx.now);
    if (!Number.isNaN(due.getTime()) && now.getTime() > due.getTime()) return 'REVISION_WINDOW_CLOSED';
  }
  return null;
}

/** 修订截止时间 = 基准时间 + 窗口小时数 */
export function revisionDueAt(from: Date, hours: number = REVISION_WINDOW_HOURS): Date {
  return new Date(from.getTime() + hours * 3_600_000);
}
