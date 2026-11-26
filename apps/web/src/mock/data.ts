/**
 * 360° 环评系统 —— 前端静态模拟数据层。
 * 不依赖真实后端：所有页面打开即渲染此处数据，交互通过 mock/api.ts 模拟异步写入。
 * 数据量充足、贴合业务场景，覆盖 组织/部门/用户/规则集/周期/分配/评价/核验/结果/发布/评优/反馈。
 */

export interface Department { id: string; name: string }
export interface User {
  id: string;
  displayName: string;
  isGuidance?: boolean;
  isResultViewer?: boolean;
  orgId: string;
  deptId: string;
  deptName: string;
  roles: string[];          // 主角色快照：HEAD / HRPB / MEMBER / SUPERVISOR / UPWARD
  capabilities: string[];   // calibration.resolve / result.confirm / result.publish / award.manage ...
}
export interface RuleItem { id: string; label: string; weight: number }
export interface RuleTemplate { roleCode: string; roleLabel: string; items: RuleItem[] }
export interface Ruleset {
  id: string; name: string; status: 'FROZEN' | 'ACTIVE' | 'RETIRED';
  templateCount: number; templates: RuleTemplate[];
}

export interface CycleParticipant { userId: string; role: string }
export interface Assignment {
  id: string; cycleId: string; sourceType: string;
  reviewerId: string; targetId: string; status: 'ACTIVE' | 'REPLACED';
}
export interface ReviewItem { itemId: string; label: string; score: number | null; reason: string }
export interface Review {
  id: string; cycleId: string; assignmentId: string;
  kind: 'PEER' | 'SELF'; reviewerId: string; targetId: string;
  status: 'DRAFT' | 'SUBMITTED';
  template: { roleCode: string; items: RuleItem[] };
  // nextPlan 对应后端 draft 的 nextPlan（下月行动计划）；自评用，他评可留空
  draft: { items: ReviewItem[]; overallReason: string; comment: string; nextPlan?: string; readConfirmed: boolean };
  revision: { scoreBp: number; items: ReviewItem[]; submittedAt: string } | null;
  /**
   * 核验要求原评价人更正/退回补充时的受控修订请求（真实后端返回；mock 不模拟该流程）。
   * 有值且未过期时，评价页展示「提交修订版」入口。
   */
  revisionRequest?: {
    caseId: string;
    dueAt: string | null;
    latestAction: string | null;
    reason: string | null;
    expired: boolean;
  } | null;
}
export interface CalibrationCase {
  id: string; cycleId: string; trigger: string;
  status: 'OPEN' | 'RESOLVED'; targetId: string; reviewerId: string; reviewId: string;
  reason: string; totalScore: number; ratioPct?: number; peerCount?: number;
  createdAt: string; resolvedBy?: string; resolvedAction?: string; resolvedAt?: string;
}
export interface ResultBuild {
  id: string; cycleId: string; targetId: string;
  status: 'BUILT' | 'APPROVED' | 'PUBLISHED' | 'STALE';
  exactScore: number | null; dimensionJson: { peerItems: {itemId:string; avgScore:number}[]; selfItems: {itemId:string; avgScore:number}[]; peerCount: number; selfPresent: boolean };
  inputHash: string;
}
export interface PublishedResult {
  id: string; cycleId: string; targetId: string; publicationVersion: number;
  payloadJson: {
    month: string; final_score: number | null;
    peer_items: { label: string; avg_score: number }[];
    self_items: { label: string; avg_score: number }[];
    peer_count: number; self_present: boolean; formula_version: string;
  };
}
export interface AwardCandidate {
  userId: string; displayName: string; deptName: string;
  finalScore: number; cycleId: string; month: string; level: '优秀' | '良好' | '待定';
}
export type AwardDecisionValue = 'AWARDED' | 'NOMINATED' | 'NONE';
export interface AwardDecision {
  id: string; cycleId: string; targetId: string; category: string;
  decision: AwardDecisionValue; reason: string | null; createdAt: string;
}
export interface FeedbackRequest {
  id: string; cycleId: string; targetId: string; reason: string; createdAt: string;
  status: 'PENDING' | 'DONE' | 'REJECTED' | 'REREVIEW_PENDING' | 'REREVIEW_DONE' | 'REREVIEW_REJECTED';
  handlerNote?: string;
  rereviewReason?: string;
  rereviewOpenedAt?: string;
}
export interface Cycle {
  participantCount?: number;
  id: string; month: string; title: string; status: string;
  openAt: string; closeAt: string; selfCloseAt?: string; publishAt: string; rulesetId: string;
  phase: 'CLOSE' | 'PUBLISH';
  participants: CycleParticipant[]; assignments: Assignment[]; reviews: Review[];
  calibrationCases: CalibrationCase[]; resultBuilds: ResultBuild[];
  publishedResults: PublishedResult[];
}

export interface DepartmentProgressMember {
  userId: string;
  displayName: string;
  roleSnapshot: string | null;
  selfStatus: 'SUBMITTED' | 'DRAFT' | 'NOT_STARTED';
  peerExpected: number;
  peerReceived: number;
  /** 材料状态：READY=已上传且可预览；PROCESSING=已上传待校验；MISSING=未上传 */
  materialStatus?: 'READY' | 'PROCESSING' | 'MISSING';
  materialCount?: number;
}

/** 部门级进度聚合（后端 GET /cycles/:id/departments/:deptId/progress） */
export interface DepartmentProgress {
  cycleId: string;
  departmentId: string;
  departmentCode: string | null;
  departmentName: string | null;
  memberCount: number;
  selfDone: number;
  peerReceived: number;
  peerExpected: number;
  missingSelf: { userId: string; displayName: string }[];
  /** 月度成果（材料）流程尚未接入对象存储，后端显式标记不可用 */
  materialsAvailable: boolean;
  materialsSubmitted: number | null;
  members: DepartmentProgressMember[];
}

export const currentOrg = { id: 'org-360', name: '示例组织' };

export const departments: Department[] = [
  { id: 'dept-rd', name: '研发中心' },
  { id: 'dept-pd', name: '产品部' },
  { id: 'dept-hr', name: '人力资源部' },
  { id: 'dept-mkt', name: '市场部' },
  { id: 'dept-fin', name: '财务部' },
];

export const users: User[] = [
  { id: 'u-admin', displayName: '示例成员01', orgId: currentOrg.id, deptId: 'dept-hr', deptName: '人力资源部', roles: ['HRPB'], capabilities: ['calibration.read_raw', 'calibration.resolve', 'result.confirm', 'result.publish', 'award.manage', 'cycle.manage', 'assignment.manage', 'org.manage', 'progress.read', 'feedback.manage', 'report.view', 'audit.export'] },
  { id: 'u-super', displayName: '陈志强', orgId: currentOrg.id, deptId: 'dept-rd', deptName: '研发中心', roles: ['SUPERVISOR'], capabilities: ['calibration.read_raw', 'calibration.resolve', 'result.confirm', 'result.publish', 'report.view'] },
  { id: 'u-head-rd', displayName: '王建国', orgId: currentOrg.id, deptId: 'dept-rd', deptName: '研发中心', roles: ['HEAD'], capabilities: ['calibration.resolve', 'progress.read'] },
  { id: 'u-head-pd', displayName: '李雪', orgId: currentOrg.id, deptId: 'dept-pd', deptName: '产品部', roles: ['HEAD'], capabilities: ['calibration.resolve', 'progress.read'] },
  { id: 'u-hrpb2', displayName: '赵敏', orgId: currentOrg.id, deptId: 'dept-hr', deptName: '人力资源部', roles: ['HRPB'], capabilities: ['calibration.resolve', 'progress.read', 'feedback.manage', 'report.view'] },
  { id: 'u-m1', displayName: '张伟', orgId: currentOrg.id, deptId: 'dept-rd', deptName: '研发中心', roles: ['MEMBER'], capabilities: [] },
  { id: 'u-m2', displayName: '刘洋', orgId: currentOrg.id, deptId: 'dept-rd', deptName: '研发中心', roles: ['MEMBER'], capabilities: [] },
  { id: 'u-m3', displayName: '孙磊', orgId: currentOrg.id, deptId: 'dept-pd', deptName: '产品部', roles: ['MEMBER'], capabilities: [] },
  { id: 'u-m4', displayName: '周婷', orgId: currentOrg.id, deptId: 'dept-pd', deptName: '产品部', roles: ['MEMBER'], capabilities: [] },
  { id: 'u-m5', displayName: '吴昊', orgId: currentOrg.id, deptId: 'dept-mkt', deptName: '市场部', roles: ['MEMBER'], capabilities: [] },
  { id: 'u-m6', displayName: '郑爽', orgId: currentOrg.id, deptId: 'dept-fin', deptName: '财务部', roles: ['MEMBER'], capabilities: [] },
  { id: 'u-up', displayName: '马涛', orgId: currentOrg.id, deptId: 'dept-rd', deptName: '研发中心', roles: ['UPWARD'], capabilities: [] },
];

const RD = users.filter((u) => u.deptId === 'dept-rd').map((u) => u.id);
const PD = users.filter((u) => u.deptId === 'dept-pd').map((u) => u.id);
const MKT = users.filter((u) => u.deptId === 'dept-mkt').map((u) => u.id);

export const defaultRuleset: Ruleset = {
  id: 'rs-default', name: '2026 年度 360 综合考评规则集', status: 'FROZEN', templateCount: 6,
  templates: [
    {
      roleCode: 'HEAD', roleLabel: '上级评价（部门负责人）',
      items: [
        { id: 'h1', label: '目标达成与执行力', weight: 30 },
        { id: 'h2', label: '专业能力与决策质量', weight: 25 },
        { id: 'h3', label: '团队管理与培养', weight: 25 },
        { id: 'h4', label: '跨部门协同', weight: 20 },
      ],
    },
    {
      roleCode: 'HRPB', roleLabel: 'HRBP 派驻评价',
      items: [
        { id: 'b1', label: '价值观与文化契合', weight: 30 },
        { id: 'b2', label: '制度遵从与合规', weight: 25 },
        { id: 'b3', label: '人才发展贡献', weight: 25 },
        { id: 'b4', label: '组织氛围感知', weight: 20 },
      ],
    },
    {
      roleCode: 'MEMBER', roleLabel: '同事（平级）评价',
      items: [
        { id: 'm1', label: '协作配合度', weight: 30 },
        { id: 'm2', label: '专业支持质量', weight: 25 },
        { id: 'm3', label: '沟通与响应', weight: 25 },
        { id: 'm4', label: '责任感', weight: 20 },
      ],
    },
    {
      roleCode: 'SUPERVISOR', roleLabel: '监管条线评价',
      items: [
        { id: 's1', label: '风险与合规意识', weight: 35 },
        { id: 's2', label: '制度执行一致性', weight: 35 },
        { id: 's3', label: '重大问题上报', weight: 30 },
      ],
    },
    {
      roleCode: 'UPWARD', roleLabel: '下评上',
      items: [
        { id: 'u1', label: '领导方向与赋能', weight: 30 },
        { id: 'u2', label: '决策透明与公正', weight: 30 },
        { id: 'u3', label: '倾听与反馈', weight: 20 },
        { id: 'u4', label: '资源支持', weight: 20 },
      ],
    },
    {
      roleCode: 'SELF', roleLabel: '自我述职评价',
      items: [
        { id: 'sf1', label: '年度目标达成', weight: 30 },
        { id: 'sf2', label: '能力成长', weight: 25 },
        { id: 'sf3', label: '不足与改进', weight: 25 },
        { id: 'sf4', label: '下阶段规划', weight: 20 },
      ],
    },
  ],
};

export const rulesets: Ruleset[] = [
  defaultRuleset,
  { id: 'rs-2025', name: '2025 年度 360 综合考评规则集', status: 'RETIRED', templateCount: 5, templates: defaultRuleset.templates.slice(0, 5) },
];

// ---- 工具：构造一份含全部项的草稿 ----
function blankItems(items: RuleItem[], fill: number): ReviewItem[] {
  return items.map((it) => ({ itemId: it.id, label: it.label, score: fill, reason: '' }));
}
function scoredItems(items: RuleItem[], scores: number[]): ReviewItem[] {
  return items.map((it, i) => ({ itemId: it.id, label: it.label, score: scores[i] ?? null, reason: '依据季度实际表现评定' }));
}
function weightedBp(items: RuleItem[], scores: number[]): number {
  let w = 0, s = 0;
  items.forEach((it, i) => { w += it.weight; s += it.weight * (scores[i] ?? 0); });
  return Math.round((s / w) * 100);
}

// ---- 构造评价（含草稿/提交） ----
function makeReview(
  id: string, cycleId: string, assignmentId: string, kind: 'PEER' | 'SELF',
  reviewerId: string, targetId: string, tpl: RuleTemplate,
  submitted: boolean, scores?: number[], overall = '',
): Review {
  const items = tpl.items;
  const draftScores = scores ?? items.map(() => 80);
  const draft = {
    items: blankItems(items, submitted ? (scores ?? items.map(() => 80))[0] ?? 80 : 0).map((it, i) => ({
      ...it, score: submitted ? (scores?.[i] ?? 82) : null, reason: submitted ? '依据季度实际表现评定' : '',
    })),
    overallReason: overall || '整体表现稳定',
    comment: '',
    readConfirmed: submitted,
  };
  const revision = submitted
    ? { scoreBp: weightedBp(items, scores ?? items.map(() => 82)), items: scoredItems(items, scores ?? items.map(() => 82)), submittedAt: '2026-08-20T10:30:00' }
    : null;
  return { id, cycleId, assignmentId, kind, reviewerId, targetId, status: submitted ? 'SUBMITTED' : 'DRAFT', template: { roleCode: tpl.roleCode, items }, draft, revision };
}

const headTpl = defaultRuleset.templates[0];
const hrpbTpl = defaultRuleset.templates[1];
const memberTpl = defaultRuleset.templates[2];
const upwardTpl = defaultRuleset.templates[4];
const selfTpl = defaultRuleset.templates[5];

// ================= 周期 1：REVIEWING（进行中，有可交互评价任务） =================
const c1Assignments: Assignment[] = [
  { id: 'a1', cycleId: 'c1', sourceType: 'HEAD', reviewerId: 'u-head-rd', targetId: 'u-m1', status: 'ACTIVE' },
  { id: 'a2', cycleId: 'c1', sourceType: 'HRPB', reviewerId: 'u-admin', targetId: 'u-m1', status: 'ACTIVE' },
  { id: 'a3', cycleId: 'c1', sourceType: 'MEMBER', reviewerId: 'u-m2', targetId: 'u-m1', status: 'ACTIVE' },
  { id: 'a4', cycleId: 'c1', sourceType: 'MEMBER', reviewerId: 'u-m3', targetId: 'u-m1', status: 'ACTIVE' },
  { id: 'a5', cycleId: 'c1', sourceType: 'UPWARD', reviewerId: 'u-m1', targetId: 'u-head-rd', status: 'ACTIVE' },
  { id: 'a6', cycleId: 'c1', sourceType: 'SELF', reviewerId: 'u-m1', targetId: 'u-m1', status: 'ACTIVE' },
];
const c1Reviews: Review[] = [
  makeReview('r1', 'c1', 'a1', 'PEER', 'u-head-rd', 'u-m1', headTpl, true, [92, 88, 90, 85]),
  makeReview('r2', 'c1', 'a2', 'PEER', 'u-admin', 'u-m1', hrpbTpl, true, [88, 90, 86, 92]),
  makeReview('r3', 'c1', 'a3', 'PEER', 'u-m2', 'u-m1', memberTpl, false), // 待提交草稿
  makeReview('r4', 'c1', 'a4', 'PEER', 'u-m3', 'u-m1', memberTpl, true, [80, 78, 82, 85]),
  makeReview('r5', 'c1', 'a5', 'PEER', 'u-m1', 'u-head-rd', upwardTpl, false),
  makeReview('r6', 'c1', 'a6', 'SELF', 'u-m1', 'u-m1', selfTpl, false),
];

// ================= 周期 2：CALIBRATING（核验/审批/发布阶段） =================
const c2Assignments: Assignment[] = [
  { id: 'a21', cycleId: 'c2', sourceType: 'HEAD', reviewerId: 'u-head-pd', targetId: 'u-m3', status: 'ACTIVE' },
  { id: 'a22', cycleId: 'c2', sourceType: 'HRPB', reviewerId: 'u-hrpb2', targetId: 'u-m3', status: 'ACTIVE' },
  { id: 'a23', cycleId: 'c2', sourceType: 'MEMBER', reviewerId: 'u-m4', targetId: 'u-m3', status: 'ACTIVE' },
  { id: 'a24', cycleId: 'c2', sourceType: 'SELF', reviewerId: 'u-m3', targetId: 'u-m3', status: 'ACTIVE' },
  { id: 'a25', cycleId: 'c2', sourceType: 'HEAD', reviewerId: 'u-head-pd', targetId: 'u-m4', status: 'ACTIVE' },
  { id: 'a26', cycleId: 'c2', sourceType: 'MEMBER', reviewerId: 'u-m3', targetId: 'u-m4', status: 'ACTIVE' },
  { id: 'a27', cycleId: 'c2', sourceType: 'SELF', reviewerId: 'u-m4', targetId: 'u-m4', status: 'ACTIVE' },
];
const c2Reviews: Review[] = [
  makeReview('r21', 'c2', 'a21', 'PEER', 'u-head-pd', 'u-m3', headTpl, true, [95, 92, 88, 90]),
  makeReview('r22', 'c2', 'a22', 'PEER', 'u-hrpb2', 'u-m3', hrpbTpl, true, [90, 93, 91, 94]),
  makeReview('r23', 'c2', 'a23', 'PEER', 'u-m4', 'u-m3', memberTpl, true, [88, 85, 90, 87]),
  makeReview('r24', 'c2', 'a24', 'SELF', 'u-m3', 'u-m3', selfTpl, true, [85, 88, 82, 90]),
  makeReview('r25', 'c2', 'a25', 'PEER', 'u-head-pd', 'u-m4', headTpl, true, [70, 62, 55, 68]),
  makeReview('r26', 'c2', 'a26', 'PEER', 'u-m3', 'u-m4', memberTpl, true, [60, 55, 58, 65]),
  makeReview('r27', 'c2', 'a27', 'SELF', 'u-m4', 'u-m4', selfTpl, true, [72, 65, 60, 70]),
];
const c2Calibration: CalibrationCase[] = [
  { id: 'cc1', cycleId: 'c2', trigger: 'HIGH_TOTAL', status: 'OPEN', targetId: 'u-m3', reviewerId: 'u-head-pd', reviewId: 'r21', reason: '他评总分 91 分（≥90 优秀线）', totalScore: 91, peerCount: 3, createdAt: '2026-09-01T09:00:00' },
  { id: 'cc2', cycleId: 'c2', trigger: 'LOW_SCORE', status: 'OPEN', targetId: 'u-m4', reviewerId: 'u-head-pd', reviewId: 'r25', reason: '上级评价 63.75 分（存在指标 <60）', totalScore: 64, peerCount: 1, createdAt: '2026-09-01T09:05:00' },
  { id: 'cc3', cycleId: 'c2', trigger: 'HIGH_RATIO', status: 'RESOLVED', targetId: 'u-m3', reviewerId: 'u-m4', reviewId: 'r26', reason: '单份评分占比超阈值（评分者偏少）', totalScore: 59, ratioPct: 60, peerCount: 1, createdAt: '2026-09-01T09:10:00', resolvedBy: '示例成员01', resolvedAction: 'VOID_APPROVE', resolvedAt: '2026-09-02T14:00:00' },
];
// c2 结果构建：u-m3 已审批待发布，u-m4 构建中
const c2Builds: ResultBuild[] = [
  {
    id: 'rb1', cycleId: 'c2', targetId: 'u-m3', status: 'APPROVED', exactScore: 89.5, inputHash: 'h-m3-v1',
    dimensionJson: {
      peerItems: headTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [91, 88, 90, 90][i] }))
        .concat(hrpbTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [90, 93, 91, 94][i] })))
        .concat(memberTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [88, 85, 90, 87][i] }))),
      selfItems: selfTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [85, 88, 82, 90][i] })),
      peerCount: 3, selfPresent: true,
    },
  },
  {
    id: 'rb2', cycleId: 'c2', targetId: 'u-m4', status: 'BUILT', exactScore: 63.0, inputHash: 'h-m4-v1',
    dimensionJson: {
      peerItems: headTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [64, 62, 55, 68][i] }))
        .concat(memberTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [60, 55, 58, 65][i] }))),
      selfItems: selfTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [72, 65, 60, 70][i] })),
      peerCount: 2, selfPresent: true,
    },
  },
];

// ================= 周期 3：PUBLISHED（已发布结果） =================
const c3Assignments: Assignment[] = [
  { id: 'a31', cycleId: 'c3', sourceType: 'HEAD', reviewerId: 'u-head-rd', targetId: 'u-m2', status: 'ACTIVE' },
  { id: 'a32', cycleId: 'c3', sourceType: 'HRPB', reviewerId: 'u-admin', targetId: 'u-m2', status: 'ACTIVE' },
  { id: 'a33', cycleId: 'c3', sourceType: 'SELF', reviewerId: 'u-m2', targetId: 'u-m2', status: 'ACTIVE' },
];
const c3Reviews: Review[] = [
  makeReview('r31', 'c3', 'a31', 'PEER', 'u-head-rd', 'u-m2', headTpl, true, [90, 85, 88, 86]),
  makeReview('r32', 'c3', 'a32', 'PEER', 'u-admin', 'u-m2', hrpbTpl, true, [88, 90, 87, 85]),
  makeReview('r33', 'c3', 'a33', 'SELF', 'u-m2', 'u-m2', selfTpl, true, [82, 85, 80, 88]),
];
const c3Builds: ResultBuild[] = [
  { id: 'rb31', cycleId: 'c3', targetId: 'u-m2', status: 'PUBLISHED', exactScore: 86.5, inputHash: 'h-m2-pub', dimensionJson: {
    peerItems: headTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [90, 85, 88, 86][i] })).concat(hrpbTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [88, 90, 87, 85][i] }))),
    selfItems: selfTpl.items.map((it, i) => ({ itemId: it.id, avgScore: [82, 85, 80, 88][i] })), peerCount: 2, selfPresent: true,
  } },
];
const c3Published: PublishedResult[] = [
  {
    id: 'pr1', cycleId: 'c3', targetId: 'u-m2', publicationVersion: 1,
    payloadJson: {
      month: '2026-06', final_score: 86.5,
      peer_items: [
        { label: '目标达成与执行力', avg_score: 90 }, { label: '专业能力与决策质量', avg_score: 85 },
        { label: '团队管理与培养', avg_score: 88 }, { label: '跨部门协同', avg_score: 86 },
        { label: '价值观与文化契合', avg_score: 88 }, { label: '制度遵从与合规', avg_score: 90 },
        { label: '人才发展贡献', avg_score: 87 }, { label: '组织氛围感知', avg_score: 85 },
      ],
      self_items: [
        { label: '年度目标达成', avg_score: 82 }, { label: '能力成长', avg_score: 85 },
        { label: '不足与改进', avg_score: 80 }, { label: '下阶段规划', avg_score: 88 },
      ],
      peer_count: 2, self_present: true, formula_version: 'equal_weight_peer_avg_self_separate.v1',
    },
  },
];

export const cycles: Cycle[] = [
  {
    id: 'c1', month: '2026-08', title: '2026 年度上半年 360 评价', status: 'REVIEWING',
    openAt: '2026-08-10T09:00:00', closeAt: '2026-08-31T18:00:00', publishAt: '2026-09-15T09:00:00',
    rulesetId: defaultRuleset.id, phase: 'CLOSE',
    participants: [
      { userId: 'u-m1', role: 'MEMBER' }, { userId: 'u-head-rd', role: 'HEAD' }, { userId: 'u-m2', role: 'MEMBER' },
      { userId: 'u-m3', role: 'MEMBER' }, { userId: 'u-admin', role: 'HRPB' },
    ],
    assignments: c1Assignments, reviews: c1Reviews, calibrationCases: [], resultBuilds: [], publishedResults: [],
  },
  {
    id: 'c2', month: '2026-09', title: '2026 年度三季度 360 评价', status: 'CALIBRATING',
    openAt: '2026-09-01T09:00:00', closeAt: '2026-09-10T18:00:00', publishAt: '2026-09-20T09:00:00',
    rulesetId: defaultRuleset.id, phase: 'PUBLISH',
    participants: [
      { userId: 'u-m3', role: 'MEMBER' }, { userId: 'u-m4', role: 'MEMBER' }, { userId: 'u-head-pd', role: 'HEAD' },
      { userId: 'u-hrpb2', role: 'HRPB' },
    ],
    assignments: c2Assignments, reviews: c2Reviews, calibrationCases: c2Calibration, resultBuilds: c2Builds, publishedResults: [],
  },
  {
    id: 'c3', month: '2026-06', title: '2026 年度上半年 360 评价（已发布）', status: 'PUBLISHED',
    openAt: '2026-06-05T09:00:00', closeAt: '2026-06-25T18:00:00', publishAt: '2026-07-10T09:00:00',
    rulesetId: defaultRuleset.id, phase: 'CLOSE',
    participants: [{ userId: 'u-m2', role: 'MEMBER' }, { userId: 'u-head-rd', role: 'HEAD' }, { userId: 'u-admin', role: 'HRPB' }],
    assignments: c3Assignments, reviews: c3Reviews, calibrationCases: [], resultBuilds: c3Builds, publishedResults: c3Published,
  },
];

// 评优候选（仅从已发布、完整同角色结果计算，给管理角色看）
export const awardCandidates: AwardCandidate[] = [
  { userId: 'u-m3', displayName: '孙磊', deptName: '产品部', finalScore: 89.5, cycleId: 'c2', month: '2026-09', level: '优秀' },
  { userId: 'u-m2', displayName: '刘洋', deptName: '研发中心', finalScore: 86.5, cycleId: 'c3', month: '2026-06', level: '优秀' },
];

// 评优决定（award.manage 人工评定；按 cycle+target+category 幂等覆盖）
export const awardDecisions: AwardDecision[] = [
  { id: 'ad1', cycleId: 'c3', targetId: 'u-m2', category: '优秀员工', decision: 'AWARDED', reason: '分数领先且主导关键项目交付', createdAt: '2026-07-15T09:30:00' },
];

// 反馈申诉
export const feedbackRequests: FeedbackRequest[] = [
  { id: 'fb1', cycleId: 'c3', targetId: 'u-m2', reason: '对"团队管理与培养"维度评分依据希望进一步了解', createdAt: '2026-07-12T11:20:00', status: 'PENDING' },
  { id: 'fb2', cycleId: 'c3', targetId: 'u-m2', reason: '希望补充说明自评中列出的跨部门协作贡献', createdAt: '2026-07-13T14:05:00', status: 'DONE', handlerNote: '已电话沟通并补充说明口径' },
  { id: 'fb3', cycleId: 'c3', targetId: 'u-m2', reason: '对评优结果名次仍有异议，申请二次复核', createdAt: '2026-07-14T09:10:00', status: 'REJECTED', handlerNote: '原评优依据充分，维持结论' },
];

// 月报（report.view 查看；演示用预置快照，贴合已发布结果业务）
export interface MonthlyReport {
  cycleId: string;
  orgId: string;
  generatedAt: string;
  org: {
    participantCount: number; publishedCount: number; avgScore: number;
    distribution: { excellent: number; good: number; qualified: number; low: number };
    awardedCount: number; feedbackCount: number; feedbackResolved: number;
  };
  departments: { deptId: string; deptName: string; count: number; avgScore: number; maxScore: number; minScore: number }[];
}

export const monthlyReports: MonthlyReport[] = [
  {
    cycleId: 'c3', orgId: 'org-360', generatedAt: '2026-07-10T09:00:00',
    org: {
      participantCount: 12, publishedCount: 11, avgScore: 84,
      distribution: { excellent: 3, good: 5, qualified: 3, low: 0 },
      awardedCount: 2, feedbackCount: 5, feedbackResolved: 3,
    },
    departments: [
      { deptId: 'd-rd', deptName: '研发中心', count: 4, avgScore: 86, maxScore: 91, minScore: 80 },
      { deptId: 'd-pd', deptName: '产品部', count: 3, avgScore: 89, maxScore: 92, minScore: 85 },
      { deptId: 'd-hr', deptName: '人力资源部', count: 2, avgScore: 82, maxScore: 85, minScore: 78 },
      { deptId: 'd-mkt', deptName: '市场部', count: 2, avgScore: 78, maxScore: 83, minScore: 74 },
    ],
  },
];

export interface AuditEvent {
  id: string;
  orgId: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  requestId: string | null;
  createdAt: string; // ISO 时间
}

export const auditEvents: AuditEvent[] = [
  { id: 'ae-01', orgId: 'org-360', actorId: 'u-admin', actorName: '示例成员01', action: 'cycle.manage', resourceType: 'cycle', resourceId: 'c3', reason: '开期 2026-07', requestId: 'r-1001', createdAt: '2026-06-28T09:12:00' },
  { id: 'ae-02', orgId: 'org-360', actorId: 'u-admin', actorName: '示例成员01', action: 'assignment.manage', resourceType: 'assignment', resourceId: 'a-21', reason: '替补李雪', requestId: 'r-1002', createdAt: '2026-06-29T14:03:00' },
  { id: 'ae-03', orgId: 'org-360', actorId: 'u-head-rd', actorName: '王建国', action: 'calibration.resolve', resourceType: 'calibration_case', resourceId: 'cc-05', reason: '比值超限已复核', requestId: 'r-1003', createdAt: '2026-07-02T10:45:00' },
  { id: 'ae-04', orgId: 'org-360', actorId: 'u-super', actorName: '陈志强', action: 'calibration.resolve', resourceType: 'calibration_case', resourceId: 'cc-08', reason: '监管条线确认', requestId: 'r-1004', createdAt: '2026-07-02T16:20:00' },
  { id: 'ae-05', orgId: 'org-360', actorId: 'u-admin', actorName: '示例成员01', action: 'result.confirm', resourceType: 'result_build', resourceId: 'rb-12', reason: '确认张伟结果', requestId: 'r-1005', createdAt: '2026-07-05T11:10:00' },
  { id: 'ae-06', orgId: 'org-360', actorId: 'u-super', actorName: '陈志强', action: 'result.publish', resourceType: 'published_result', resourceId: 'pr-12', reason: 'v1', requestId: 'r-1006', createdAt: '2026-07-06T09:30:00' },
  { id: 'ae-07', orgId: 'org-360', actorId: 'u-admin', actorName: '示例成员01', action: 'result.publish', resourceType: 'published_result', resourceId: 'pr-13', reason: 'v1', requestId: 'r-1007', createdAt: '2026-07-06T09:31:00' },
  { id: 'ae-08', orgId: 'org-360', actorId: 'u-m2', actorName: '刘洋', action: 'feedback.request', resourceType: 'feedback', resourceId: 'fb-03', reason: '对本人结果有疑义', requestId: 'r-1008', createdAt: '2026-07-08T13:22:00' },
  { id: 'ae-09', orgId: 'org-360', actorId: 'u-admin', actorName: '示例成员01', action: 'feedback.resolve', resourceType: 'feedback', resourceId: 'fb-03', reason: 'APPROVED', requestId: 'r-1009', createdAt: '2026-07-09T10:05:00' },
  { id: 'ae-10', orgId: 'org-360', actorId: 'u-admin', actorName: '示例成员01', action: 'award.manage', resourceType: 'award_decision', resourceId: 'aw-02', reason: '评定优秀', requestId: 'r-1010', createdAt: '2026-07-10T15:40:00' },
  { id: 'ae-11', orgId: 'org-360', actorId: 'u-super', actorName: '陈志强', action: 'report.view', resourceType: 'monthly_report', resourceId: 'c3', reason: '查看 7 月月报', requestId: 'r-1011', createdAt: '2026-07-11T08:50:00' },
  { id: 'ae-12', orgId: 'org-360', actorId: 'u-admin', actorName: '示例成员01', action: 'audit.export', resourceType: 'audit', resourceId: 'c3', reason: '导出审计报表', requestId: 'r-1012', createdAt: '2026-07-11T09:00:00' },
];
