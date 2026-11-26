<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '../stores/auth';
import { visibleWorkspaces, navItemActive, PORT_HOME, workspaceOfPath, type AccessContext, type WorkspaceKey } from '../lib/workspaces';

const router = useRouter();
const route = useRoute();
const auth = useAuth();
const workspaceKey = 's360_workspace';
const selectedWorkspace = ref<WorkspaceKey | null>((sessionStorage.getItem(workspaceKey) as WorkspaceKey | null) || null);
const switching = ref(false);

const ctx = computed<AccessContext>(() => ({
  isResultViewer: auth.user?.isResultViewer, isGuidance: auth.user?.isGuidance, capabilities: auth.user?.capabilities ?? [],
  roles: auth.user?.roles ?? [],
}));

/** 只显示当前身份有权进入的工作区与入口（PRD §4：按授权显示工作区） */
const workspaces = computed(() => visibleWorkspaces(ctx.value));
const current = computed(() => route.path.startsWith('/reviews/') ? '/tasks' : route.path);
const activeKey = computed<WorkspaceKey>(() => {
  // Some pages (notably user management and task archive) are shared by
  // multiple workspaces. Keep the user's explicit selection for those pages
  // instead of inferring the first matching workspace from the route.
  const selected = selectedWorkspace.value;
  if (selected && workspaces.value.some((w) => w.key === selected)) {
    const ownsPath = workspaces.value.find((w) => w.key === selected)?.items.some((i) => i.to === route.path || (i.to !== '/' && route.path.startsWith(i.to + '/')));
    if (ownsPath) return selected;
  }
  return workspaceOfPath(route.path) ?? 'personal';
});
const activeWorkspace = computed(() => workspaces.value.find((w) => w.key === activeKey.value) ?? workspaces.value[0]);
const iconMap: Record<string, string> = {
  '工作台': 'fa-solid fa-table-cells-large', '月度成果': 'fa-regular fa-file-lines', '我的自评': 'fa-regular fa-pen-to-square',
  '待我评价': 'fa-regular fa-clipboard-check', '我的结果': 'fa-solid fa-chart-simple', '反馈申诉': 'fa-regular fa-message',
  '组织架构': 'fa-solid fa-sitemap', '部门工作台': 'fa-solid fa-building', '材料与评价进度': 'fa-solid fa-bars-progress',
  '成员成长': 'fa-solid fa-seedling', '监管工作台': 'fa-solid fa-shield-halved', '周期与分配': 'fa-regular fa-calendar-days',
  '指标与规则': 'fa-solid fa-sliders', '评分核验': 'fa-solid fa-clipboard-check', '结果审批': 'fa-solid fa-square-check',
  '评优': 'fa-solid fa-award', '月报洞察': 'fa-solid fa-chart-line', '审计': 'fa-solid fa-list-check',
  '反馈申诉处理': 'fa-solid fa-inbox',
  '用户管理': 'fa-solid fa-users-gear', '管理工作台':'fa-solid fa-shield-halved','月评管理':'fa-regular fa-calendar-days','评价规则':'fa-solid fa-sliders','月评档案':'fa-solid fa-box-archive','系统设置':'fa-solid fa-gear','部长工作台':'fa-solid fa-building',
};

async function changePort() {
  sessionStorage.removeItem(workspaceKey);
  await auth.logout();
  await router.replace('/login');
}
async function switchWorkspace(key: WorkspaceKey) {
  const workspace = workspaces.value.find((w) => w.key === key);
  if (!workspace || switching.value) return;
  // Persist the choice before navigation. This prevents the router's `/`
  // default-home redirect from sending a multi-capability user back to the
  // highest-authority端口 while the new workspace is loading.
  selectedWorkspace.value = key;
  sessionStorage.setItem(workspaceKey, key);
  const home = workspace.items.some(i=>i.to===PORT_HOME[key]) ? PORT_HOME[key] : workspace.items[0]?.to;
  const target = route.path === home ? undefined : home;
  if (!target) return;
  switching.value = true;
  try { await router.replace(target); } finally { switching.value = false; }
}
watch(() => route.path, (path) => {
  const inferred = workspaceOfPath(path);
  // Do not overwrite an explicit choice on shared pages.
  if (inferred && !['/user-management', '/task-archive'].includes(path)) {
    selectedWorkspace.value = inferred;
    sessionStorage.setItem(workspaceKey, inferred);
  }
}, { immediate: true });
</script>

<template>
  <aside class="side">
    <div class="brand">
      <div class="brand-mark">360</div>
      <div><div class="brand-title">成长环评</div><div class="brand-sub">团队 360° 评价系统</div></div>
    </div>

    <div v-if="!auth.user?.isResultViewer&&workspaces.length>1&&workspaces.some(w=>w.key==='oversight')" class="workspace-switcher">
      <RouterLink class="workspace-switch" :to="activeKey==='oversight'?'/personal':'/management'">
        <span class="workspace-switch-icon" aria-hidden="true"><i :class="activeKey==='oversight'?'fa-regular fa-user':'fa-solid fa-shield-halved'"></i></span>
        <span>{{activeKey==='oversight'?'返回个人端':'进入管理端'}}</span>
        <svg class="workspace-switch-arrow" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" /></svg>
      </RouterLink>
    </div>

    <nav class="groups">
      <section v-if="activeWorkspace" :key="activeWorkspace.key" class="group">
        <div class="group-label">{{ activeWorkspace.label }}</div>
        <RouterLink
          v-for="n in activeWorkspace.items"
          :key="n.to"
          :to="n.to"
          class="nav-item"
          :class="{ 'nav-active': navItemActive(n, current) }"
        ><span class="nav-icon"><i :class="iconMap[n.label] ?? 'fa-solid fa-circle'" aria-hidden="true"></i></span><span class="nav-label">{{ n.label }}</span></RouterLink>
      </section>
      <div v-if="workspaces.length === 0" class="tag" style="padding:8px 10px">当前身份无可用入口</div>
    </nav>

    <div class="me">
      <div class="profile-row"><div class="avatar">{{ auth.user?.displayName?.slice(0, 1) }}</div><div><div class="me-name">{{ auth.user?.displayName }}</div><div class="profile-role">{{ auth.user?.deptName }}<template v-if="auth.user?.roles?.length"> · {{ auth.user?.roles.map(r=>({HEAD:'部长',MEMBER:'成员',SUPERVISOR:'监管人员'}[r]??'授权人员')).join('/') }}</template></div></div></div>
      <button class="btn btn-sm" style="margin-top:8px;width:100%" @click="changePort">退出并重新登录</button>
      <p class="foot-note">权限由服务端校验 · 数据实时同步</p>
    </div>
  </aside>
</template>

<style scoped>
/* 飞书风格侧栏：中性深色底（去掉蓝色渐变与发光），选中态扁平、克制 */
.side {
  flex: 0 0 252px; width: 252px; position: sticky; top: 0; height: 100vh;
  display: flex; flex-direction: column; color: var(--lark-text-1); background: #fff;
  border-right: 1px solid var(--lark-border-light);
}
.brand { min-height: 76px; padding: 16px 20px; border-bottom: 1px solid var(--lark-border-light); display: flex; align-items: center; gap: 12px; }
.brand-mark { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--lark-primary); color: #fff; box-shadow: 0 7px 15px rgba(51,112,255,.22); }
.brand-title { font-weight: 700; font-size: 17px; line-height: 22px; }
.brand-sub { color: var(--lark-text-3); font-size: 12px; margin-top: 2px; }
.groups { flex: 1; overflow-y: auto; padding: 18px 0 16px; }
.workspace-switcher { margin: 16px 14px 0; }
.workspace-switch {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px;
  box-sizing: border-box; padding: 10px 14px; border: 1px solid #dce6ff; border-radius: 10px;
  background: #f2f6ff; color: #285bd4; font-size: 14px; font-weight: 600; line-height: 24px;
  text-decoration: none; transition: background-color .15s ease, border-color .15s ease;
}
.workspace-switch:hover { background: #e7efff; border-color: #adc5ff; }
.workspace-switch:focus-visible { outline: 2px solid var(--lark-primary); outline-offset: 3px; }
.workspace-switch:active { background: #dce8ff; }
.workspace-switch-icon { display: grid; place-items: center; width: 22px; height: 24px; flex: none; font-size: 16px; }
.workspace-switch-arrow { margin-left: auto; flex: none; opacity: .75; }
.group { margin-top: 8px; }
.group-label { font-size: 11px; color: var(--lark-text-3); letter-spacing: .08em; padding: 8px 20px 7px; font-weight: 600; }
.nav-item {
  display: flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 14px; margin: 0 10px; border-radius: 8px;
  text-decoration: none; color: var(--lark-text-2); font-size: 14px;
  transition: background-color .1s ease, color .1s ease;
}
.nav-item:hover { background: var(--lark-bg-hover); color: var(--lark-text-1); }
.nav-item.nav-active { background: var(--lark-primary-bg) !important; color: var(--lark-primary) !important; font-weight: 600; }
.nav-icon {
  width: 20px; height: 20px; flex: none; display: grid; place-items: center;
  border-radius: 6px; font-size: 13px; color: inherit;
}
.nav-item.nav-active .nav-icon { color: var(--lark-primary); }
.groups .tag { color: var(--lark-text-3); }
.me { padding: 12px 16px 16px; border-top: 1px solid var(--lark-border-light); }
.profile-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.avatar { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; font-weight: 500; font-size: 13px; background: var(--lark-primary); color: #fff; }
.me-name { font-weight: 500; font-size: 13px; line-height: 18px; }
.profile-role { font-size: 12px; color: var(--lark-text-3); margin-top: 2px; }
.me select {
  margin-top: 4px; padding: 4px 8px; min-height: 28px; font-size: 13px;
  border: 1px solid var(--lark-border); border-radius: var(--lark-radius);
  background: #fff; color: var(--lark-text-1);
}
.me select:focus { border-color: var(--lark-primary); box-shadow: none; }
.me select option { color: var(--lark-text-1); }
.me .btn { color: var(--lark-text-2); background: #fff; border-color: var(--lark-border); min-height: 28px; }
.me .btn:hover { background: var(--lark-bg-hover); border-color: var(--lark-border); }
.foot-note { font-size: 12px; color: var(--lark-text-3); line-height: 18px; margin: 8px 0 0; }
@media (max-width: 820px) {
  .side { position: static; height: auto; width: 100%; flex: 0 0 auto; }
  .groups { display: flex; gap: 12px; overflow-x: auto; }
  .group { margin-top: 4px; }
}
</style>
