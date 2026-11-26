/** Shared fixtures: high/low item reasons need at least 100 Unicode code points. */
export const ITEM_REASON_OK =
  '本月在专业学习与任务推进上均有具体产出，交付了可核查的成果并主动复盘，理由充分。'.repeat(3);

/** 81 个码点（≥50，满足高分整体说明要求） */
export const OVERALL_STATEMENT_OK =
  '整体来看，本期在关键任务上的完成质量稳定，跨部门协作沟通顺畅，遇到问题时能主动暴露并推动解决；' +
  '下一阶段建议在方案前置论证和时间管理上继续加强，保持当前的交付节奏。';

/** 明确不足 30 字的短理由，用于"应当被拒绝"的负向用例 */
export const SHORT_REASON = '表现不错';

/** 明确不足 50 字的短整体说明，用于"应当被拒绝"的负向用例 */
export const SHORT_OVERALL = '整体还行';
