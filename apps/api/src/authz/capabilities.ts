/**
 * 系统能力清单（技术文档 4.3）。
 * capability 是系统权限，与部长/监管等业务职责分离：
 * 业务职责由组织数据决定，能否操作对应功能必须显式授权。
 */
export const CAPABILITIES = [
  'management.access',
  'result.read_aggregate', // Formal aggregates without reviewer identity.
  'growth.manage',
  'workspace.oversight',   // Workspace entry only; never authorizes raw data or management operations.
  'workspace.department',  // 部长工作台入口（部门管理端）；可由组织授权给非部长成员，隐含 progress.read
  'cycle.manage',          // 周期配置与开期
  'assignment.manage',     // 分配调整与替补
  'assignment.read',       // 已生效评价关系的独立只读授权
  'progress.read',         // 材料与提交进度
  'reminder.send',         // 催办
  'calibration.read_raw',  // 原始评分读取（含评价人身份，最强能力，最小授权）
  'calibration.resolve',   // 核验处置
  'result.read_published', // Published aggregate results only, never reviewer identities or reasons.
  'result.confirm',        // 结果确认
  'result.publish',        // 结果发布
  'award.manage',         // 内部评优
  'feedback.manage',     // 反馈申诉处理
  'report.view',        // 月报/组织洞察查看
  'org.manage',           // 组织与规则写入、授权管理
  'audit.export',         // 审计事件报表导出（CSV/PDF）
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** capability → scope 展开：由服务端按组织、部门或周期解析范围 */
export type ScopeType = 'ORG' | 'DEPARTMENT' | 'STATION' | 'CYCLE';
