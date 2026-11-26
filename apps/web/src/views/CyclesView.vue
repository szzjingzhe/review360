<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mockApi, userName } from '../api';
import { useAuth } from '../stores/auth';
import AssignmentPanel from '../components/AssignmentPanel.vue';
import {managementRequest} from '../api/management';

const route = useRoute();
const router = useRouter();
const auth = useAuth();
const cycles = ref<any[]>([]);
const detail = ref<any>(null);
const rulesets = ref<any[]>([]);
const showCreate = ref(false);
const showEdit = ref(false);
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const message = ref('');
const preview = ref<any>(null);
const scoreRows = ref<any[]>([]);
const progressRows = ref<any[]>([]);
const CORE_DEPARTMENTS = ['科技部', '研发部', '产品部', '网监部', '生态部'];
const today = new Date();
const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
const form = ref({ month, title: '', rulesetId: '', openAt: `${month}-28T09:00`, closeAt: `${month}-29T23:59`, publishAt: `${month}-30T23:59` });
const isDetail = computed(() => !!route.params.cycleId);
const counts = computed(() => ({ all: cycles.value.length, active: cycles.value.filter((c) => ['REVIEWING', 'CALIBRATING'].includes(c.status)).length, draft: cycles.value.filter((c) => ['DRAFT', 'PENDING_OPEN'].includes(c.status)).length, archived: cycles.value.filter((c) => ['PUBLISHED', 'ARCHIVED'].includes(c.status)).length }));
const statusLabel: Record<string, string> = { DRAFT: '草稿', PENDING_OPEN: '待开始', REVIEWING: '评价中', CALIBRATING: '已截止 · 待发布结果', PARTIALLY_PUBLISHED: '部分发布', PUBLISHED: '已发布', ARCHIVED: '已归档', CANCELLED: '已取消' };
const statusClass = (s: string) => ['REVIEWING'].includes(s) ? 'chip-blue' : ['CALIBRATING', 'PENDING_OPEN'].includes(s) ? 'chip-amber' : ['PUBLISHED', 'ARCHIVED'].includes(s) ? 'chip-green' : s === 'CANCELLED' ? 'chip-red' : 'chip-gray';
const phaseIndex = (s: string) => ['DRAFT', 'PENDING_OPEN'].includes(s) ? 0 : s === 'REVIEWING' ? 1 : ['CALIBRATING', 'PARTIALLY_PUBLISHED'].includes(s) ? 2 : 3;
const dateText = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '未设置';
const localInputTime=(value:string)=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};

onMounted(async () => { await load(); });
watch(() => route.params.cycleId, async (id) => {
  detail.value = null;
  preview.value = null;
  scoreRows.value = [];
  progressRows.value = [];
  message.value = '';
  error.value = '';
  if (id) await loadDetail(String(id));
});
async function load() {
  error.value = '';
  try {
    [cycles.value, rulesets.value] = await Promise.all([mockApi.listCycles(), mockApi.listRulesets()]);
    if (!form.value.rulesetId) form.value.rulesetId = rulesets.value.find((r) => r.status === 'FROZEN')?.id ?? '';
    if (isDetail.value) await loadDetail(String(route.params.cycleId));
  } catch (e: any) { error.value = e?.message ?? '加载失败'; }
}
async function loadDetail(id: string) {
  loading.value = true;
  try {
    const result = await mockApi.getCycle(id);
    let scores: any[] = [];
    if(auth.user?.capabilities.includes('calibration.read_raw')){try { scores = await mockApi.listReviewScores(id); } catch { scores = []; }}
    try {
      const org = await mockApi.getOrganization();
      const depts = (org.departments ?? []).filter((d: any) => CORE_DEPARTMENTS.includes(String(d.name).trim()) && (auth.user?.capabilities.includes('org.manage') || d.id === auth.user?.deptId));
      const rawRows = await Promise.all(depts.map(async (d: any) => ({ dept: d, data: await mockApi.getDepartmentProgress(id, d.id) })));
      // 飞书组织可能存在同名部门（历史部门/重复同步记录）。周期进度按名称展示，
      // 同名记录优先保留本周期有参评成员的那条，避免出现“科技部 9 人”和“科技部 0 人”两行。
      const byName = new Map<string, any>();
      for (const row of rawRows) {
        const name = String(row.dept.name).trim();
        const old = byName.get(name);
        if (!old || memberCount(row.data) > memberCount(old.data)) byName.set(name, row);
      }
      progressRows.value = CORE_DEPARTMENTS.filter(name => byName.has(name)).map(name => byName.get(name));
    } catch { progressRows.value = []; }
    if (String(route.params.cycleId) === id) {
      detail.value = result ?? null;
      scoreRows.value = scores;
      if (!result) error.value = '未找到该环评记录，可能已被删除或无权查看。';
    }
  } catch (e: any) {
    if (String(route.params.cycleId) === id) error.value = e?.message ?? '环评详情加载失败';
  } finally {
    if (String(route.params.cycleId) === id) loading.value = false;
  }
}
const scoreSummary = computed(() => {
  const rows = scoreRows.value;
  const submitted = rows.filter(r => ['SUBMITTED', 'PUBLISHED', 'APPROVED'].includes(String(r.status ?? '').toUpperCase())).length;
  const values = rows.map(r => Number(r.finalScore ?? r.final_score ?? r.score ?? ((r.scoreBp ?? r.score_bp) != null ? Number(r.scoreBp ?? r.score_bp) / 100 : NaN))).filter(Number.isFinite);
  return { submitted, total: rows.length, average: values.length ? (values.reduce((a,b) => a+b, 0) / values.length).toFixed(2) : '—' };
});
const departmentSummary = computed(() => {
  const map = new Map<string, { name: string; total: number; submitted: number; values: number[] }>();
  for (const r of scoreRows.value) {
    const name = r.dept_name ?? r.deptName ?? r.department_name ?? r.department ?? '未分配部门';
    const x: { name: string; total: number; submitted: number; values: number[] } = map.get(name) ?? { name, total: 0, submitted: 0, values: [] }; x.total++;
    if (['SUBMITTED','PUBLISHED','APPROVED'].includes(String(r.status ?? '').toUpperCase())) x.submitted++;
    const v = Number(r.finalScore ?? r.final_score ?? r.score ?? ((r.scoreBp ?? r.score_bp) != null ? Number(r.scoreBp ?? r.score_bp) / 100 : NaN)); if (Number.isFinite(v)) x.values.push(v);
    map.set(name, x);
  }
  return [...map.values()].map(x => ({ ...x, average: x.values.length ? (x.values.reduce((a,b) => a+b, 0) / x.values.length).toFixed(2) : '—' }));
});
const isOversight = computed(() => auth.user?.capabilities.includes('org.manage'));
const progressText = (d: any) => { const v = d.progressPct ?? d.progress_pct; return v == null ? '—' : `${v}%`; };
const memberCount = (d: any) => d.memberCount ?? d.member_count ?? d.members?.length ?? 0;
const selfDone = (d: any) => d.selfDone ?? d.self_done ?? d.members?.filter((m: any) => m.selfStatus === 'SUBMITTED' || m.self_status === 'SUBMITTED').length ?? 0;
const peerDone = (d: any) => d.peerReceived ?? d.peer_received ?? d.members?.reduce((n: number, m: any) => n + Number(m.peerReceived ?? m.peer_received ?? 0), 0) ?? 0;
const peerExpected = (d: any) => d.peerExpected ?? d.peer_expected ?? d.members?.reduce((n: number, m: any) => n + Number(m.peerExpected ?? m.peer_expected ?? 0), 0) ?? 0;
const progressLabel = (d: any) => `${selfDone(d)} / ${memberCount(d)} 自评 · ${peerDone(d)} / ${peerExpected(d)} 他评`;
function setMonth(value: string) {
  form.value.month = value;
  const [y, m] = value.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const openDay = Math.min(28, days), closeDay = Math.min(openDay + 1, days), publishDay = days;
  const d = (n: number) => String(n).padStart(2, '0');
  form.value.openAt = `${value}-${d(openDay)}T09:00`;
  form.value.closeAt = `${value}-${d(closeDay)}T23:59`;
  form.value.publishAt = `${value}-${d(publishDay)}T23:59`;
}
function scheduleValid() {
  const a = new Date(form.value.openAt).getTime(), b = new Date(form.value.closeAt).getTime(), c = new Date(form.value.publishAt).getTime();
  return a < b && b <= c;
}
function friendlyCreateError(e: any): string {
  const code = String(e?.code ?? e?.message ?? '');
  if (code.startsWith('CYCLE_ACTIVE_EXISTS')) return '已有进行中的月评周期，不能同时开启第二期。请先完成或撤销当前周期，再发起新一期。';
  if (code.startsWith('CYCLE_CREATE_CONFLICT')) return '周期创建冲突，请刷新页面后重试。';
  if (code.startsWith('SCHEDULE_INVALID')) return '时间顺序不合法：开始时间必须早于截止时间，公布时间不得早于截止时间。';
  if (code.startsWith('RULESET_NOT_FROZEN')) return '所选评分规则尚未冻结，不能用于开期。';
  if (code.startsWith('NOT_DRAFT')) return '只有草稿状态的周期可以修改。';
  return e?.message ?? '创建失败';
}
async function doCreate() {
  error.value = ''; message.value = '';
  if (!form.value.rulesetId) { error.value = '请先选择已冻结的评分规则。'; return; }
  if (!scheduleValid()) { error.value = '请检查时间顺序：开始时间必须早于截止时间，公布时间不得早于截止时间。'; return; }
  busy.value = true;
  try {
    // 同月可有多期：不再按月份合并草稿或拦截，直接新建（标题由后端按期次自动顺延）。
    // 「同时只允许一期进行中」由后端在开期时校验，不在这里挡。
    const sameMonth = cycles.value.filter((cycle) => String(cycle.month).slice(0, 7) === form.value.month);
    const c: any = await mockApi.createCycle({ ...form.value });
    const seq = sameMonth.length + 1;
    if (seq > 1) message.value = `${form.value.month} 已有 ${seq - 1} 期，本次创建第 ${seq} 期。同月可有多期，但同一时间只能有一期进行中。`;
    showCreate.value = false;
    await router.push('/cycles/' + c.id);
    await load();
  } catch (e: any) { error.value = friendlyCreateError(e); }
  finally { busy.value = false; }
}
function startEdit() {
  if (!detail.value || detail.value.status !== 'DRAFT') return;
  form.value = { month: String(detail.value.month).slice(0, 7), title: detail.value.title, rulesetId: detail.value.rulesetId ?? detail.value.ruleset_id ?? '', openAt: localInputTime(detail.value.openAt ?? detail.value.open_at), closeAt: localInputTime(detail.value.closeAt ?? detail.value.close_at), publishAt: localInputTime(detail.value.publishAt ?? detail.value.publish_at) };
  showEdit.value = true;
}
async function doEdit() {
  if (!detail.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { detail.value = await mockApi.updateCycle(detail.value.id, form.value); showEdit.value = false; await load(); message.value = '环评周期已更新。'; }
  catch (e: any) { error.value = e?.message ?? '修改失败'; }
  finally { busy.value = false; }
}
async function doDelete() {
  if (!detail.value || !confirm(`确定删除“${detail.value.title}”吗？删除后不可恢复。`)) return;
  busy.value = true; error.value = '';
  try { await mockApi.deleteCycle(detail.value.id); await router.push('/cycles'); await load(); }
  catch (e: any) { error.value = e?.message ?? '删除失败'; }
  finally { busy.value = false; }
}
async function archiveCycle(){if(!detail.value||!confirm('明确归档此已发布周期？'))return;busy.value=true;try{await managementRequest(`cycles/${detail.value.id}/archive`,{});await load();}catch(e){error.value=String(e);}finally{busy.value=false;}}
async function cancelCycle(){if(!detail.value)return;const reason=prompt('填写撤销原因（必填，历史记录保留）');if(!reason?.trim())return;busy.value=true;try{await managementRequest(`cycles/${detail.value.id}/cancel`,{reason});await load();}catch(e){error.value=String(e);}finally{busy.value=false;}}
async function doPreview() {
  if (!detail.value) return;
  busy.value = true; error.value = '';
  try { preview.value = await mockApi.previewCycle(detail.value.id); }
  catch (e: any) { error.value = e?.message ?? '名单预检失败'; }
  finally { busy.value = false; }
}
async function doOpen() {
  if (!detail.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { if(!preview.value?.[0]?.id||preview.value[0].feasible===false)throw new Error('请先预览并确认完整评价关系。'); detail.value = await mockApi.confirmAssignment(detail.value.id,preview.value[0].id);preview.value=null; message.value = `评价关系已确认，当前状态：${statusLabel[detail.value.status] ?? detail.value.status}`; await load(); }
  catch (e: any) { error.value = e?.message ?? '发起失败'; }
  finally { busy.value = false; }
}
</script>

<template>
  <div>
    <template v-if="!isDetail">
      <div class="page-head">
        <div><p class="eyebrow">MONTHLY REVIEW · GOVERNANCE</p><h1 class="page-title">月评发起与进程</h1><p class="page-sub">按周期统筹时间、评分规则、评审名单与发布进程。</p></div>
        <button class="btn btn-primary" @click="showCreate = !showCreate">{{ showCreate ? '收起表单' : '＋ 创建月评周期' }}</button>
      </div>

      <div class="metric-grid">
        <article class="metric-card"><span class="metric-label">全部周期</span><strong>{{ counts.all }}</strong><small>组织内月评记录</small></article>
        <article class="metric-card metric-blue"><span class="metric-label">进行中</span><strong>{{ counts.active }}</strong><small>评价或核验阶段</small></article>
        <article class="metric-card metric-amber"><span class="metric-label">待筹备 / 审核</span><strong>{{ counts.draft }}</strong><small>需确认时间与名单</small></article>
        <article class="metric-card metric-green"><span class="metric-label">已发布 / 归档</span><strong>{{ counts.archived }}</strong><small>可查看历史记录</small></article>
      </div>

      <section v-if="showCreate" class="card create-card">
        <div class="section-heading"><div><h2>创建月评周期</h2><p>时间将写入周期计划，并由服务端校验先后顺序。</p></div><span class="chip chip-blue">01 · 周期配置</span></div>
        <div class="form-grid">
          <div class="field"><label>评价月份</label><input type="month" :value="form.month" @input="setMonth(($event.target as HTMLInputElement).value)" /></div>
          <div class="field"><label>周期名称</label><input v-model="form.title" placeholder="例如：2026年10月月度环评" /></div>
          <div class="field"><label>开始时间</label><input v-model="form.openAt" type="datetime-local" /></div>
          <div class="field"><label>评价截止</label><input v-model="form.closeAt" type="datetime-local" /></div>
          <div class="field"><label>结果公布时间</label><input v-model="form.publishAt" type="datetime-local" /></div>
          <div class="field"><label>评分规则</label><select v-model="form.rulesetId"><option value="" disabled>选择已冻结规则集</option><option v-for="r in rulesets" :key="r.id" :value="r.id" :disabled="r.status !== 'FROZEN'">{{ r.name }} · {{ r.status === 'FROZEN' ? '已冻结' : '未冻结' }}</option></select></div>
        </div>
        <p v-if="!scheduleValid()" class="notice notice-warning">时间顺序无效：开始时间必须早于截止时间，公布时间不得早于截止时间。</p>
        <div class="form-actions"><span class="muted">创建后会生成参评名单快照；正式发起前可进行名单预检。</span><button class="btn btn-primary" :disabled="busy || !scheduleValid()" @click="doCreate">{{ busy ? '正在创建…' : '创建并继续' }}</button></div>
      </section>

      <p v-if="error" class="notice notice-warning" role="alert">{{ error }}</p>
      <div v-if="!cycles.length && !error" class="empty-state"><div class="empty-icon">月</div><h2>还没有月评周期</h2><p>创建周期后，系统会基于组织名单生成参评快照。当前不会展示模拟周期或示例统计。</p><button class="btn btn-primary" @click="showCreate = true">创建第一个周期</button></div>
      <section v-else class="card cycle-card">
        <div class="section-heading"><div><h2>周期列表</h2><p>选择周期查看阶段进度和评审名单预检。</p></div><span class="muted">{{ cycles.length }} 个周期</span></div>
        <div class="table-wrap"><table class="table cycles-table"><thead><tr><th>周期</th><th>阶段</th><th>参评人数</th><th>评价窗口</th><th>公布时间</th><th></th></tr></thead>
          <tbody><tr v-for="c in cycles" :key="c.id" class="click-row" @click="router.push('/cycles/' + c.id)">
            <td><b>{{ c.title }}</b><small>{{ String(c.month).slice(0, 7) }}</small></td>
            <td><span class="chip" :class="statusClass(c.status)">{{ statusLabel[c.status] ?? c.status }}</span></td>
            <td>{{ c.participantCount ?? c.participants?.length ?? '—' }} 人</td>
            <td>{{ dateText(c.openAt) }}<small>至 {{ dateText(c.closeAt) }}</small></td>
            <td>{{ dateText(c.publishAt) }}</td><td><span class="row-arrow">查看 →</span></td>
          </tr></tbody>
        </table></div>
      </section>
    </template>

    <template v-else-if="detail">
      <button class="back-link" @click="router.push('/cycles')">← 返回周期列表</button>
      <div class="page-head detail-head"><div><p class="eyebrow">{{ String(detail.month).slice(0, 7) }} · MONTHLY REVIEW</p><h1 class="page-title">{{ detail.title }}</h1><p class="page-sub">周期状态 <span class="chip" :class="statusClass(detail.status)">{{ statusLabel[detail.status] ?? detail.status }}</span></p></div><div class="head-actions"><button v-if="detail.status==='PUBLISHED'" class="btn" :disabled="busy" @click="archiveCycle">明确归档</button><button v-if="['DRAFT','PENDING_OPEN','REVIEWING','CALIBRATING'].includes(detail.status)" class="btn" :disabled="busy" @click="cancelCycle">撤销周期</button><button v-if="detail.status === 'DRAFT'" class="btn" :disabled="busy" @click="startEdit">修改</button><button v-if="detail.status === 'DRAFT'" class="btn btn-danger" :disabled="busy" @click="doDelete">删除</button><button class="btn" :disabled="busy" @click="doPreview">名单预检</button><button v-if="detail.status === 'DRAFT' || detail.status === 'PENDING_OPEN'" class="btn btn-primary" :disabled="busy" @click="doOpen">{{ busy ? '处理中…' : '审核通过并发起' }}</button></div></div>
      <div v-if="error" class="notice notice-warning">{{ error }}</div><div v-if="message" class="notice notice-info">{{ message }}</div>
      <section class="metric-grid detail-metrics">
        <article class="metric-card"><span class="metric-label">校内参评人员</span><strong>{{ detail.participants?.length ?? '—' }} 人</strong><small>本周期名单快照</small></article>
        <article class="metric-card metric-blue"><span class="metric-label">已提交他评</span><strong>{{ scoreSummary.submitted }} / {{ scoreSummary.total || '—' }}</strong><small>实时读取评分数据</small></article>
        <article class="metric-card metric-green"><span class="metric-label">平均得分</span><strong>{{ scoreSummary.average }}</strong><small>{{ scoreRows.length ? '已产生评分的成员' : '暂无评分数据' }}</small></article>
        <article class="metric-card metric-amber"><span class="metric-label">当前阶段</span><strong>{{ statusLabel[detail.status] ?? detail.status }}</strong><small>按周期状态实时更新</small></article>
      </section>
      <section v-if="departmentSummary.length" class="card coverage-card"><div class="section-heading"><div><h2>评价数据概览</h2><p>按当前周期的评分记录汇总；模拟预览以页面顶部标识为准。</p></div></div><div class="table-wrap"><table class="table"><thead><tr><th>部门</th><th>评分记录</th><th>已提交</th><th>平均得分</th></tr></thead><tbody><tr v-for="d in departmentSummary" :key="d.name"><td>{{ d.name }}</td><td>{{ d.total }}</td><td>{{ d.submitted }} / {{ d.total }}</td><td class="score">{{ d.average }}</td></tr></tbody></table></div></section>
      <section v-if="progressRows.length" class="card coverage-card"><div class="section-heading"><div><h2>{{ isOversight ? '校内五大部门提交情况' : '本部门成员提交情况' }}</h2><p>{{ isOversight ? '仅展示科技部、研发部、产品部、网监部、生态部，本周期填报进度。' : '仅展示本部门成员，本页面不跨部门读取数据。' }}</p></div><span class="chip chip-blue">实时数据</span></div><div class="table-wrap"><table class="table"><thead><tr><th>部门</th><th>成员数</th><th>自评完成</th><th>他评完成</th><th>提交进度</th></tr></thead><tbody><tr v-for="row in progressRows" :key="row.dept.id"><td><b>{{ row.dept.name }}</b></td><td>{{ memberCount(row.data) }}</td><td>{{ selfDone(row.data) }} / {{ memberCount(row.data) }}</td><td>{{ peerDone(row.data) }} / {{ peerExpected(row.data) }}</td><td>{{ progressLabel(row.data) }}</td></tr></tbody></table></div></section>
      <section v-if="showEdit" class="card edit-card"><div class="section-heading"><div><h2>修改环评周期</h2><p>只有尚未发起的草稿周期可以修改。</p></div></div><div class="form-grid"><div class="field"><label>评价月份</label><input type="month" v-model="form.month" /></div><div class="field"><label>周期名称</label><input v-model="form.title" /></div><div class="field"><label>开始时间</label><input v-model="form.openAt" type="datetime-local" /></div><div class="field"><label>评价截止</label><input v-model="form.closeAt" type="datetime-local" /></div><div class="field"><label>结果公布时间</label><input v-model="form.publishAt" type="datetime-local" /></div></div><div class="form-actions"><button class="btn" @click="showEdit = false">取消</button><button class="btn btn-primary" :disabled="busy || !scheduleValid()" @click="doEdit">保存修改</button></div></section>
      <section class="card progress-card">
        <div class="section-heading"><div><h2>月评流程</h2><p>按整期推进，发起后周期名单与规则应保持锁定。</p></div></div>
        <div class="stepper"><div v-for="(step, i) in ['月评准备', '评价进行中', '核验与发布', '已归档']" :key="step" class="step" :class="{ done: i < phaseIndex(detail.status), current: i === phaseIndex(detail.status) }"><span>{{ i < phaseIndex(detail.status) ? '✓' : `0${i + 1}` }}</span><b>{{ step }}</b><small>{{ i === 0 ? '时间、规则、名单' : i === 1 ? '月报、自评、他评' : i === 2 ? '异常核验、结果发布' : '历史只读' }}</small></div></div>
      </section>
      <div class="detail-grid">
        <section class="card"><div class="section-heading"><div><h2>周期安排</h2><p>此时间表来自后端周期记录。</p></div></div><div class="schedule-list"><div><span>评价开始</span><b>{{ dateText(detail.openAt) }}</b></div><div><span>评价截止</span><b>{{ dateText(detail.closeAt) }}</b></div><div><span>结果公布</span><b>{{ dateText(detail.publishAt) }}</b></div></div><div class="rule-note"><b>下一步</b><p>{{ detail.status === 'DRAFT' || detail.status === 'PENDING_OPEN' ? '先运行名单预检，确认分配可行后再发起整期月评。' : detail.status === 'REVIEWING' ? '跟进成员完成月报、自评与他评；截止后进入核验阶段。' : '核对异常核验与结果状态，再按授权推进发布。' }}</p></div></section>
        <section class="card"><div class="section-heading"><div><h2>参评名单快照</h2><p>名单由周期创建时的组织数据生成。</p></div><span class="chip chip-gray">{{ detail.participants?.length ?? 0 }} 人</span></div><div v-if="detail.participants?.length" class="participant-list"><span v-for="p in detail.participants" :key="p.userId">{{ userName(p.userId) }}</span></div><div v-else class="empty compact">周期详情暂未返回参评名单。</div></section>
      </div>
      <AssignmentPanel v-if="detail && auth.user?.capabilities.includes('assignment.manage')" :cycle-id="detail.id" :editable="['DRAFT','PENDING_OPEN'].includes(detail.status)" @changed="preview=null" />
      <section v-if="preview" class="card"><div class="section-heading"><div><h2>完整关系预览</h2><p>人工指定优先，算法补足。确认后正式生效；修改指定关系后必须重新预览。</p></div><span class="chip" :class="preview[0]?.feasible === false ? 'chip-red' : 'chip-blue'">{{ preview[0]?.feasible === false ? '存在阻断项' : '等待确认' }}</span></div><p>评价任务 {{ preview[0]?.count }} 条</p><p v-for="diagnostic in preview[0]?.diagnostics" :key="diagnostic" class="text-danger">{{ diagnostic }}</p><div class="table-wrap"><table class="table"><thead><tr><th>评价人</th><th>被评价人</th><th>来源</th></tr></thead><tbody><tr v-for="e in preview[0]?.edges" :key="e.reviewerId+e.targetId"><td>{{ e.reviewerName || e.reviewerId }}</td><td>{{ e.targetName || e.targetId }}</td><td>{{ e.sourceType==='MANUAL'?'人工指定':'算法分配' }}</td></tr></tbody></table></div><button class="btn btn-primary" :disabled="busy || !preview[0]?.feasible" @click="doOpen">确认完整关系并正式生效</button></section>
    </template>
    <section v-else-if="isDetail" class="card detail-state" aria-live="polite">
      <div v-if="loading" class="empty">正在加载环评详情…</div>
      <div v-else-if="error" class="detail-error"><h2>无法显示环评详情</h2><p>{{ error }}</p><div class="row"><button class="btn" @click="loadDetail(String(route.params.cycleId))">重试</button><button class="btn btn-primary" @click="router.push('/cycles')">返回环评列表</button></div></div>
      <div v-else class="empty">正在准备环评详情…</div>
    </section>
  </div>
</template>

<style scoped>
.eyebrow { margin:0 0 4px; color:var(--lark-primary); font:12px/18px 'Times New Roman',serif; letter-spacing:.12em; }
.page-head { align-items:center; margin-bottom:22px; }
.page-head .page-title { margin-bottom:5px; }
.metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-bottom:20px; }
.metric-card { min-height:118px; padding:17px 19px; display:flex; flex-direction:column; align-items:flex-start; gap:3px; border:1px solid var(--lark-border-light); border-radius:10px; background:#fff; box-shadow:var(--lark-shadow-card); }
.metric-card strong { font:700 29px/36px 'Times New Roman',serif; color:var(--lark-text-1); }
.metric-label { color:var(--lark-text-2); font-size:13px; }
.metric-card small { color:var(--lark-text-3); font-size:12px; }
.metric-blue strong { color:var(--lark-primary); }.metric-amber strong { color:#d25f00; }.metric-green strong { color:#2ea121; }
.card { padding:21px 22px; }
.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:18px; }
.section-heading h2 { margin:0 0 4px; font-size:17px; line-height:24px; }
.section-heading p { margin:0; color:var(--lark-text-3); font-size:13px; }
.form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px 18px; }
.field label { color:var(--lark-text-2); font-weight:600; }
.form-actions { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-top:16px; padding-top:16px; border-top:1px solid var(--lark-border-light); }
.empty-state { padding:50px 20px; text-align:center; border:1px dashed #cbd5e1; border-radius:10px; background:rgba(255,255,255,.7); }
.empty-icon { width:46px; height:46px; display:grid; place-items:center; margin:0 auto 13px; border-radius:12px; color:var(--lark-primary); background:var(--lark-primary-bg); font-size:20px; font-weight:600; }
.empty-state h2 { margin:0 0 6px; font-size:18px; }.empty-state p { max-width:480px; margin:0 auto 18px; color:var(--lark-text-2); }
.cycles-table td:first-child { min-width:210px; }.cycles-table small { display:block; margin-top:3px; color:var(--lark-text-3); font-size:12px; }
.click-row { cursor:pointer; }.row-arrow { color:var(--lark-primary); white-space:nowrap; }
.back-link { padding:0; margin:0 0 16px; border:0; background:none; color:var(--lark-text-2); font:inherit; cursor:pointer; }.back-link:hover { color:var(--lark-primary); }
.detail-head { align-items:flex-end; }.head-actions { display:flex; gap:8px; }
.stepper { display:grid; grid-template-columns:repeat(4,1fr); gap:0; }
.step { position:relative; display:grid; grid-template-columns:34px 1fr; grid-template-rows:auto auto; column-gap:10px; min-height:62px; color:var(--lark-text-3); }
.step:not(:last-child):after { content:''; position:absolute; left:35px; right:10px; top:15px; height:1px; background:var(--lark-border); transform:translateX(10px); }
.step span { z-index:1; grid-row:1 / 3; width:30px; height:30px; display:grid; place-items:center; border:1px solid var(--lark-border); border-radius:50%; background:#fff; font:13px 'Times New Roman',serif; }
.step b { font-size:14px; color:var(--lark-text-2); }.step small { font-size:12px; color:var(--lark-text-3); }
.step.current span { border-color:var(--lark-primary); color:#fff; background:var(--lark-primary); }.step.current b,.step.done b { color:var(--lark-text-1); }.step.done span { border-color:#bfe9b7; color:#2ea121; background:#e4f9e0; }
.detail-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.schedule-list { display:grid; gap:0; }.schedule-list div { display:flex; justify-content:space-between; gap:12px; padding:11px 0; border-bottom:1px solid var(--lark-border-light); }.schedule-list span { color:var(--lark-text-2); }.schedule-list b { font-weight:600; text-align:right; }
.rule-note { margin-top:17px; padding:13px 15px; border-radius:8px; background:#f0f4ff; color:#354b72; }.rule-note p { margin:4px 0 0; color:var(--lark-text-2); }
.participant-list { display:flex; flex-wrap:wrap; gap:8px; max-height:215px; overflow:auto; }.participant-list span { padding:5px 9px; border:1px solid var(--lark-border-light); border-radius:6px; background:#f8f9fb; }
.empty.compact { padding:24px 8px; }.preview-json { overflow:auto; padding:12px; border-radius:8px; background:#f7f8fa; color:var(--lark-text-2); font-size:12px; }
.detail-state { min-height:220px; display:grid; place-items:center; }.detail-error { max-width:520px; padding:24px; text-align:center; }.detail-error h2 { margin:0 0 8px; font-size:18px; }.detail-error p { margin:0 0 18px; color:var(--lark-text-2); }.detail-error .row { justify-content:center; }
@media(max-width:900px){.metric-grid{grid-template-columns:repeat(2,1fr)}.detail-grid{grid-template-columns:1fr}.stepper{grid-template-columns:repeat(2,1fr);gap:18px}.step:after{display:none}}
@media(max-width:560px){.metric-grid,.form-grid{grid-template-columns:1fr}.form-actions{align-items:stretch;flex-direction:column}.detail-head{align-items:flex-start}.cycles-table{min-width:760px}}
</style>
