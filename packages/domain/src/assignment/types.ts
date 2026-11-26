/** 参与者主身份。HRBP 专项角色已取消，产品部相关人员按普通 MEMBER 参与。 */
export type Role = 'HEAD' | 'SUPERVISOR' | 'MEMBER' | 'EXTERNAL';

export interface Participant {
  userId: string;
  deptId: string;
  displayName?: string;
  role: Role;
}

export interface HistoryEdge {
  cycleMonth: string;
  reviewerId: string;
  targetId: string;
}

export interface Edge {
  reviewerId: string;
  targetId: string;
  sourceType:
    | 'HEAD_TO_MEMBER'
    | 'HEAD_LOOP'
    | 'MEMBER_TO_HEAD'
    | 'PEER_SAME_DEPT'
    | 'PEER_CROSS_DEPT'
    | 'SUPERVISOR'
    | 'MANUAL'
    | 'REPLACEMENT';
  isFixed: boolean;
}

/** 入度缺口的原因码，供界面把“为什么补不满”讲清楚。 */
export type AssignmentShortfallReason =
  /** 该部门可参与评价的人太少（含目标本人只剩一人或无人）。 */
  | 'INSUFFICIENT_CANDIDATES'
  /** 候选评价人的出度已到上限，组织整体评价容量不足。 */
  | 'REVIEWER_CAPACITY'
  /** 目标所在部门只有本人，只能依赖跨部门补足。 */
  | 'SINGLE_MEMBER_DEPARTMENT'
  /** 其他原因（含历史回避、重复关系等）。 */
  | 'OTHER';

export interface AssignmentShortfall {
  targetId: string;
  targetName?: string;
  deptId: string;
  indegree: number;
  minIndegree: number;
  missing: number;
}

export interface AssignmentResult {
  feasible: boolean;
  /** 若不可行，列出冲突/缺口的诊断信息 */
  diagnostics: string[];
  /** 结构化缺口：姓名、部门、当前他评数、缺少数量、原因 */
  shortfalls: Array<AssignmentShortfall & { reason: AssignmentShortfallReason }>;
  edges: Edge[];
  /** 每个目标的入度统计 */
  indegrees: Record<string, number>;
  /** 每个评价人的出度统计 */
  outdegrees: Record<string, number>;
  seed: string;
  algorithmVersion: string;
  inputHash: string;
}

export interface AssignmentInput {
  /** Already authorized and validated by the server; inserted before automatic edges. */
  manualEdges?: Array<{reviewerId:string;targetId:string}>;
  participants: Participant[];
  history: HistoryEdge[];
  avoidPairs: Array<[string, string]>;
  seed: string;
  algorithmVersion?: string;
}
