<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAuth } from '../stores/auth';
import { mockApi } from '../api';
import type { PersonalCycleData } from '../api/real';

const auth = useAuth();
const cycles = ref<Awaited<ReturnType<typeof mockApi.listCycles>>>([]);
const cycleData = ref<PersonalCycleData | null>(null);
const reportFiles = ref<Awaited<ReturnType<typeof mockApi.listReportFiles>> | null>(null);
const results = ref<Awaited<ReturnType<typeof mockApi.getMyResults>> | null>(null);
const feedback = ref<Awaited<ReturnType<typeof mockApi.listFeedback>> | null>(null);
const loading = ref(true);
const loadErrors = ref<string[]>([]);
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

const currentCycle = computed(() => cycles.value.find(cycle => cycle.status === 'REVIEWING')
  ?? cycles.value.find(cycle => cycle.status === 'CALIBRATING') ?? cycles.value[0]);
const statusLabels: Record<string, string> = {
  DRAFT: '草稿', PENDING_OPEN: '待开期', REVIEWING: '评价中', PAUSED: '已暂停', CALIBRATING: '核验中', PUBLISHED: '已发布', CANCELLED: '已取消',
};
const cycleStatus = computed(() => currentCycle.value ? statusLabels[currentCycle.value.status] ?? currentCycle.value.status : '暂无周期');
function timestamp(value?: string) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}
function formatTime(value?: string) {
  const time = timestamp(value);
  return time === null ? '' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(time);
}
const closeTime = computed(() => timestamp(currentCycle.value?.closeAt));
const periodOpen = computed(() => {
  const cycle = currentCycle.value;
  const start = timestamp(cycle?.openAt);
  return cycle?.status === 'REVIEWING' && (start === null || now.value >= start)
    && (closeTime.value === null || now.value < closeTime.value);
});
const periodUpcoming = computed(() => currentCycle.value && (
  ['DRAFT', 'PENDING_OPEN'].includes(currentCycle.value.status)
  || (currentCycle.value.status === 'REVIEWING' && (timestamp(currentCycle.value.openAt) ?? 0) > now.value)
));
const pendingPeers = computed(() => cycleData.value?.peers.filter(peer => peer.review?.status !== 'SUBMITTED').length ?? null);
const selfSubmitted = computed(() => cycleData.value?.self.status === 'SUBMITTED');
const currentReport = computed(() => reportFiles.value?.[0]);
// A report can have multiple file versions, but is still one personal monthly report.
const reportSubmitted = computed(() => !!currentReport.value && ['READY', 'LOCKED', 'PROCESSING'].includes(currentReport.value.status));
const selfLabel = computed(() => {
  if (loading.value) return '—';
  if (!currentCycle.value) return '暂无任务';
  if (!cycleData.value) return '暂不可用';
  if (selfSubmitted.value) return '已提交';
  if (!cycleData.value.eligible) return '未参与本期';
  if (currentCycle.value.status === 'CANCELLED') return '本期已取消';
  if (periodUpcoming.value) return '尚未开放';
  if (periodOpen.value && !cycleData.value.self.reviewId && closeTime.value === null) return '时间待配置';
  return periodOpen.value ? '待完成' : '已截止';
});
const publishedResult = computed(() => {
  const cycle = currentCycle.value;
  if (!cycle) return undefined;
  return results.value?.filter(result => result.cycleId === cycle.id || String(result.payloadJson.month ?? '').slice(0, 7) === cycle.month)
    .sort((a, b) => b.publicationVersion - a.publicationVersion)[0];
});
const icons = {
  report: 'M7 3h7l4 4v14H4V3h3m7 0v5h4M8 12h6M8 16h6',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  feedback: 'M21 11a8 8 0 0 1-8 8H7l-5 3V11a9 9 0 0 1 19 0ZM7 11h.01M12 11h.01M17 11h.01',
  self: 'M12 4H4v16h16v-8M16 3l5 5-9 9-5 1 1-5 8-10Z',
};
const metrics = computed(() => [
  { key: 'report', title: '月报文档', icon: icons.report,
    value: loading.value || !cycleData.value || !reportFiles.value ? '—' : cycleData.value.eligible ? `${reportSubmitted.value ? 1 : 0} / 1` : '—',
    note: !currentCycle.value ? '暂无环评周期' : !cycleData.value || !reportFiles.value ? '暂不可用' : !cycleData.value.eligible ? '本期无需提交' : currentReport.value?.status === 'FAILED' ? '文件处理失败，待重新上传' : currentReport.value?.status === 'PROCESSING' ? '已上传，文件处理中' : '已提交 / 应提交',
    tone: currentReport.value?.status === 'FAILED' ? 'danger' : '' },
  { key: 'peers', title: '待我评价', icon: icons.people, value: pendingPeers.value === null ? '—' : String(pendingPeers.value), note: !currentCycle.value ? '暂无环评周期' : !cycleData.value ? '暂不可用' : '本期尚未完成的评价', tone: '' },
  { key: 'self', title: '月度自评', icon: icons.self, value: selfLabel.value, note: !currentCycle.value ? '暂无环评周期' : cycleData.value?.eligible ? '本期个人自评状态' : cycleData.value ? '以实际参评名单为准' : '暂不可用', tone: selfSubmitted.value ? 'success' : '' },
  { key: 'received', title: '评价结果', icon: icons.feedback, value: loading.value ? '—' : results.value === null ? '暂不可用' : publishedResult.value ? '已发布' : '待发布', note: publishedResult.value ? '可前往我的结果查看' : '评价结果发布后可查看', tone: '' },
]);

type TodoState = 'pending' | 'done' | 'upcoming' | 'overdue' | 'closed' | 'processing' | 'failed';
interface Todo {
  key: string; title: string; description: string; icon: string; state: TodoState; status: string; deadline?: string;
  action?: { to: string; label: string; primary?: boolean };
}
function reviewState(done: boolean): Pick<Todo, 'state' | 'status'> {
  if (done) return { state: 'done', status: '已完成' };
  if (currentCycle.value?.status === 'CANCELLED') return { state: 'closed', status: '本期已取消' };
  if (periodUpcoming.value) return { state: 'upcoming', status: '尚未开放' };
  if (periodOpen.value) return { state: 'pending', status: '待完成' };
  if (closeTime.value !== null && now.value >= closeTime.value) return { state: 'overdue', status: '已逾期' };
  return { state: 'closed', status: currentCycle.value?.status === 'CANCELLED' ? '本期已取消' : '本期已结束' };
}
const todos = computed<Todo[]>(() => {
  if (!currentCycle.value || !cycleData.value) return [];
  const data = cycleData.value;
  const rows: Todo[] = [];
  const peerCount = data.peers.length;
  if (peerCount) {
    const pending = pendingPeers.value ?? 0;
    const state = reviewState(pending === 0);
    rows.push({ key: 'peers', title: '完成成员互评', description: pending ? `共 ${peerCount} 条评价，已完成 ${peerCount - pending} 条，尚有 ${pending} 条待提交` : `本期 ${peerCount} 条评价已全部提交`, icon: icons.people,
      ...state, deadline: formatTime(currentCycle.value.closeAt),
      action: state.state === 'pending' ? { to: '/tasks', label: '去评价', primary: true } : undefined });
  }
  if (data.eligible || data.self.reviewId) {
    const state = reviewState(selfSubmitted.value);
    if (state.state === 'pending' && !data.self.reviewId && closeTime.value === null) {
      state.state = 'upcoming'; state.status = '时间待配置';
    }
    rows.push({ key: 'self', title: '提交月度自评', description: selfSubmitted.value ? '本周期个人自评已提交' : '填写本月工作总结、下月计划与自评分', icon: icons.self,
      ...state, deadline: formatTime(currentCycle.value.closeAt),
      action: state.state === 'pending' ? { to: '/self-review', label: '去自评' } : undefined });
  }
  if (data.eligible && reportFiles.value !== null) {
    const report = currentReport.value;
    const canUpload = currentCycle.value.status === 'REVIEWING' && report?.status !== 'LOCKED';
    const state: Pick<Todo, 'state' | 'status'> = report?.status === 'FAILED' ? { state: 'failed', status: '处理失败' }
      : report?.status === 'PROCESSING' ? { state: 'processing', status: '处理中' }
      : reportSubmitted.value ? { state: 'done', status: '已提交' }
      : canUpload ? { state: 'pending', status: '待完成' }
      : periodUpcoming.value ? { state: 'upcoming', status: '尚未开放' } : { state: 'closed', status: '提交已关闭' };
    rows.push({ key: 'report', title: '提交月度成果', description: report ? String(report.fileName) : '每人每周期提交一份有效月报，供自评与他评引用', icon: icons.report, ...state,
      // The existing upload endpoint is gated by cycle status / file lock, not close_at.
      // Do not invent a report deadline or impose the review submission window on it.
      action: canUpload && ['pending', 'failed'].includes(state.state) ? { to: '/monthly-report', label: state.state === 'failed' ? '重新上传' : '去提交' } : undefined });
  }
  const openFeedback = feedback.value?.filter(item => item.cycleId === currentCycle.value?.id && ['PENDING', 'REREVIEW_PENDING'].includes(item.status)).length ?? 0;
  if (openFeedback) rows.push({ key: 'feedback', title: '查看反馈申诉进度', description: `本期有 ${openFeedback} 条反馈申诉正在处理中`, icon: icons.feedback, state: 'processing', status: '处理中', action: { to: '/feedback', label: '查看进度' } });
  return rows;
});
const actionCount = computed(() => todos.value.filter(row => row.state === 'pending' || row.state === 'failed').length);
const quickLinks = [
  { title: '月度成果', description: '上传月报，记录本月的工作成果。', to: '/monthly-report', icon: icons.report },
  { title: '月度自评', description: '总结本月工作，明确下月行动计划。', to: '/self-review', icon: icons.self },
  { title: '匿名成长反馈', description: '查看已发布的个人匿名汇总结果。', to: '/my-results', icon: icons.feedback },
];

async function loadDashboard() {
  loading.value = true;
  loadErrors.value = [];
  cycleData.value = null; reportFiles.value = null; results.value = null; feedback.value = null;
  try {
    const user = auth.user;
    if (!user) return;
    cycles.value = await mockApi.listCycles();
    const cycle = currentCycle.value;
    if (!cycle) return;
    const sources = await Promise.allSettled([
      mockApi.getPersonalCycleData(cycle.id, user.id), mockApi.listReportFiles(cycle.id),
      mockApi.getMyResults(user.id), mockApi.listFeedback(user.id),
    ]);
    const [personal, files, published, requests] = sources;
    if (personal.status === 'fulfilled') cycleData.value = personal.value; else loadErrors.value.push('个人任务与参评信息');
    if (files.status === 'fulfilled') reportFiles.value = files.value; else loadErrors.value.push('月报文件');
    if (published.status === 'fulfilled') results.value = published.value; else loadErrors.value.push('已发布结果');
    if (requests.status === 'fulfilled') feedback.value = requests.value; else loadErrors.value.push('反馈进度');
  } catch { cycles.value = []; loadErrors.value.push('环评周期'); }
  finally { loading.value = false; }
}
onMounted(() => { void loadDashboard(); clock = setInterval(() => { now.value = Date.now(); }, 30_000); });
onUnmounted(() => { if (clock) clearInterval(clock); });
</script>

<template>
  <div class="personal-workspace" :aria-busy="loading">
    <header class="workspace-heading">
      <div>
        <h1>个人工作台</h1>
        <p class="identity-line"><span>{{ auth.user?.displayName }}</span><span>{{ auth.user?.deptName || '未配置部门' }}</span><span>{{ currentCycle ? `${currentCycle.month} 环评` : loading ? '正在读取环评周期…' : '暂无环评周期' }}</span></p>
      </div>
      <div v-if="currentCycle" class="cycle-summary">
        <span class="cycle-badge" :class="{ published: currentCycle.status === 'PUBLISHED' }"><i aria-hidden="true"></i>{{ cycleStatus }}</span>
        <div><strong>{{ currentCycle.title }}</strong><small v-if="formatTime(currentCycle.openAt) || formatTime(currentCycle.closeAt)">{{ formatTime(currentCycle.openAt) || '开始时间未配置' }} — {{ formatTime(currentCycle.closeAt) || '结束时间未配置' }}</small></div>
      </div>
    </header>

    <div v-if="loadErrors.length" class="load-notice" role="alert"><span>{{ loadErrors.join('、') }}暂未加载成功，相关数据以“—”显示。</span><button type="button" :disabled="loading" @click="loadDashboard">重试</button></div>

    <section class="workspace-section" aria-labelledby="overview-heading">
      <div class="section-heading"><h2 id="overview-heading">本月概览</h2><span v-if="loading" role="status">正在读取个人数据…</span></div>
      <div class="overview-grid">
        <article v-for="metric in metrics" :key="metric.key" class="metric-card" :data-metric="metric.key">
          <span class="workspace-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="metric.icon" /></svg></span>
          <div class="metric-copy"><h3>{{ metric.title }}</h3><strong :class="[metric.tone, { 'text-value': metric.key === 'self' }]">{{ loading ? '—' : metric.value }}</strong><p>{{ loading ? '正在加载' : metric.note }}</p></div>
        </article>
      </div>
    </section>

    <section class="workspace-section" aria-labelledby="todos-heading">
      <div class="section-heading"><div class="section-title"><h2 id="todos-heading">本月待办</h2><span v-if="!loading && actionCount" class="task-count">{{ actionCount }} 项待处理</span></div><span class="section-description">按本期实际任务与开放状态展示</span></div>
      <div v-if="loading" class="workspace-empty" role="status">正在加载本期任务…</div>
      <div v-else-if="!currentCycle" class="workspace-empty">{{ loadErrors.length ? '周期信息暂不可用，请稍后重试。' : '当前暂无环评周期，暂不需要提交评价。' }}</div>
      <div v-else-if="!cycleData" class="workspace-empty">个人任务信息暂不可用，请稍后重试。</div>
      <div v-else-if="!todos.length" class="workspace-empty">本期暂无需要你处理的任务。</div>
      <div v-else class="todo-list">
        <article v-for="todo in todos" :key="todo.key" class="todo-row" :data-todo="todo.key">
          <span class="workspace-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="todo.icon" /></svg></span>
          <div class="todo-copy"><h3>{{ todo.title }}</h3><p>{{ todo.description }}</p></div>
          <div class="todo-deadline" v-if="todo.deadline"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>截止时间：{{ todo.deadline }}</span></div>
          <span class="task-status" :class="todo.state">{{ todo.status }}</span>
          <RouterLink v-if="todo.action" :to="todo.action.to" class="todo-action" :class="{ primary: todo.action.primary }">{{ todo.action.label }}<span aria-hidden="true">→</span></RouterLink>
        </article>
      </div>
    </section>

    <section class="workspace-section" aria-labelledby="shortcuts-heading">
      <div class="section-heading"><h2 id="shortcuts-heading">快捷入口</h2></div>
      <div class="shortcut-grid">
        <RouterLink v-for="link in quickLinks" :key="link.to" :to="link.to" class="shortcut-card">
          <span class="workspace-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="link.icon" /></svg></span>
          <div><h3>{{ link.title }}</h3><p>{{ link.description }}</p></div><span class="shortcut-arrow" aria-hidden="true">→</span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.personal-workspace { --workspace-blue: #246bfd; --workspace-title: #172b4d; --workspace-muted: #667085; --workspace-border: #e4ebf5; display: grid; gap: 20px; min-width: 0; color: var(--workspace-title); }
.workspace-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 20px; padding: 0 2px 4px; min-height: 82px; }
.workspace-heading h1 { margin: 0 0 12px; font-size: 28px; font-weight: 650; line-height: 1.4; letter-spacing: -.02em; }
.identity-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 0; margin: 0; color: var(--workspace-muted); font-size: 14px; line-height: 22px; }
.identity-line span + span::before { content: '·'; margin: 0 10px; color: #a6b1c0; }
.cycle-summary { display: flex; align-items: center; gap: 14px; max-width: 100%; padding: 12px 16px; border: 1px solid var(--workspace-border); border-radius: 11px; background: rgba(255,255,255,.9); box-shadow: 0 5px 16px rgba(48,82,142,.07); }
.cycle-summary strong { display: block; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.cycle-summary small { display: block; margin-top: 4px; font-size: 12px; color: var(--workspace-muted); }
.cycle-badge { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 3px 9px; border-radius: 5px; background: #edf4ff; color: #285fad; font-size: 12px; white-space: nowrap; }
.cycle-badge i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.cycle-badge.published { color: #23805a; background: #ecf8f1; }
.workspace-section { min-width: 0; padding: 20px; border: 1px solid var(--workspace-border); border-radius: 12px; background: rgba(255,255,255,.96); box-shadow: 0 5px 16px rgba(48,82,142,.055); }
.section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.section-heading h2 { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
.section-heading > span, .section-description { font-size: 13px; color: var(--workspace-muted); }
.section-title { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.task-count { padding: 2px 8px; border-radius: 5px; background: #edf4ff; color: #3e6cb3; font-size: 12px; }
.overview-grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 14px; }
.metric-card { display: flex; align-items: flex-start; gap: 12px; min-width: 0; padding: 20px 16px; border: 1px solid var(--workspace-border); border-radius: 10px; background-color: #f6faff; background-repeat: no-repeat; background-position: right center; background-size: 100% 100%, auto 100%; box-shadow: 0 3px 10px rgba(48,82,142,.035); }
.workspace-icon { display: grid; place-items: center; flex: 0 0 36px; width: 36px; height: 36px; border-radius: 50%; background: #edf3ff; color: var(--workspace-blue); }
.workspace-icon svg { width: 20px; height: 20px; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.metric-copy { min-width: 0; position: relative; z-index: 1; }
.metric-copy h3 { margin: 0 0 8px; font-size: 14px; color: #54647b; font-weight: 500; line-height: 22px; }
.metric-copy > strong { display: block; color: var(--workspace-title); font-family: inherit; font-size: 28px; font-weight: 650; line-height: 36px; font-variant-numeric: tabular-nums; }
.metric-copy > strong.text-value { font-size: 22px; }
.metric-copy p { margin: 7px 0 0; color: var(--workspace-muted); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.metric-copy .success { color: #23805a; }
.metric-copy .danger { color: #bf3931; }
.todo-list { border: 1px solid var(--workspace-border); border-radius: 10px; background: #fff; box-shadow: 0 2px 9px rgba(48,82,142,.035); overflow: hidden; }
.todo-row { display: flex; align-items: center; gap: 14px; min-width: 0; padding: 18px 16px; }
.todo-row + .todo-row { border-top: 1px solid var(--workspace-border); }
.todo-copy { flex: 1; min-width: 140px; }
.todo-copy h3 { margin: 0; font-size: 15px; font-weight: 600; line-height: 24px; }
.todo-copy p { margin: 4px 0 0; font-size: 13px; line-height: 21px; color: var(--workspace-muted); overflow-wrap: anywhere; }
.todo-deadline { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #78869a; }
.todo-deadline svg { width: 15px; height: 15px; flex-shrink: 0; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.task-status { min-width: 48px; font-size: 12px; color: var(--workspace-muted); white-space: nowrap; }
.task-status.pending, .task-status.processing { color: #3e6cb3; }
.task-status.done { color: #23805a; }
.task-status.overdue, .task-status.failed { color: #bf3931; }
.todo-action { display: inline-flex; justify-content: center; align-items: center; gap: 12px; flex-shrink: 0; min-width: 100px; min-height: 36px; padding: 6px 14px; border: 1px solid #d9e4f7; border-radius: 7px; color: #2c507e; background: #f7faff; font-size: 13px; text-decoration: none; }
.todo-action.primary { color: #fff; border-color: var(--workspace-blue); background: var(--workspace-blue); box-shadow: 0 4px 9px rgba(36,107,253,.16); }
.todo-action:hover { border-color: var(--workspace-blue); color: var(--workspace-blue); background: #eef4ff; }
.todo-action.primary:hover { color: #fff; background: #195bdf; }
.shortcut-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; }
.shortcut-card { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 20px 16px; border: 1px solid var(--workspace-border); border-radius: 9px; color: var(--workspace-title); background: #fff; box-shadow: 0 3px 10px rgba(48,82,142,.045); text-decoration: none; transition: border-color .15s ease, background-color .15s ease; }
.shortcut-card > div { flex: 1; min-width: 0; }
.shortcut-card h3 { margin: 0 0 5px; font-size: 15px; font-weight: 600; line-height: 24px; }
.shortcut-card p { margin: 0; color: var(--workspace-muted); font-size: 13px; line-height: 20px; }
.shortcut-arrow { color: var(--workspace-blue); font-size: 18px; }
.shortcut-card:hover { border-color: #b4ccfb; background: #f9fbff; color: var(--workspace-title); }
.shortcut-card:focus-visible, .todo-action:focus-visible, .load-notice button:focus-visible { outline: 3px solid #a7c3ff; outline-offset: 3px; }
.workspace-empty { padding: 34px 16px; text-align: center; color: var(--workspace-muted); font-size: 14px; line-height: 24px; }
.load-notice { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 16px; border: 1px solid #dce7f8; border-radius: 8px; background: #eef4ff; color: #4b6486; font-size: 13px; }
.load-notice button { flex-shrink: 0; border: 0; background: transparent; color: var(--workspace-blue); font: inherit; cursor: pointer; }
/* User-provided artwork already includes decorative illustrations. */
.metric-card[data-metric="report"] { background-image: linear-gradient(#ffffff40, #ffffff40), url('../assets/personal-workspace/overview-report-blue.png'); border-color: #e5edfb; }
.metric-card[data-metric="peers"] { background-image: linear-gradient(#ffffff40, #ffffff40), url('../assets/personal-workspace/overview-peers-orange.png'); border-color: #f7efe3; background-color: #fffaf3; }
.metric-card[data-metric="received"] { background-image: linear-gradient(#ffffff40, #ffffff40), url('../assets/personal-workspace/overview-received-purple.png'); border-color: #ece9fb; background-color: #f9f7ff; }
.metric-card[data-metric="self"] { background-image: linear-gradient(#ffffff40, #ffffff40), url('../assets/personal-workspace/overview-self-teal.png'); border-color: #e1f1ee; background-color: #f4fcfa; }
.metric-card[data-metric="peers"] .workspace-icon { color: #cf8b2c; background: #fff3e2; }
.metric-card[data-metric="received"] .workspace-icon { color: #7768d9; background: #efedff; }
.metric-card[data-metric="self"] .workspace-icon { color: #209e92; background: #e4f6f2; }
.metric-card .workspace-icon { position: relative; z-index: 1; }
@media (min-width: 1001px) and (max-width: 1200px) { .metric-card { background-size: 100% 100%, auto 100%; } }
@media (max-width: 560px) { .metric-card { background-size: 100% 100%, auto 100%; } }
@media (max-width: 1200px) { .metric-card { flex-direction: column; padding: 16px; } .todo-row { flex-wrap: wrap; } .todo-deadline { margin-left: 50px; order: 3; flex-basis: calc(100% - 50px); } }
@media (max-width: 1000px) { .overview-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } .metric-card { flex-direction: row; } .shortcut-grid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .personal-workspace { gap: 16px; } .workspace-section { padding: 16px; } .workspace-heading h1 { font-size: 25px; } .overview-grid { grid-template-columns: 1fr; } .metric-card { padding: 16px; } .cycle-summary { flex-wrap: wrap; padding: 12px; } .todo-row { gap: 10px; padding: 16px 12px; } .todo-copy { min-width: calc(100% - 50px); } .todo-deadline { margin-left: 0; flex-basis: 100%; order: 0; } .task-status { margin-left: 46px; } .todo-action { margin-left: auto; } }
@media (prefers-reduced-motion: reduce) { .shortcut-card { transition: none; } }
</style>
