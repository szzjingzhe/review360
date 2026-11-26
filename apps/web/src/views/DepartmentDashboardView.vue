<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mockApi, userName } from '../api';
import { useAuth } from '../stores/auth';
import type { DepartmentProgress } from '../mock/data';
import AssignmentPanel from '../components/AssignmentPanel.vue';
import {managementRequest} from '../api/management';

/**
 * 部门管理与监督端：部门工作台 / 材料与评价进度 / 成员成长。
 * 三个子路由共用本组件，用 route.path 决定聚焦的分区。
 * 数据来自后端部门进度聚合接口（progress.read + 部门范围两层校验）；
 * 边界：不得查看成员原始单份评分、评价者身份与排名，只能看授权范围内的进度与匿名成长结果。
 */
const route = useRoute();
const router = useRouter();
const auth = useAuth();
const cycles = ref<any[]>([]);
const selectedCycleId = ref('');
const deptOptions = ref<Array<{id:string;name:string}>>([]);
const progress = ref<DepartmentProgress | null>(null);
const builds = ref<any[]>([]);
const loading = ref(false);
const progressErr = ref('');
const growthError = ref('');
const publishedBuilds = computed(() => builds.value.filter(b => b.status === 'PUBLISHED'));
const localGrowthPreview = computed<Array<{id:string;name:string;strength:string;suggestion:string;dimensions:Array<{label:string;score:number}>}>>(()=>[]);
const memberProgress = (id: string) => members.value.find(m => m.userId === id);
const statIcons = {scope:'M4 21V5h10v16M14 10h6v11M7 8h4M7 12h4M7 16h4M17 13h1m-1 4h1',members:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m17 0v-2a4 4 0 0 0-3-4M12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4-3a4 4 0 0 1 0 8',report:'M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8m-8 4h6',self:'m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15v5Z',peer:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m17 0v-2a4 4 0 0 0-3-4M12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',missing:'m12 3 10 18H2L12 3Zm0 6v5m0 3v.01'};
const dashboardStats = computed(() => [
 {key:'scope',label:'当前管理范围',value:scopeName.value,note:'正式部门'},
 {key:'members',label:'部门成员人数',value:progress.value?.memberCount??'—',note:'不含监管与外部条线'},
 {key:'report',label:'月报提交数',value:progress.value?.materialsAvailable?progress.value.materialsSubmitted:'—',note:'有效月报提交人数（按本期参评成员统计）'},
 {key:'self',label:'自评完成数',value:progress.value?`${progress.value.selfDone} / ${progress.value.memberCount}`:'—',percent:pct(progress.value?.selfDone??0,progress.value?.memberCount??0)},
 {key:'peer',label:'他评完成数',value:progress.value?`${progress.value.peerReceived} / ${progress.value.peerExpected}`:'—',percent:pct(progress.value?.peerReceived??0,progress.value?.peerExpected??0)},
 {key:'missing',label:'缺交成员',value:missing.value.length,note:'自评未提交'},
]);

const tab = computed<'overview' | 'progress' | 'growth' | 'assignments'>(() => {
  if (route.path.endsWith('/assignments')) return 'assignments';
  if (route.path.endsWith('/progress')) return 'progress';
  if (route.path.endsWith('/growth')) return 'growth';
  return 'overview';
});

const deptId = computed(() => typeof route.query.departmentId==='string'?route.query.departmentId:auth.user?.deptId ?? '');
const scopeName = computed(() => progress.value?.departmentName ?? auth.user?.deptName ?? '—');
const members = computed(() => [...(progress.value?.members ?? [])].sort((a,b)=>Number(b.roleSnapshot==='HEAD')-Number(a.roleSnapshot==='HEAD')));
const missing = computed(() => [...(progress.value?.missingSelf ?? [])].sort((a,b)=>Number(members.value.find(m=>m.userId===b.userId)?.roleSnapshot==='HEAD')-Number(members.value.find(m=>m.userId===a.userId)?.roleSnapshot==='HEAD')));

watch([selectedCycleId, deptId, tab], () => {
  void load();
});

/** 被授权人（非部长）可能没有归属部门，或需要查看其它部门：提供部门切换。 */
function switchDepartment(value: string) {
  const query = { ...route.query, departmentId: value };
  void router.replace({ path: route.path, query });
}
function onDeptChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value && value !== deptId.value) switchDepartment(value);
}

onMounted(async () => {
  if (route.path === '/department/assignments' && auth.hasCapability('management.access')) {
    await router.replace({path:'/management/monthly/relations',query:route.query});
    return;
  }
  try {
    const org = await mockApi.getOrganization();
    deptOptions.value = (org?.departments ?? []).map((d:any) => ({ id: d.id, name: d.name }));
  } catch { deptOptions.value = []; }
  cycles.value = await mockApi.listCycles();
  selectedCycleId.value = cycles.value.find(c=>c.id===route.query.cycleId)?.id ?? cycles.value.find((c) => c.status === 'REVIEWING')?.id ?? cycles.value[0]?.id ?? '';
  await load();
});

async function load() {
  progress.value = null;
  builds.value = [];
  progressErr.value = '';
  growthError.value = '';
  if (!selectedCycleId.value || !deptId.value || tab.value==='assignments') return;
  loading.value = true;
  try {
    progress.value = await mockApi.getDepartmentProgress(selectedCycleId.value, deptId.value);
    if (auth.user?.capabilities.includes('result.read_published')) {
      try { builds.value = (await managementRequest<any[]>(`departments/${deptId.value}/cycles/${selectedCycleId.value}/growth-analyses`)).map(r=>({...r,targetId:r.target_id,status:'PUBLISHED'})); }
      catch { growthError.value = '已发布结果暂时无法读取，请稍后重试。'; }
    } else { growthError.value = '当前身份尚未获得已发布结果查看权限。'; }
  } catch (e: any) {
    // 常见：该身份无 progress.read（如仅有 HEAD 角色）→ 后端 403
    progressErr.value = String(e?.message ?? e);
  } finally {
    loading.value = false;
  }
}

function pct(done: number, total: number) {
  return total ? Math.round((done / total) * 100) : 0;
}

// ---------------- 成员材料大卡片（预览 / 下载） ----------------
const materialDialog = ref<{ userId: string; displayName: string } | null>(null);
const materialList = ref<any[]>([]);
const materialLoading = ref(false);
const materialError = ref('');
const selectedFile = ref<any>(null);
const previewUrl = ref('');
const previewMime = ref('');
const previewLink = ref('');
const previewLoading = ref(false);
const previewError = ref('');
let previewBlob = '';
const materialCycleLabel = computed(() => cycles.value.find(c => c.id === selectedCycleId.value)?.month ?? '');

const materialFiles = computed(() => (materialList.value ?? []).flatMap((m: any) => (m.versions ?? []).map((v: any) => ({
  ...v, materialType: m.type, typeLabel: m.type === 'MONTHLY_REPORT' ? '主月报' : '补充材料',
}))));

function matStatus(m: any) {
  return m?.materialStatus ?? 'MISSING';
}
function matText(m: any) {
  const s = matStatus(m);
  if (s === 'READY') return `已上传 ${m?.materialCount ?? 1} 份`;
  if (s === 'PROCESSING') return '校验中';
  return '未提供';
}
function fileSize(bytes: number) {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function fileExt(name: string) {
  return (name.split('.').pop() ?? '').toUpperCase().slice(0, 4);
}
function fileTime(value: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}
function materialEndpoint(file: any, download = false) {
  const base = `/api/v1/cycles/${selectedCycleId.value}/participants/${materialDialog.value?.userId}/materials/${file.id}/file`;
  return download ? base + '?download=1' : base;
}
function revokePreview() {
  if (previewBlob) { URL.revokeObjectURL(previewBlob); previewBlob = ''; }
  previewUrl.value = '';
}

async function openMaterials(member: { userId: string; displayName: string }) {
  materialDialog.value = { userId: member.userId, displayName: member.displayName };
  materialList.value = [];
  materialError.value = '';
  selectedFile.value = null;
  previewError.value = '';
  previewMime.value = '';
  revokePreview();
  materialLoading.value = true;
  try {
    const data = await mockApi.listMemberMaterials(selectedCycleId.value, member.userId);
    materialList.value = data ?? [];
    const first = materialFiles.value[0];
    if (first) void selectFile(first);
  } catch (e: any) {
    materialError.value = e?.status === 403
      ? '当前账号无权查看该成员材料（需「部长工作台」授权或对应部门范围）。'
      : String(e?.message ?? e);
  } finally {
    materialLoading.value = false;
  }
}

async function selectFile(file: any) {
  selectedFile.value = file;
  previewError.value = '';
  previewMime.value = '';
  previewLink.value = '';
  revokePreview();
  if (file?.externalUrl) { previewLink.value = file.externalUrl; previewLoading.value = false; return; }
  previewLoading.value = true;
  try {
    const res = await fetch(materialEndpoint(file), { credentials: 'include' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({} as any));
      throw new Error(res.status === 403 ? '无权查看该材料。' : res.status === 404 ? '文件不存在或已不可用。' : (data.code === 'PREVIEW_BUSY' ? '预览服务忙，请稍后重试。' : '材料暂时无法加载。'));
    }
    const blob = await res.blob();
    previewMime.value = blob.type || 'application/pdf';
    previewBlob = URL.createObjectURL(blob);
    previewUrl.value = previewBlob;
  } catch (e: any) {
    previewError.value = e?.message ?? '网络异常，材料加载失败。';
  } finally {
    previewLoading.value = false;
  }
}

function closeMaterials() {
  materialDialog.value = null;
  materialList.value = [];
  selectedFile.value = null;
  materialError.value = '';
  previewError.value = '';
  previewLink.value = '';
  revokePreview();
}
function onEsc(event: KeyboardEvent) {
  if (event.key === 'Escape' && materialDialog.value) closeMaterials();
}
onMounted(() => window.addEventListener('keydown', onEsc));
onBeforeUnmount(() => { window.removeEventListener('keydown', onEsc); revokePreview(); });

</script>

<template>
  <div :class="{ 'department-overview': tab === 'overview' }">
    <div class="page-head">
      <div>
        <h1 class="page-title">部门管理与监督端</h1>
        <p class="page-sub">面向部门负责人及被授权人员：材料与评价进度、成员成长入口。不暴露原始单份评分、评价者身份与排名。</p>
      </div>
      <div class="page-head-actions">
        <select v-if="deptOptions.length>1" :value="deptId" aria-label="选择部门" @change="onDeptChange">
          <option v-for="item in deptOptions" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
        <select v-model="selectedCycleId">
          <option v-for="item in cycles" :key="item.id" :value="item.id">{{ item.title }}（{{ item.month }}）</option>
        </select>
      </div>
    </div>

    <div class="tabs">
      <RouterLink to="/department" class="tab" :class="{ 'tab-active': tab === 'overview' }">部门工作台</RouterLink>
      <RouterLink to="/department/progress" class="tab" :class="{ 'tab-active': tab === 'progress' }">材料与评价进度</RouterLink>
      <RouterLink v-if="auth.user?.capabilities.includes('assignment.manage')" :to="auth.hasCapability('management.access') ? {path:'/management/monthly/relations',query:{cycleId:selectedCycleId}} : '/department/assignments'" class="tab" :class="{'tab-active':tab==='assignments'}">评价关系</RouterLink>
      <RouterLink to="/department/growth" class="tab" :class="{ 'tab-active': tab === 'growth' }">成员成长</RouterLink>
    </div>

    <AssignmentPanel v-if="tab==='assignments' && selectedCycleId && auth.user?.capabilities.includes('assignment.manage')" :cycle-id="selectedCycleId" :editable="['DRAFT','PENDING_OPEN'].includes(cycles.find(c=>c.id===selectedCycleId)?.status)" />
    <p v-if="loading && tab!=='assignments'" class="hint">正在加载部门进度…</p>
    <div v-else-if="progressErr" class="notice notice-warning" style="margin-bottom:16px">
      无法读取该部门进度：{{ progressErr }}。请确认当前账号已获「部长工作台」授权（系统设置 → 角色权限），且所选部门在授权范围内。
    </div>

    <!-- 总览 -->
    <template v-if="tab === 'overview'">
      <div class="department-stats">
       <article v-for="stat in dashboardStats" :key="stat.key" class="department-stat" :data-stat="stat.key">
        <span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="statIcons[stat.key as keyof typeof statIcons]"/></svg></span>
        <div class="stat-copy"><h2>{{stat.label}}</h2><strong>{{stat.value}}</strong><p v-if="stat.note">{{stat.note}}</p>
         <div v-if="stat.percent!==undefined" class="stat-progress"><div class="bar-track" role="progressbar" :aria-label="stat.label" :aria-valuenow="stat.percent" aria-valuemin="0" aria-valuemax="100"><div class="bar-fill" :style="{width:stat.percent+'%'}"></div></div><span>{{stat.percent}}%</span></div>
        </div>
       </article>
      </div>
      <div class="department-panels">
       <section class="card missing-panel"><header class="dashboard-panel-heading"><div class="panel-heading-copy"><span class="panel-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="statIcons.report"/></svg></span><div><h3>缺交成员（{{missing.length}}）</h3><p>查看未完成的自评与已收到他评进度。</p></div></div><RouterLink class="btn btn-sm" to="/department/progress">查看进度明细</RouterLink></header>
        <div class="missing-table-wrap"><table class="missing-table"><thead><tr><th>姓名</th><th>材料状态</th><th>自评提交</th><th>他评状态</th><th>操作</th></tr></thead><tbody><tr v-for="u in missing" :key="u.userId"><td><button class="member-link" @click="openMaterials(u)">{{u.displayName}}</button></td><td><button class="material-link" :class="matStatus(memberProgress(u.userId))" :disabled="matStatus(memberProgress(u.userId))==='MISSING'" @click="openMaterials(u)">{{ matText(memberProgress(u.userId)) }}</button></td><td><span class="dashboard-status incomplete">{{memberProgress(u.userId)?.selfStatus==='DRAFT'?'草稿未提交':'未提交'}}</span></td><td><span class="dashboard-status" :class="!memberProgress(u.userId)?'neutral':memberProgress(u.userId)!.peerReceived>=memberProgress(u.userId)!.peerExpected?'complete':'pending'">{{!memberProgress(u.userId)?'未提供':memberProgress(u.userId)!.peerReceived>=memberProgress(u.userId)!.peerExpected?'已收齐':'待收齐'}}</span><small v-if="memberProgress(u.userId)">{{memberProgress(u.userId)!.peerReceived}} / {{memberProgress(u.userId)!.peerExpected}} 已收到</small></td><td><button class="btn btn-sm reminder" disabled title="当前系统尚未接入提醒发送接口">发送提醒</button></td></tr><tr v-if="!missing.length"><td colspan="5" class="empty">{{loading?'正在加载…':'暂无自评缺交成员'}}</td></tr></tbody></table></div>
        <p class="dashboard-data-note">点击成员姓名或材料状态可查看本期材料（支持预览与下载）；他评按已收到数量展示。</p>
       </section>
       <section class="card growth-panel"><header class="dashboard-panel-heading"><div class="panel-heading-copy"><span class="panel-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="statIcons.report"/></svg></span><div><h3>成员成长</h3><p>仅授权范围内的匿名成长汇总；不含评价者姓名、单份评分与排名。</p></div></div><RouterLink class="btn btn-sm" to="/department/growth">进入成长结果</RouterLink></header>
        <div v-if="loading" class="growth-empty"><p>正在读取成长结果…</p></div>
        <div v-else-if="growthError" class="growth-empty"><img src="../assets/department-dashboard/growth-analysis.png" alt=""/><strong>成长结果暂不可用</strong><p>{{growthError}}</p></div>
        <div v-else-if="!publishedBuilds.length" class="growth-empty"><img src="../assets/department-dashboard/growth-analysis.png" alt=""/><strong>{{builds.length||cycles.find(c=>c.id===selectedCycleId)?.status!=='PUBLISHED'?'本期评价数据尚未发布':'本期暂无可展示的成长结果'}}</strong><p>数据发布后，可查看授权范围内的匿名成长汇总。</p></div>
        <div v-else class="published-growth"><div v-for="item in publishedBuilds" :key="item.id" class="remind-row"><span>{{userName(item.targetId)}}</span><span class="dashboard-status complete">已发布</span></div></div>
       </section>
      </div>
    </template>

    <!-- 材料与评价进度 -->
    <template v-else-if="tab === 'progress'">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">材料与评价进度</h3>
          <button class="btn btn-sm" @click="router.push('/tasks')">处理我的评价任务</button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>成员</th><th>月报</th><th>自评</th><th>收到他评</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="m in members" :key="m.userId">
                <td><button class="member-link" @click="openMaterials(m)">{{ m.displayName }}</button><div class="tag">{{ m.roleSnapshot ?? '—' }}</div></td>
                <td><button class="material-link" :class="matStatus(m)" :disabled="matStatus(m)==='MISSING'" @click="openMaterials(m)">{{ matText(m) }}</button></td>
                <td><span class="chip" :class="m.selfStatus === 'SUBMITTED' ? 'chip-green' : 'chip-amber'">{{ m.selfStatus === 'SUBMITTED' ? '已提交' : m.selfStatus === 'DRAFT' ? '草稿' : '未开始' }}</span></td>
                <td>{{ m.peerReceived }} / {{ m.peerExpected }}</td>
                <td><span class="chip" :class="m.peerReceived >= m.peerExpected && m.selfStatus === 'SUBMITTED' ? 'chip-green' : 'chip-amber'">{{ m.peerReceived >= m.peerExpected && m.selfStatus === 'SUBMITTED' ? '可进入核验' : '材料或评价待齐' }}</span></td>
              </tr>
              <tr v-if="members.length === 0"><td colspan="5" class="empty">无成员进度数据</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 成员成长 -->
    <template v-else>
      <div class="card">
        <h3>成员成长（匿名汇总）</h3>
        <p class="page-sub">只呈现授权范围内的匿名成长结果；不展示评价者姓名、单份他评分、原始评论顺序或排名。</p>
        <template v-if="localGrowthPreview.length">
          <p class="notice notice-info">本地模拟预览 · 仅示例成员18账号可见 · 2026-10。以下成员、得分和建议均为演示内容，不代表真实评价，不写入正式结果。</p>
          <div class="growth-preview-grid">
            <article v-for="member in localGrowthPreview" :key="member.id" class="growth-preview-card">
              <header><strong>{{ member.name }}</strong><span class="chip chip-blue">模拟成长汇总</span></header>
              <div v-for="dimension in member.dimensions" :key="dimension.label" class="growth-preview-dimension">
                <span>{{ dimension.label }}</span><div class="bar-track"><div class="bar-fill" :style="{ width: dimension.score + '%' }"></div></div><b>{{ dimension.score }}</b>
              </div>
              <p><b>优势表现：</b>{{ member.strength }}</p>
              <p><b>改进建议：</b>{{ member.suggestion }}</p>
            </article>
          </div>
        </template>
        <div v-else-if="builds.length === 0" class="empty">本周期暂无可展示的成长结果</div>
        <div v-for="item in builds" :key="item.id" class="remind-row">
          <span>{{ userName(item.targetId) }}</span>
          <span>{{item.content?item.content.strengths:'成长分析待确认'}}</span>
          <span class="chip" :class="item.status === 'PUBLISHED' ? 'chip-green' : 'chip-gray'">{{ item.status }}</span>
        </div>
      </div>
      <div class="notice notice-info">
        边界说明：部门端只能查看进度与匿名成长结果。查看他人原始评分需要 <code>calibration.read_raw</code> 且排除本人结果，属于监管端职责。
      </div>
    </template>

    <!-- 成员材料大卡片 -->
    <Teleport to="body">
      <div v-if="materialDialog" class="mm-backdrop" @click.self="closeMaterials">
        <section class="mm-card" role="dialog" aria-modal="true" aria-labelledby="mm-title">
          <header class="mm-head">
            <div>
              <h2 id="mm-title">{{ materialDialog.displayName }} · 本期材料</h2>
              <p>{{ materialCycleLabel }} 环评 · 仅展示当前可用版本，共 {{ materialFiles.length }} 个文件</p>
            </div>
            <button class="btn" aria-label="关闭材料卡片" @click="closeMaterials">关闭 ✕</button>
          </header>
          <div v-if="materialLoading" class="mm-empty">正在读取材料…</div>
          <div v-else-if="materialError" class="mm-empty mm-error" role="alert">{{ materialError }}</div>
          <div v-else-if="!materialFiles.length" class="mm-empty">该成员本期尚未上传可查看的材料。</div>
          <div v-else class="mm-body">
            <ul class="mm-list">
              <li v-for="file in materialFiles" :key="file.id">
                <button :class="{ active: selectedFile?.id === file.id }" @click="selectFile(file)">
                  <span class="mm-ext">{{ file.externalUrl ? 'LINK' : fileExt(file.fileName) }}</span>
                  <span class="mm-meta"><b>{{ file.fileName }}</b><small>{{ file.typeLabel }} · V{{ file.version }} · {{ file.externalUrl ? '飞书云文档' : fileSize(file.sizeBytes) }}</small><small>{{ fileTime(file.createdAt) }}<template v-if="file.uploadedBy"> · {{ file.uploadedBy }}</template></small></span>
                </button>
              </li>
            </ul>
            <div class="mm-view">
              <p v-if="previewLoading" class="mm-hint" role="status">正在生成预览…</p>
              <p v-else-if="previewError" class="mm-hint mm-error" role="alert">{{ previewError }}</p>
              <div v-else-if="previewLink" class="mm-link"><p>这是一份飞书云文档链接，不在本系统内存放文件。</p><a class="btn btn-primary" :href="previewLink" target="_blank" rel="noopener noreferrer">打开飞书云文档 ↗</a></div>
              <iframe v-else-if="previewUrl && previewMime === 'application/pdf'" :src="previewUrl" :title="selectedFile?.fileName" />
              <img v-else-if="previewUrl && previewMime.startsWith('image/')" :src="previewUrl" :alt="selectedFile?.fileName" />
              <div v-else-if="previewUrl" class="mm-hint">该格式暂不支持在线预览，请下载原文件查看。</div>
            </div>
          </div>
          <footer class="mm-foot">
            <span v-if="selectedFile">{{ selectedFile.fileName }} · {{ selectedFile.externalUrl ? '飞书云文档' : fileSize(selectedFile.sizeBytes) }}</span>
            <span v-else></span>
            <div class="mm-actions">
              <a v-if="selectedFile && selectedFile.externalUrl" class="btn btn-primary" :href="selectedFile.externalUrl" target="_blank" rel="noopener noreferrer">打开云文档 ↗</a>
              <a v-else-if="selectedFile" class="btn btn-primary" :href="materialEndpoint(selectedFile, true)" :download="selectedFile.fileName">下载原文件</a>
              <button class="btn" @click="closeMaterials">关闭</button>
            </div>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.growth-preview-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-top:16px; }
.growth-preview-card { min-width:0; padding:20px; border:1px solid var(--lark-border-light); border-radius:10px; }
.growth-preview-card header { display:flex; justify-content:space-between; gap:12px; margin-bottom:20px; }
.growth-preview-dimension { display:grid; grid-template-columns:72px minmax(0,1fr) 32px; align-items:center; gap:12px; margin:14px 0; font-size:13px; }
.growth-preview-dimension b { text-align:right; color:var(--lark-primary); }
.growth-preview-card p { margin:12px 0 0; font-size:13px; line-height:1.8; color:var(--lark-text-2); overflow-wrap:anywhere; }
@media(max-width:1100px) { .growth-preview-grid { grid-template-columns:1fr; } }
.page-head-actions select { min-width: 260px; }
/* 页签：飞书用底部 2px 主色指示条，未选中为次级文字色 */
.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--lark-border-light); }
.tab { padding: 8px 12px; font-size: 14px; color: var(--lark-text-2); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .1s ease; }
.tab:hover { color: var(--lark-text-1); }
.tab-active { color: var(--lark-primary); border-bottom-color: var(--lark-primary); font-weight: 500; }
.remind-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--lark-border-light); }
.remind-row:last-child { border-bottom: 0; }
.hint { color: var(--lark-text-2); font-size: 13px; }

/* Overview-only visual rules; progress and growth subpages keep their styles. */
.department-overview .page-head{align-items:center;margin-bottom:20px;gap:20px}.department-overview .page-title{font-size:28px;line-height:40px;font-weight:700;margin-bottom:8px;color:#172b4d}.department-overview .page-sub{font-size:14px;line-height:24px;color:#667085}.department-overview .page-head-actions{max-width:100%}.department-overview .page-head-actions select{max-width:100%;min-width:0;width:280px;height:40px;padding:8px 12px;border:1px solid #dce5f2;border-radius:8px;background:#fff;font:inherit}.department-overview .tabs{margin-bottom:18px}.department-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:18px}.department-stat{position:relative;display:flex;gap:10px;min-width:0;min-height:146px;padding:18px 14px;border:1px solid #e5eaf2;border-radius:11px;background:#fff;box-shadow:0 3px 10px #172b4d05}.stat-icon,.panel-icon{display:grid;place-items:center;flex:0 0 36px;width:36px;height:36px;border-radius:10px;color:#246bfd;background:#edf4ff}.stat-icon svg,.panel-icon svg{width:22px;height:22px;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.department-stat[data-stat=report] .stat-icon{color:#8057d6;background:#f1ecff}.department-stat[data-stat=self] .stat-icon{color:#26ab9d;background:#e6f8f3}.department-stat[data-stat=peer] .stat-icon{color:#d89428;background:#fff6e6}.department-stat[data-stat=missing] .stat-icon{color:#e06674;background:#fff0f2}.stat-copy{flex:1;min-width:0;position:relative}.stat-copy h2{margin:0 0 8px;font-size:12px;line-height:20px;font-weight:500;color:#667085}.stat-copy strong{display:block;font-family:inherit;font-size:24px;line-height:32px;font-weight:700;color:#172b4d;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.stat-copy p{margin:7px 0 0;font-size:11px;line-height:18px;color:#667085;max-width:140px}.stat-progress{display:flex;align-items:center;gap:5px;margin-top:14px}.stat-progress .bar-track{flex:1;min-width:0;height:5px}.stat-progress span{font-size:10px;color:#748198}.department-panels{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:18px;align-items:stretch}.department-overview .department-panels>.card{min-width:0;margin:0;padding:20px;border:1px solid #e5eaf2;border-radius:12px;box-shadow:0 3px 12px #172b4d05}.dashboard-panel-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px}.panel-heading-copy{display:flex;align-items:flex-start;gap:12px;min-width:0}.department-overview .dashboard-panel-heading h3{margin:0;font-size:18px;line-height:26px;font-weight:600;font-family:inherit;color:#172b4d}.dashboard-panel-heading p{margin:4px 0 0;font-size:12px;line-height:20px;color:#667085}.dashboard-panel-heading .btn{flex:none;white-space:nowrap;text-decoration:none}.missing-table-wrap{overflow-x:auto}.missing-table{width:100%;border-collapse:collapse;font-size:13px;color:#344054}.missing-table th{text-align:left;padding:10px 8px;background:#f5f8fc;color:#667085;font-weight:500;white-space:nowrap}.missing-table td{padding:12px 8px;border-bottom:1px solid #edf0f5}.missing-table small{display:block;margin-top:3px;font-size:10px;color:#8492a8}.dashboard-status{display:inline-block;padding:2px 7px;border-radius:4px;font-size:12px;line-height:19px;white-space:nowrap}.incomplete{background:#fff0f1;color:#cc626f}.pending{background:#fff5e8;color:#bf862c}.complete{background:#eaf8f1;color:#28856c}.neutral{background:#f2f4f7;color:#8492a8}.department-overview .reminder{color:#8097b9;border-color:#dce6f5;background:#f5f8fd;white-space:nowrap}.dashboard-data-note{font-size:11px;line-height:19px;color:#8492a8;margin:12px 0 0}.growth-panel{display:flex;flex-direction:column;align-self:stretch}.growth-empty{display:flex;flex:1;min-height:380px;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:28px 20px;color:#667085;background:#f8faff;border-radius:8px}.growth-empty img{display:block;width:300px;max-width:100%;height:210px;object-fit:cover;object-position:right center;margin:0 0 10px;-webkit-mask-image:radial-gradient(ellipse at center,#000 35%,transparent 73%);mask-image:radial-gradient(ellipse at center,#000 35%,transparent 73%)}.growth-empty strong{font-size:17px;line-height:26px;color:#172b4d}.growth-empty p{max-width:360px;font-size:13px;line-height:23px;margin:10px 0}.published-growth{padding:6px 0}.department-overview .btn:focus-visible{outline:3px solid #b7d0ff;outline-offset:2px}@media(max-width:1550px){.department-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.department-stat{min-height:136px}.stat-copy p{max-width:180px}.dashboard-panel-heading{flex-wrap:wrap}.department-overview .department-panels>.card{padding:18px}}@media(max-width:1100px){.department-panels{grid-template-columns:1fr}.growth-empty{min-height:260px}.department-stats{gap:12px}}@media(max-width:680px){.department-overview .page-head{align-items:flex-start}.department-overview .page-title{font-size:25px}.department-overview .page-head-actions,.department-overview .page-head-actions select{width:100%}.department-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.department-stat{padding:14px 12px;gap:8px;min-height:142px}.stat-icon{flex-basis:28px;width:28px;height:28px}.stat-icon svg{width:19px;height:19px}.stat-copy strong{font-size:21px}.stat-copy p{font-size:11px}.department-overview .tabs{overflow-x:auto;white-space:nowrap}.missing-table{min-width:540px}.growth-empty img{max-width:100%}}
</style>

<style scoped>
.member-link{background:none;border:0;padding:0;font:inherit;font-weight:600;color:#172b4d;cursor:pointer;text-align:left}
.member-link:hover{color:#246bfd;text-decoration:underline}
.material-link{border:0;border-radius:12px;padding:3px 9px;font:inherit;font-size:12px;cursor:pointer;background:#f2f3f5;color:#5f6b7a}
.material-link.READY{background:#e8f7ee;color:#1f7a45}
.material-link.PROCESSING{background:#fff6e6;color:#a3610a}
.material-link.MISSING{background:#f2f3f5;color:#98a2b3;cursor:default}
.material-link:not(:disabled):hover{text-decoration:underline}
.mm-backdrop{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:#172b4d59}
.mm-card{display:flex;flex-direction:column;width:min(1080px,96vw);max-height:90vh;background:#fff;border-radius:14px;box-shadow:0 24px 60px #172b4d33;overflow:hidden;color:#172b4d}
.mm-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 24px;border-bottom:1px solid #e5eaf2}
.mm-head h2{margin:0;font-size:19px}
.mm-head p{margin:6px 0 0;color:#667085;font-size:13px}
.mm-body{display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:0;flex:1;min-height:0}
.mm-list{list-style:none;margin:0;padding:12px;border-right:1px solid #e5eaf2;overflow:auto;background:#fafbfd}
.mm-list button{display:flex;gap:10px;width:100%;padding:10px;border:1px solid transparent;border-radius:9px;background:#fff;text-align:left;cursor:pointer;font:inherit}
.mm-list button.active{border-color:#246bfd;box-shadow:0 0 0 2px #246bfd22}
.mm-ext{flex:0 0 38px;height:38px;display:grid;place-items:center;border-radius:8px;background:#eef4ff;color:#246bfd;font-size:11px;font-weight:600}
.mm-meta{min-width:0}
.mm-meta b,.mm-meta small{display:block;overflow-wrap:anywhere}
.mm-meta b{font-size:13px}
.mm-meta small{color:#667085;font-size:11px;margin-top:3px}
.mm-view{position:relative;min-height:320px;display:flex;align-items:stretch;justify-content:center;padding:14px;overflow:auto;background:#fff}
.mm-view iframe{flex:1;width:100%;min-height:480px;border:1px solid #e5eaf2;border-radius:8px}
.mm-view img{max-width:100%;height:auto;align-self:center;border-radius:8px}
.mm-hint{margin:auto;color:#667085;font-size:13px}
.mm-link{margin:auto;display:grid;justify-items:center;gap:14px;text-align:center;color:#667085;font-size:13px}
.mm-link p{margin:0}
.mm-empty{padding:60px 24px;text-align:center;color:#667085;font-size:14px}
.mm-error{color:#c2413b}
.mm-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;border-top:1px solid #e5eaf2;background:#fafbfd;font-size:12px;color:#667085}
.mm-actions{display:flex;gap:10px}
@media(max-width:820px){.mm-body{grid-template-columns:1fr}.mm-list{max-height:200px;border-right:0;border-bottom:1px solid #e5eaf2}.mm-card{max-height:94vh}}
</style>
