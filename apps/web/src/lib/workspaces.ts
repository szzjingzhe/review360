/**
 * 两端导航定义：统一个人入口，按服务端能力进入管理端。
 * 侧边栏、路由守卫、首页角色判定共用本文件，避免多处各自维护入口条件。
 *
 * 重要：前端隐藏/拦截只是体验层控制，正式权限必须由后端 API 再次校验
 * （服务端 SessionGuard + CapabilityGuard + policy 对象范围）。
 */

export type WorkspaceKey = 'personal' | 'department' | 'oversight';

/**
 * 「监管工作台」与首页监管视角的判定条件（组织级运营能力）。
 * 故意不含 calibration.resolve —— 部长也有该项，会把部长误判为监管。
 */
export const OVERSIGHT_HOME_CAPS = [
  'workspace.oversight',
  'calibration.read_raw',
  'result.publish',
  'audit.export',
  'cycle.manage',
  'org.manage',
];

export interface NavItem {
  to: string;
  label: string;
  /** 单一能力要求 */
  capability?: string;
  roles?: string[];
  /** 任一能力满足即可（用于「监管工作台」这类聚合入口） */
  capabilities?: string[];
}

export interface WorkspaceDef {
  key: WorkspaceKey;
  label: string;
  /** 工作区级角色要求（任一命中即可进入）；部门端当前仅限部长。 */
  roles?: string[];
  items: NavItem[];
}

export const WORKSPACES: WorkspaceDef[] = [
 {key:'personal',label:'个人端',items:[
  {to:'/personal',label:'工作台'}, {to:'/monthly-report',label:'月度成果'},
  {to:'/self-review',label:'我的自评'}, {to:'/tasks',label:'待我评价'},
  {to:'/my-results',label:'我的结果'}, {to:'/feedback',label:'反馈申诉'},
  // 部长工作台：部长身份默认可见；也可由组织在「系统设置 → 角色权限」把
  // workspace.department 单独授予普通成员（后端视图同时隐含 progress.read）。
  {to:'/department',label:'部长工作台',capability:'workspace.department'},
 ]},
 {key:'oversight',label:'管理端',items:[
  {to:'/management',label:'管理工作台',capability:'management.access'},
  {to:'/management/monthly',label:'月评管理',capability:'management.access',capabilities:['cycle.manage','assignment.manage','assignment.read']},
  {to:'/management/rules',label:'评价规则',capability:'org.manage'},
  {to:'/management/insights',label:'月报洞察',capability:'report.view'},
  {to:'/management/archives',label:'月评档案',capability:'result.read_published'},
  {to:'/management/feedback',label:'反馈申诉',capability:'feedback.manage'},
  {to:'/management/settings',label:'系统设置',capability:'org.manage'},
 ]},
];

export interface AccessContext {
  capabilities: string[];
  roles: string[];
  isGuidance?: boolean;
  isResultViewer?: boolean;
}

/**
 * 指导组的只读限制是否生效。
 * 指导组默认只读；若该账号被显式授予 management.access（业务管理员），
 * 则按常规能力授权走，不再裁剪导航——与后端 SessionGuard 同一口径。
 */
function guidanceReadOnly(ctx: AccessContext): boolean {
  return ctx.isGuidance === true && !ctx.capabilities.includes('management.access');
}

export function itemAllowed(item: NavItem, ctx: AccessContext): boolean {
  if(item.roles?.length&&!item.roles.some(r=>ctx.roles.includes(r)))return false;
  if(ctx.isResultViewer&&item.to!=='/published-results')return false;
  if (guidanceReadOnly(ctx) && !['/published-results','/organization'].includes(item.to)) return false;
  if (item.capability && !ctx.capabilities.includes(item.capability)) return false;
  if (item.capabilities?.length && !item.capabilities.some((c) => ctx.capabilities.includes(c))) return false;
  return true;
}

/** 工作区是否对当前身份可见（工作区角色 + 至少一个可见入口） */
export function workspaceVisible(w: WorkspaceDef, ctx: AccessContext): boolean {
  if (w.roles?.length && !w.roles.some((r) => ctx.roles.includes(r))) return false;
  return w.items.some((i) => itemAllowed(i, ctx));
}

export function visibleWorkspaces(ctx: AccessContext): WorkspaceDef[] {
  if(guidanceReadOnly(ctx)||ctx.isResultViewer)return [{key:'oversight',label:'管理端',items:[{to:'/published-results',label:'已发布结果',capability:'result.read_published'}]}];
  return WORKSPACES.map((w) => ({ ...w, items: w.items.filter((i) => itemAllowed(i, ctx)) })).filter(
    (w) => w.items.length > 0 && (!w.roles?.length || w.roles.some((r) => ctx.roles.includes(r))),
  );
}

/** 路径归属（供导航高亮与「当前工作区」判断；参数化子路由按前缀归属） */
export function workspaceOfPath(path: string): WorkspaceKey | null {
 if(path.startsWith('/management'))return 'oversight';
 if(path.startsWith('/department')||path.startsWith('/reviews/'))return 'personal';
 return WORKSPACES.find(w=>w.items.some(i=>i.to===path))?.key??null;
}

/** 侧边栏是否高亮：非导航页不误亮 */
export function navItemActive(item: NavItem, path: string): boolean {
  if (item.to === '/') return path === '/';
  if (path !== item.to && !path.startsWith(item.to + '/')) return false;
  if(item.to==='/department'&&path.startsWith('/department/'))return false;
  if(item.to==='/feedback'&&path.startsWith('/feedback/manage'))return false;
  // A registered child entry wins over its parent; detail routes without their
  // own navigation entry (such as /cycles/:id) still highlight the parent.
  return !WORKSPACES.some(workspace => workspace.items.some(other =>
    other.to !== item.to && other.to.startsWith(item.to + '/') &&
    (path === other.to || path.startsWith(other.to + '/')),
  ));
}

/** 各端口的落地首页（登录选端口后跳转） */
export const PORT_HOME: Record<WorkspaceKey, string> = {
  // '/' is also the post-login landing route and is redirected to the
  // highest-authority workspace by the router. Use a concrete personal route
  // so an explicit workspace switch cannot bounce back to oversight.
  personal: '/personal',
  department: '/department',
  oversight: '/management',
};

/** 登录后唯一默认落点；跨端访问通过重新登录获得，不在业务页提供端口切换。 */
export function defaultHome(ctx: AccessContext): {port:WorkspaceKey;path:string} {
 if(ctx.isResultViewer)return {port:'oversight',path:'/published-results'};
 if(guidanceReadOnly(ctx))return {port:'oversight',path:'/published-results'};
 // 被授予管理端入口的指导组成员（业务管理员）：直接落到管理工作台
 if(ctx.isGuidance)return {port:'oversight',path:'/management'};
 return {port:'personal',path:'/personal'};
}

/** 端口说明（登录页展示，让用户知道该端口包含哪些页面） */
export const PORT_DESC: Record<WorkspaceKey, string> = {
 personal: '个人工作台、月度成果、自评、待评价、成长分析、反馈申诉',
 department: '部长工作台：部门进度、评价关系与成员成长',
 oversight: '管理工作台、月评管理、评价规则、月报洞察、月评档案、反馈申诉、系统设置',
};
