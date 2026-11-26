<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { mockApi, userName } from '../api';
import { useAuth } from '../stores/auth';
const auth=useAuth();
const allowed=(cap:string)=>auth.user?.capabilities.includes(cap)??false;

/**
 * 监管工作台（组织监管端首页）。
 * 只放监管视角的信息：周期状态、核验/确认/发布待办数量、配置与规则入口。
 * 注意：这里不再混入「个人待评价任务」——那属于个人端工作台。
 */
const router = useRouter();
const cycles = ref<any[]>([]);
const calCases = ref<any[]>([]);
const builds = ref<any[]>([]);
const loading = ref(true);
const failed = ref('');

onMounted(async () => {
  try {
    cycles.value = await mockApi.listCycles();
    for (const c of cycles.value) {
      if (allowed('calibration.read_raw') && (c.status === 'REVIEWING' || c.status === 'CALIBRATING')) {
        calCases.value.push(...(await mockApi.listCalibrationCases(c.id)));
      }
      if(allowed('calibration.read_raw'))builds.value.push(...(await mockApi.listResultBuilds(c.id)));
    }
  } catch (e: any) {
    failed.value = String(e?.message ?? e);
  } finally {
    loading.value = false;
  }
});

const currentCycle = computed(
  () => cycles.value.find((c) => c.status === 'REVIEWING' || c.status === 'CALIBRATING') ?? cycles.value[0],
);
const pendingCalibration = computed(() => calCases.value.filter((c) => c.status === 'OPEN').length);
const pendingConfirm = computed(() => builds.value.filter((b) => b.status === 'BUILT').length);
const pendingPublish = computed(() => builds.value.filter((b) => b.status === 'APPROVED').length);
const staleBuilds = computed(() => builds.value.filter((b) => b.status === 'STALE').length);

const statusText: Record<string, string> = {
  DRAFT: '草稿', PENDING_OPEN: '待开期', REVIEWING: '评价中', CALIBRATING: '核验中',
  PUBLISHED: '已发布', CANCELLED: '已取消',
};
function chip(s: string) {
  if (s === 'REVIEWING') return 'chip-blue';
  if (s === 'CALIBRATING') return 'chip-amber';
  if (s === 'PUBLISHED') return 'chip-green';
  return 'chip-gray';
}
const icons={calendar:'M8 3v4m8-4v4M4 10h16M5 5h14v16H4V5Zm3 9h2m4 0h2',check:'M8 4h8v3H8V4Zm-2 2H4v15h16V6h-2M8 12l2 2 5-5m-7 8h8',file:'M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8m-8 4h6',send:'m3 11 18-8-8 18-2-8-8-2Zm8 2L21 3',warning:'m12 3 10 18H2L12 3Zm0 6v5m0 3v.01',stack:'m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5'};
const statCards=computed(()=>[
 {key:'cycle',label:'当前周期',value:currentCycle.value?(statusText[currentCycle.value.status]??currentCycle.value.status):'—',note:currentCycle.value?`${currentCycle.value.title}（${currentCycle.value.month}）`:'暂无周期',icon:icons.calendar},
 {key:'calibration',label:'待评分核验',value:pendingCalibration.value,note:'超出阈值待处置的核验项',icon:icons.check,to:'/calibration'},
 {key:'confirm',label:'待确认结果',value:pendingConfirm.value,note:'已构建待确认',icon:icons.file,to:'/results'},
 {key:'publish',label:'待发布结果',value:pendingPublish.value,note:'已确认待发布',icon:icons.send,to:'/results'},
 {key:'stale',label:'需重新确认',value:staleBuilds.value,note:'需重算后重新确认',icon:icons.warning},
 {key:'cycles',label:'周期总数',value:cycles.value.length,note:'全部状态合计',icon:icons.stack},
].filter(card=>['cycle','cycles'].includes(card.key)||allowed('calibration.read_raw')));
</script>

<template>
  <div class="oversight-dashboard">
    <div class="page-head">
      <div>
        <h1 class="page-title">监管工作台</h1>
        <p class="page-sub">面向监管及获授权运营人员：周期状态、核验与结果待办、配置与规则入口。</p>
      </div>
      <div class="page-head-actions">
        <button v-if="allowed('cycle.manage')" class="btn" @click="router.push('/cycles')">周期配置</button>
        <button v-if="allowed('org.manage')" class="btn" @click="router.push('/rulesets')">规则集</button>
      </div>
    </div>

    <div v-if="loading" class="empty">正在加载…</div>
    <p v-else-if="failed" class="notice notice-warning">部分数据加载失败：{{ failed }}</p>

    <template v-if="!loading">
      <p v-if="!allowed('calibration.read_raw')" class="notice">你可以进入监管端查看周期状态；原始评分、评价人身份和组织授权操作仍需独立授权。</p>
      <div class="oversight-stats"><component v-for="item in statCards" :key="item.key" :is="item.to?'button':'article'" class="oversight-stat" :data-stat="item.key" :type="item.to?'button':undefined" @click="item.to&&router.push(item.to)"><span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="item.icon"/></svg></span><div class="stat-copy"><h2>{{item.label}}</h2><strong>{{item.value}}</strong><p>{{item.note}}</p></div></component></div>
      <div class="card"><h3>授权业务入口</h3><div class="row" style="gap:12px;flex-wrap:wrap"><RouterLink v-if="allowed('progress.read')" class="btn" to="/department/progress">授权部门进度</RouterLink><RouterLink v-if="allowed('assignment.manage')" class="btn" to="/department/assignments">部门评价关系</RouterLink><RouterLink v-if="allowed('result.read_published')" class="btn" to="/published-results">已发布结果</RouterLink></div></div>
      <div class="overview-main">

      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 class="section-title" style="margin:0"><span class="module-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="icons.calendar"/></svg></span>周期状态一览</h3>
          <button v-if="allowed('cycle.manage')" class="btn btn-sm" @click="router.push('/cycles')">进入周期与分配</button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>周期</th><th>月份</th><th>状态</th><th>参与人数</th><th></th></tr></thead>
            <tbody>
              <tr v-for="c in cycles" :key="c.id">
                <td>{{ c.title }}</td>
                <td>{{ c.month }}</td>
                <td><span class="chip" :class="chip(c.status)">{{ statusText[c.status] ?? c.status }}</span></td>
                <td>{{ c.participantCount ?? (Array.isArray(c.participants) ? c.participants.length : '—') }}</td>
                <td><button v-if="allowed('cycle.manage')" class="btn btn-sm" @click="router.push('/cycles/' + c.id)">查看</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" v-if="pendingCalibration">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">待处置核验项</h3>
          <button v-if="allowed('calibration.resolve')" class="btn btn-sm" @click="router.push('/calibration')">进入评分核验</button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>触发</th><th>被评价人</th><th>说明</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="cc in calCases.filter((c) => c.status === 'OPEN')" :key="cc.id">
                <td><span class="chip chip-amber">{{ cc.trigger }}</span></td>
                <td>{{ userName(cc.targetId) }}</td>
                <td class="muted">{{ cc.reason }}</td>
                <td><span class="chip chip-red">OPEN</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p class="notice">
        真实后端模式下，核验项与结果构建按周期逐个拉取；未授权 capability 的条目会返回 403 并被跳过，因此数量可能少于实际。
      </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.oversight-dashboard{color:#172b4d}.page-head{align-items:center;margin-bottom:26px;gap:20px}.page-title{font-size:28px;line-height:40px;font-weight:700;margin:0 0 8px;color:#172b4d}.page-sub{font-size:14px;line-height:24px;color:#667085}.page-head-actions{flex-wrap:wrap}.oversight-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:20px}.oversight-stat{display:flex;gap:12px;align-items:flex-start;min-width:0;min-height:146px;padding:18px 14px;border:1px solid #e5eaf2;border-radius:12px;background:#fff;text-align:left;font:inherit;color:inherit;box-shadow:0 3px 12px #172b4d05}.oversight-stat:is(button){cursor:pointer}.oversight-stat:is(button):hover{border-color:#aecbfb;box-shadow:0 4px 14px #246bfd0c}.stat-icon,.module-icon,.item-icon{display:grid;place-items:center;flex:0 0 36px;width:36px;height:36px;border-radius:10px;background:#edf4ff;color:#246bfd}.stat-icon svg,.module-icon svg,.item-icon svg{width:22px;height:22px;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.stat-copy{position:relative;flex:1;min-width:0}.stat-copy h2{font-size:12px;font-weight:500;color:#667085;line-height:20px;margin:0 0 10px}.stat-copy strong{font-family:inherit;display:block;font-size:24px;line-height:32px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.stat-copy p{font-size:11px;line-height:18px;color:#667085;margin:9px 0 0;max-width:150px}.oversight-stat[data-stat=calibration] .stat-icon,.orange{color:#c68a2e;background:#fff4e4}.oversight-stat[data-stat=confirm] .stat-icon,.purple{color:#8057ce;background:#f1ebff}.oversight-stat[data-stat=publish] .stat-icon{color:#26a291;background:#e8f8f3}.oversight-stat[data-stat=stale] .stat-icon{color:#db6977;background:#fff0f2}.oversight-columns{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(300px,1fr);gap:18px;align-items:start}.overview-main,.oversight-aside{min-width:0}.card{border:1px solid #e5eaf2;border-radius:12px;box-shadow:0 3px 12px #172b4d05;padding:22px;margin-bottom:18px}.section-title{display:flex;align-items:center;gap:12px;font-size:18px;line-height:26px;color:#172b4d}.row{margin-bottom:16px}.row .btn{white-space:nowrap}.table th{background:#f5f8fc;color:#667085;font-size:13px}.table td{font-size:13px;padding:14px 12px;border-color:#edf0f5}.table tbody tr:hover td{background:#f8fbff}.table .chip{border-radius:5px}.management-link{display:flex;align-items:center;gap:12px;padding:14px 4px;border-bottom:1px solid #edf0f5;color:#344054;font-size:14px;border-radius:6px}.management-link:last-child{border-bottom:0}.management-link:hover{background:#f5f9ff;color:#246bfd}.management-link>span:nth-child(2){flex:1;min-width:0}.item-icon{width:32px;height:32px;flex-basis:32px;border-radius:9px}.item-icon svg{width:20px;height:20px}.count{font-size:12px;min-width:28px;padding:2px 8px;border-radius:12px;text-align:center;font-weight:500}.blue{background:#edf4ff;color:#246bfd}.link-arrow{margin-left:auto;color:#8492a8}.shortcut{padding:11px 4px}.btn{border-radius:7px}.oversight-stat:focus-visible,.management-link:focus-visible{outline:3px solid #b4cefb;outline-offset:2px}@media(max-width:1550px){.oversight-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.oversight-stat{min-height:136px}.stat-copy p{max-width:210px}}@media(max-width:1100px){.oversight-columns{grid-template-columns:1fr}.oversight-aside{display:grid;grid-template-columns:1fr 1fr;gap:16px}.oversight-aside>.card{margin-bottom:0}}@media(max-width:680px){.page-head{align-items:flex-start;flex-direction:column;gap:14px}.page-title{font-size:25px}.oversight-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.oversight-stat{padding:14px 12px;gap:8px;min-height:146px}.stat-icon{width:28px;height:28px;flex-basis:28px}.stat-icon svg{width:19px;height:19px}.stat-copy strong{font-size:22px}.oversight-aside{grid-template-columns:1fr}.card{padding:18px 16px}.row{gap:12px}.table{min-width:520px}}
</style>
