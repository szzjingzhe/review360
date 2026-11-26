<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterView } from 'vue-router';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import {monthlyLabel} from './lib/monthly-navigation';
import { useAuth } from './stores/auth';
import { mockApi } from './api';
import AnnouncementModal from './components/AnnouncementModal.vue';
import type { AnncData } from './contracts/announcement';
import { oversightPreviewActive } from './lib/visualPreview';
import { type AccessContext, visibleWorkspaces, workspaceOfPath } from './lib/workspaces';

const auth = useAuth();
const route = useRoute();
const oversightPreview = computed(() => oversightPreviewActive(auth.user?.id, route.path));
const ctx = computed<AccessContext>(() => ({ isResultViewer: auth.user?.isResultViewer, isGuidance: auth.user?.isGuidance, capabilities: auth.user?.capabilities ?? [], roles: auth.user?.roles ?? [] }));
const pageNames: Record<string, string> = {
  '/management':'管理工作台','/management/monthly':'月评管理','/management/rules':'评价规则','/management/insights':'月报洞察','/management/archives':'月评档案','/management/feedback':'反馈申诉','/management/settings':'系统设置',
  '/': '个人工作台', '/personal': '个人工作台', '/monthly-report': '月报成果', '/self-review': '月度自评', '/tasks': '待我评价',
  '/my-results': '我的结果', '/feedback': '名单与结果反馈', '/organization': '组织架构',
  '/feedback/manage': '反馈申诉处理',
  '/department': '部门工作台', '/department/progress': '材料与评价进度', '/department/growth': '成员成长',
  '/oversight': '月评总览', '/cycles': '月评发起与进程', '/rulesets': '指标与评分规则',
  '/calibration': '异常评分核验', '/results': '结果确认与发布', '/award': '评优管理', '/report': '月报洞察', '/audit': '审计记录',
};
const pageTitle = computed(() => route.params.module==='monthly'?'月评管理 / '+monthlyLabel(route.params.section):route.params.module==='archives'&&route.params.cycleId?'月评档案 / 周期详情':pageNames[route.path] ?? (route.path.startsWith('/reviews/') ? '填写评价' : '成长环评'));
// Personal pages share one decorative layer, without changing document scrolling.
const departmentBackground = computed(() => {
  if (route.path === '/department' || route.path.startsWith('/department/')) return true;
  if (!['/user-management', '/task-archive'].includes(route.path)) return false;
  // Match the sidebar's explicit workspace for pages shared with oversight.
  const selected = sessionStorage.getItem('s360_workspace');
  if (selected && visibleWorkspaces(ctx.value).some(w => w.key === selected)) return selected === 'department';
  return workspaceOfPath(route.path) === 'department';
});
const oversightBackground = computed(() => {
  if (['/user-management', '/task-archive'].includes(route.path)) {
    const selected = sessionStorage.getItem('s360_workspace');
    if (selected && visibleWorkspaces(ctx.value).some(w => w.key === selected)) return selected === 'oversight';
  }
  return workspaceOfPath(route.path) === 'oversight';
});
const showPageBackground = computed(() => route.meta.pageBackground === 'technology' || departmentBackground.value || oversightBackground.value);

// 月评公告：右上角铃铛常驻入口；每天首次进入自动展开一次，勾选「今日不再弹出」后当天不再打扰。
const DISMISS_KEY = 's360_annc_dismissed';
const annc = ref<AnncData | null>(null);
const anncOpen = ref(false);
const anncDot = ref(false);
const todayKey = () => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function dismissedToday(version: string): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === `${version}@${todayKey()}`; } catch { return false; }
}
async function loadAnnouncement(autoOpen: boolean): Promise<void> {
  try {
    const data = (await mockApi.getAnnouncement()) as AnncData;
    annc.value = data;
    const fresh = data.announcement.isPublished && !dismissedToday(data.version);
    anncDot.value = fresh;
    if (autoOpen && fresh) anncOpen.value = true;
  } catch {
    // 公告接口异常不能影响主流程，静默降级为不展示
  }
}
function closeAnnc(dontShow: boolean): void {
  if (dontShow && annc.value) {
    try { localStorage.setItem(DISMISS_KEY, `${annc.value.version}@${todayKey()}`); } catch { /* 无 storage 环境忽略 */ }
    anncDot.value = false;
  }
  anncOpen.value = false;
}
function applyAnnc(next: AnncData): void {
  annc.value = next;
  anncDot.value = false;
}
onMounted(async () => {
  await auth.init();
  if (auth.user) void loadAnnouncement(true);
});
</script>

<template>
  <div class="shell">
    <RouterView name="AppBar" />
    <div class="main-shell" :class="{ 'has-page-background': showPageBackground, 'has-plain-background': route.meta.pageBackground === 'plain' }">
      <header v-if="auth.user" class="topbar">
        <div class="breadcrumb"><span>团队成长</span><i>/</i><strong>{{ pageTitle }}</strong></div>
        <div class="top-user">
          <button class="annc-btn" type="button" aria-label="月评公告" title="月评公告" @click="anncOpen = true">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3a5 5 0 0 0-5 5v3.2c0 .6-.2 1.2-.6 1.7L4.8 15c-.6.8 0 1.9 1 1.9h12.4c1 0 1.6-1.1 1-1.9l-1.6-2.1a2.9 2.9 0 0 1-.6-1.7V8a5 5 0 0 0-5-5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <path d="M9.6 19a2.5 2.5 0 0 0 4.8 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
            <span v-if="anncDot" class="annc-dot" aria-hidden="true"></span>
          </button>
          <span class="connection-dot"></span>
          <span>{{ auth.user.displayName }}</span>
        </div>
      </header>
      <div v-if="showPageBackground" class="page-background" :class="{ 'department-background': departmentBackground, 'oversight-background': oversightBackground }" aria-hidden="true"></div>
      <main class="content"><p v-if="oversightPreview" class="notice notice-info" role="status">本地模拟预览 · 仅示例成员18账号可见。所有成员、评分及记录均为模拟内容；可切换周期、筛选和查看详情，审批、发布、保存及导出不会执行。</p><RouterView /></main>
    </div>
    <AnnouncementModal v-if="anncOpen && annc" :data="annc" @close="closeAnnc" @saved="applyAnnc" />
  </div>
</template>

<style>
/* ==========================================================================
   飞书（Lark）风格设计令牌
   —— 只改视觉，不改结构与文案。颜色/圆角/阴影集中在此，便于统一调整。
   取色对齐飞书规范：主色 #3370FF；文字 #1F2329/#646A73/#8F959E；
   页面底色 #F5F6F7；描边 #DEE0E3/#EFF0F1；圆角 4/6/8；阴影极克制。
   ========================================================================== */
:root {
  /* 主色 */
  --lark-primary: #3370ff;
  --lark-primary-hover: #245bdb;
  --lark-primary-active: #1c4fd0;
  --lark-primary-bg: #e1eaff;
  --lark-primary-bg-weak: #f0f4ff;
  /* 文字 */
  --lark-text-1: #1f2329;
  --lark-text-2: #646a73;
  --lark-text-3: #8f959e;
  --lark-text-4: #bbbfc4;
  /* 背景与填充 */
  --lark-bg-page: #f5f6f7;
  --lark-bg-card: #ffffff;
  --lark-bg-hover: #f5f6f7;
  --lark-fill-2: #f2f3f5;
  /* 描边 */
  --lark-border: #dee0e3;
  --lark-border-light: #eff0f1;
  /* 状态色（飞书浅底 + 深字） */
  --lark-success: #2ea121;
  --lark-success-bg: #e4f9e0;
  --lark-warning: #d25f00;
  --lark-warning-bg: #fff7e8;
  --lark-danger: #d83931;
  --lark-danger-bg: #fef0f0;
  /* 圆角 */
  --lark-radius-sm: 4px;
  --lark-radius: 6px;
  --lark-radius-lg: 8px;
  /* 阴影 */
  --lark-shadow-card: 0 1px 3px rgba(31, 35, 41, 0.06);
  --lark-shadow-pop: 0 4px 12px rgba(31, 35, 41, 0.1);
  --lark-ring: 0 0 0 2px rgba(51, 112, 255, 0.24);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--lark-bg-page);
  color: var(--lark-text-1);
  font-size: 14px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--lark-primary); text-decoration: none; }
a:hover { color: var(--lark-primary-hover); }

.shell { display: flex; align-items: stretch; min-height: 100vh; }
.main-shell { flex: 1; min-width: 0; }
/* The document remains the only page scroller. A zero-height sticky anchor keeps
   decoration under the topbar without reserving space or creating a scrollport. */
.main-shell.has-plain-background { background-color: #f4f7fc; }
.main-shell.has-page-background { position: relative; isolation: isolate; background-color: #f4f7fc; }
.page-background {
  position: sticky;
  top: 76px;
  height: 0;
  width: 100%;
  z-index: -1;
  pointer-events: none;
}
.page-background::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 240px;
  background-image: url('./assets/personal-backgrounds/header-technology-blue.png');
  background-repeat: no-repeat;
  background-size: cover;
  background-position: right center;
  opacity: .65;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%);
}
.page-background.department-background::before {
  background-image: url('./assets/department-backgrounds/header-technology-buildings.png');
}
.page-background.oversight-background::before { background-image: url('./assets/oversight-dashboard/header-monitoring.png'); }
/* On stacked navigation the topbar scrolls normally, so the decoration sticks
   to the viewport only after reaching it. Its width stays inside main-shell. */
@media (max-width: 820px) { .page-background { top: 0; } }
@media print {
  .page-background { display: none !important; }
  .main-shell.has-page-background { background-color: #fff !important; }
}
.topbar { height: 76px; padding: 0 36px; display:flex; align-items:center; justify-content:space-between; gap:24px; position:sticky; top:0; z-index:10; border-bottom:1px solid var(--lark-border-light); background:rgba(255,255,255,.96); backdrop-filter:blur(10px); }
.breadcrumb { display:flex; align-items:center; gap:10px; white-space:nowrap; color:var(--lark-text-3); }
.breadcrumb i { font-style:normal; color:#c4c7cc; }
.breadcrumb strong { color:var(--lark-text-1); font-weight:600; }
.top-user { display:flex; align-items:center; gap:8px; color:var(--lark-text-2); white-space:nowrap; }
.annc-btn {
  position:relative; display:inline-flex; align-items:center; justify-content:center;
  width:30px; height:30px; margin-right:2px; padding:0; border:0; border-radius:6px;
  background:transparent; color:var(--lark-text-2); cursor:pointer;
  transition:background-color .12s ease, color .12s ease;
}
.annc-btn svg { width:19px; height:19px; }
.annc-btn:hover { background:var(--lark-fill-2); color:var(--lark-text-1); }
.annc-btn:focus-visible { outline:none; box-shadow:var(--lark-ring); }
.annc-dot {
  position:absolute; top:4px; right:4px; width:7px; height:7px; border-radius:50%;
  background:#e54545; box-shadow:0 0 0 2px #fff;
}
.connection-dot { width:7px; height:7px; border-radius:50%; background:#34c724; box-shadow:0 0 0 3px #e4f9e0; }
.content { min-width: 0; padding: 34px 36px 64px; max-width: 1680px; margin: 0 auto; }
.page-title { font-size: 28px; font-weight: 700; letter-spacing: -.02em; }
.page-sub { color:var(--lark-text-2); }
.card { border-radius: 12px; margin-bottom: 20px; box-shadow: 0 10px 30px rgba(25,39,72,.05); }
.grid { gap:18px; }
.grid-3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
.grid-2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
.kpi { font-family:'Times New Roman',serif; }
.table { border:1px solid var(--lark-border-light); border-radius:8px; overflow:hidden; }
.table th { background:#f7f8fa; }
.notice { border-radius:8px; }
.btn-primary { box-shadow:0 2px 5px rgba(51,112,255,.18); }
@media (max-width: 820px) {
  .shell { flex-direction: column; }
  .topbar { position:static; height:auto; min-height:58px; padding:10px 16px; flex-wrap:wrap; gap:10px; }
  .content { padding: 20px 16px 40px; }
  .grid-3 { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
@media (max-width:560px) { .grid-2,.grid-3 { grid-template-columns:1fr; } .top-user { display:none; } .page-head { align-items:flex-start; } }

.page-title { font-size: 20px; font-weight: 600; margin: 0 0 4px; color: var(--lark-text-1); letter-spacing: 0; }
.page-sub { color: var(--lark-text-2); margin: 0 0 16px; font-size: 14px; line-height: 22px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.page-head .page-sub { margin-bottom: 0; }
.page-head-actions { display: flex; align-items: center; gap: 8px; }

.notice {
  background: var(--lark-fill-2);
  border: 1px solid var(--lark-border-light);
  border-radius: var(--lark-radius);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--lark-text-2);
  line-height: 20px;
}
.notice-warning { background: var(--lark-warning-bg); border-color: #ffe4b3; color: var(--lark-warning); }
.notice-info { background: var(--lark-primary-bg-weak); border-color: #c9dcff; color: var(--lark-text-1); }
.table-wrap { overflow-x: auto; }
.err { color: var(--lark-danger); font-size: 13px; }

.card {
  background: var(--lark-bg-card);
  border: 1px solid var(--lark-border-light);
  border-radius: var(--lark-radius-lg);
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: var(--lark-shadow-card);
}
.card h3 { margin: 0 0 16px; font-size: 16px; font-weight: 600; color: var(--lark-text-1); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.grid { display: grid; gap: 16px; }
.grid-2 { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.grid-3 { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }

/* 按钮：飞书高度 32 / 小号 28，圆角 6，主按钮无投影 */
.btn {
  min-height: 32px;
  padding: 5px 16px;
  font-size: 14px;
  font-family: inherit;
  line-height: 20px;
  cursor: pointer;
  border: 1px solid var(--lark-border);
  color: var(--lark-text-1);
  background: var(--lark-bg-card);
  border-radius: var(--lark-radius);
  transition: background-color .1s ease, border-color .1s ease, color .1s ease;
}
.btn:hover { background: var(--lark-bg-hover); border-color: var(--lark-border); }
.btn:active { background: var(--lark-fill-2); }
.btn:focus-visible { outline: none; box-shadow: var(--lark-ring); }
.btn-primary { background: var(--lark-primary); color: #fff; border-color: var(--lark-primary); }
.btn-primary:hover { background: var(--lark-primary-hover); border-color: var(--lark-primary-hover); }
.btn-primary:active { background: var(--lark-primary-active); border-color: var(--lark-primary-active); }
.btn-danger { background: var(--lark-bg-card); color: var(--lark-danger); border-color: var(--lark-border); }
.btn-danger:hover { background: var(--lark-danger-bg); border-color: #ffc9c7; }
.btn-sm { min-height: 28px; padding: 3px 12px; font-size: 13px; }
.btn:disabled, .btn[disabled] {
  opacity: 1;
  cursor: not-allowed;
  color: var(--lark-text-4);
  background: var(--lark-fill-2);
  border-color: var(--lark-border-light);
}
.btn-primary:disabled { color: #fff; background: #a8c0ff; border-color: #a8c0ff; }

/* 表格：飞书表头浅灰底 + 500 字重，行分隔线极浅，无外框 */
.table { width: 100%; border-collapse: collapse; font-size: 14px; }
.table th, .table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--lark-border-light); }
.table th { color: var(--lark-text-2); font-weight: 500; background: var(--lark-bg-page); }
.table td { color: var(--lark-text-1); }
.table tr:hover td { background: var(--lark-bg-hover); }

/* 标签：飞书用 4px 小圆角（非胶囊），20px 高 */
.chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--lark-radius-sm);
  font-size: 12px;
  font-weight: 400;
  line-height: 20px;
  white-space: nowrap;
}
.chip-blue { background: var(--lark-primary-bg); color: var(--lark-primary); }
.chip-green { background: var(--lark-success-bg); color: var(--lark-success); }
.chip-red { background: var(--lark-danger-bg); color: var(--lark-danger); }
.chip-amber { background: var(--lark-warning-bg); color: var(--lark-warning); }
.chip-gray { background: var(--lark-fill-2); color: var(--lark-text-2); }

.muted { color: var(--lark-text-2); }
.tag { font-size: 12px; color: var(--lark-text-3); line-height: 20px; }

/* 表单：文本类输入统一 32px 高；勾选/滑块单独处理，避免被误伤 */
input:not([type='checkbox']):not([type='radio']):not([type='range']),
textarea,
select {
  width: 100%;
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--lark-border);
  border-radius: var(--lark-radius);
  font-size: 14px;
  font-family: inherit;
  line-height: 20px;
  background: var(--lark-bg-card);
  color: var(--lark-text-1);
  transition: border-color .1s ease, box-shadow .1s ease;
}
textarea { min-height: 72px; padding: 6px 12px; resize: vertical; }
input:not([type='checkbox']):not([type='radio']):not([type='range']):focus,
textarea:focus,
select:focus {
  outline: none;
  border-color: var(--lark-primary);
  box-shadow: var(--lark-ring);
}
input::placeholder, textarea::placeholder { color: var(--lark-text-4); }
input[type='checkbox'], input[type='radio'], input[type='range'] { accent-color: var(--lark-primary); }
.input { width: auto; }
.input-sm { width: auto; padding: 3px 8px; font-size: 13px; min-height: 28px; }
label { font-size: 13px; color: var(--lark-text-2); display: block; margin-bottom: 4px; line-height: 20px; }
.field { margin-bottom: 12px; }

.score { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--lark-text-1); }
.bar-track { background: var(--lark-fill-2); border-radius: var(--lark-radius-sm); height: 6px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--lark-primary); border-radius: var(--lark-radius-sm); }
.empty { text-align: center; color: var(--lark-text-3); padding: 40px 0; font-size: 14px; }
.kpi { font-size: 24px; font-weight: 600; color: var(--lark-text-1); font-variant-numeric: tabular-nums; }

/* 侧栏激活态兜底（AppBar.vue 内为 scoped 精确实现） */
.nav-active { background: rgba(255, 255, 255, .12) !important; color: #fff !important; }
</style>
