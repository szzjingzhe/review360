import { createRouter, createWebHistory, type RouteMeta } from 'vue-router';
import { useAuth } from '../stores/auth';
import { OVERSIGHT_HOME_CAPS } from '../lib/workspaces';
import { defaultHome } from '../lib/workspaces';
import AppBar from '../views/AppBar.vue';
import DashboardView from '../views/DashboardView.vue';
import LoginView from '../views/LoginView.vue';
import RulesetsView from '../views/RulesetsView.vue';
import CyclesView from '../views/CyclesView.vue';
import TasksView from '../views/TasksView.vue';
import ReviewView from '../views/ReviewView.vue';
import CalibrationView from '../views/CalibrationView.vue';
import PublishedResultsView from '../views/PublishedResultsView.vue';
import ResultsView from '../views/ResultsView.vue';
import PersonalResultsView from '../views/PersonalGrowthView.vue';
import ManagementView from '../views/ManagementView.vue';
import AwardView from '../views/AwardView.vue';
import FeedbackView from '../views/FeedbackView.vue';
import FeedbackManagementView from '../views/FeedbackManagementView.vue';
import MemberFeedbackView from '../views/MemberFeedbackView.vue';
import ReportView from '../views/ReportView.vue';
import AuditView from '../views/AuditView.vue';
import OrganizationView from '../views/OrganizationView.vue';
import DepartmentDashboardView from '../views/DepartmentDashboardView.vue';
import SelfReviewView from '../views/SelfReviewView.vue';
import MonthlyReportView from '../views/MonthlyReportView.vue';
import OversightDashboardView from '../views/OversightDashboardView.vue';
import UserManagementView from '../views/UserManagementView.vue';
import TaskArchiveView from '../views/TaskArchiveView.vue';

// 路由权限元数据：与 src/lib/workspaces.ts 的入口条件保持一致
declare module 'vue-router' {
  interface RouteMeta {
    /** 需要该 capability 才能进入 */
    capability?: string;
    /** 满足其中任一 capability 即可进入 */
    capabilities?: string[];
    /** 需要其中任一业务角色（如 HEAD）才能进入 */
    roles?: string[];
    /** Personal page background policy, rendered once by App.vue. */
    pageBackground?: 'technology' | 'plain';
  }
}

const OVERSIGHT_CAPS = OVERSIGHT_HOME_CAPS;

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },

    {path:'/management',components:{default:ManagementView,AppBar},meta:{capability:'management.access'}},
    {path:'/management/:module(monthly)/:section(cycles|relations|announcement|exceptions|results|growth)/:cycleId?',components:{default:ManagementView,AppBar},meta:{capability:'management.access'}},
    {path:'/management/:module(monthly|rules|insights|archives|feedback|settings)/:cycleId?',components:{default:ManagementView,AppBar},meta:{capability:'management.access'}},
    // ---- 个人端（所有参评人员）----
    { path: '/', components: { default: DashboardView, AppBar }, meta: { pageBackground: 'technology' } },
    { path: '/personal', components: { default: DashboardView, AppBar }, meta: { pageBackground: 'technology' } },
    { path: '/monthly-report', components: { default: MonthlyReportView, AppBar }, meta: { pageBackground: 'technology' } },
    { path: '/self-review', components: { default: SelfReviewView, AppBar }, meta: { pageBackground: 'technology' } },
    { path: '/tasks', components: { default: TasksView, AppBar }, meta: { pageBackground: 'technology' } },
    { path: '/reviews/:reviewId', components: { default: ReviewView, AppBar }, props: { default: true }, meta: { pageBackground: 'technology' } },
    { path: '/my-results', components: { default: PersonalResultsView, AppBar }, meta: { pageBackground: 'technology' } },
    { path: '/feedback', components: { default: MemberFeedbackView, AppBar }, meta: { pageBackground: 'technology' } },
    {path:'/feedback/manage',redirect:to=>({path:'/management/feedback',query:{...to.query}})},
    {path:'/organization',redirect:to=>({path:'/management/settings',query:{...to.query,tab:'organization'}})},

    // ---- 部门管理端（部长默认可见，也可通过 workspace.department 授权给其他成员）----
    { path: '/department', components: { default: DepartmentDashboardView, AppBar }, meta: { capability: 'workspace.department' } },
    { path: '/department/progress', components: { default: DepartmentDashboardView, AppBar }, meta: { capability: 'workspace.department' } },
    { path: '/department/assignments', components: { default: DepartmentDashboardView, AppBar }, meta: { capability: 'assignment.manage' } },
    { path: '/department/growth', components: { default: DepartmentDashboardView, AppBar }, meta: { capability: 'workspace.department' } },
    {path:'/user-management',redirect:to=>({path:'/management/settings',query:{...to.query,tab:'users'}})},
    {path:'/task-archive',redirect:to=>({path:'/management/archives',query:{...to.query,tab:'cycles'}})},

    // ---- 组织监管端（按 capability 授权）----
    {path:'/oversight',redirect:to=>({path:'/management',query:{...to.query}})},
    {path:'/cycles',redirect:to=>({path:'/management/monthly',query:{...to.query,tab:'cycles'}})},
    {path:'/cycles/:cycleId',redirect:to=>({path:'/management/monthly/'+String(to.params.cycleId),query:{...to.query,tab:'cycles'}})},
    {path:'/rulesets',redirect:to=>({path:'/management/rules',query:{...to.query}})},
    {path:'/calibration',redirect:to=>({path:'/management/monthly',query:{...to.query,tab:'exceptions'}})},
    { path: '/published-results', components: { default: PublishedResultsView, AppBar }, meta: { capability: 'result.read_published' } },
    {path:'/results',redirect:to=>({path:'/management/monthly',query:{...to.query,tab:'results'}})},
    {path:'/award',redirect:to=>({path:'/management/archives',query:{...to.query,tab:'scores'}})},
    {path:'/report',redirect:to=>({path:'/management/insights',query:{...to.query}})},
    {path:'/audit',redirect:to=>({path:'/management/settings',query:{...to.query,tab:'audit'}})},
  ],
});

/**
 * 统一入口控制：
 *  - 未登录 → 登录页（真实后端模式；mock 模式 whoami 总有默认身份）
 *  - 无 capability → 回工作台
 *  - 无部门角色 → 不能进部门工作台
 * 注意：这只是体验层拦截，正式权限必须由后端 API 再次校验（SessionGuard + CapabilityGuard + policy）。
 */
router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.ready) await auth.init();

  // 登录页始终可达：未选端口 / 想换端口都从这里进
  if (to.path === '/login') return true;
  // 未选端口或未登录 → 登录页
  if (!auth.picked || !auth.user) return '/login';

  // 登录后的工作区由服务端授权决定，业务页不提供跨端切换。
  if (to.path === '/') {
    const landing = defaultHome({ capabilities: auth.user.capabilities, roles: auth.user.roles, isResultViewer: auth.user.isResultViewer, isGuidance: auth.user.isGuidance });
    if (landing.path !== '/') return landing.path;
  }

  if(to.path==='/published-results'&&!auth.user.isGuidance&&!auth.user.isResultViewer)return '/management/archives?tab=scores';
  if(auth.user.isResultViewer&&to.path!=='/published-results')return '/published-results';
  // 指导组默认只读；被显式授予 management.access 的账号（业务管理员）按常规能力走，与后端 SessionGuard 同口径
  const guidanceReadOnly = auth.user.isGuidance === true && !(auth.user.capabilities ?? []).includes('management.access');
  if (guidanceReadOnly && !['/published-results','/organization'].includes(to.path)) return '/published-results';
  if(to.params.module==='monthly'&&!to.params.section){
    const keys=['cycles','relations','announcement','exceptions','results','growth'];const section=keys.includes(String(to.query.tab))?String(to.query.tab):(auth.user.capabilities.includes('cycle.manage')?'cycles':'relations');const {tab,...query}=to.query;
    return {path:'/management/monthly/'+section+(to.params.cycleId?'/'+String(to.params.cycleId):''),query};
  }
  if(to.path.startsWith('/management/')){
    const required:Record<string,string>={monthly:'cycle.manage',rules:'org.manage',insights:'report.view',archives:'result.read_published',feedback:'feedback.manage',settings:'org.manage'};
    const cap=required[String(to.params.module)];
    if(to.params.module==='monthly'&&to.params.section==='relations'){
      if(!['cycle.manage','assignment.manage','assignment.read'].some(c=>auth.user!.capabilities.includes(c)))return '/personal';
    } else if(cap&&!auth.user.capabilities.includes(cap))return '/personal';
  }
  const meta = to.meta as RouteMeta;
  if (meta.roles?.length && !meta.roles.some((r) => auth.user!.roles.includes(r))) return '/';
  if (meta.capability && !auth.user.capabilities.includes(meta.capability)) return '/';
  if (meta.capabilities?.length && !meta.capabilities.some((c) => auth.user!.capabilities.includes(c))) return '/';
  return true;
});
