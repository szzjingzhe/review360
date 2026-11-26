<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { mockApi } from '../api';

const router = useRouter();
const tasks = ref<any[]>([]);
const cycles = ref<any[]>([]);
const selectedCycleId = ref('');
const loading = ref(true);
const error = ref('');
const peerGate = ref<any>(null);
const filter = ref<'ALL' | 'PENDING' | 'SUBMITTED'>('ALL');
let sequence=0;
onMounted(async()=>{try{cycles.value=await mockApi.listCycles();await selectCycle(cycles.value.find(c=>c.status==='REVIEWING')?.id??cycles.value[0]?.id??'');}catch(e:any){error.value=e.message;loading.value=false;}});
const selectedCycle=computed(()=>cycles.value.find(c=>c.id===selectedCycleId.value));
const gateReason=computed<string|null>(()=>peerGate.value&&!peerGate.value.open?(peerGate.value.reason??'CYCLE_NOT_REVIEWING'):null);
const gateBlocked=computed(()=>gateReason.value!==null);
const selfCloseAt=computed(()=>peerGate.value?.selfCloseAt??selectedCycle.value?.selfCloseAt??'');
async function selectCycle(id:string){const seq=++sequence;selectedCycleId.value=id;filter.value='ALL';tasks.value=[];peerGate.value=null;loading.value=true;error.value='';try{if(!id)return;const data=await mockApi.getEvaluationTasks(id);if(seq!==sequence)return;peerGate.value=data.peerGate??null;tasks.value=data.peers.map((p:any)=>({id:p.review?.id,assignmentId:p.assignmentId,targetId:p.target.id,name:p.target.displayName,department:p.target.department,status:p.review?.status??'NOT_STARTED'}));}catch(e:any){if(seq===sequence)error.value=e.message;}finally{if(seq===sequence)loading.value=false;}}
function deadline(value:string){return value?new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'未配置截止时间';}
const pending = computed(() => tasks.value.filter((t) => t.status !== 'SUBMITTED'));
const submitted = computed(() => tasks.value.filter((t) => t.status === 'SUBMITTED'));
const shown = computed(() => filter.value === 'PENDING' ? pending.value : filter.value === 'SUBMITTED' ? submitted.value : tasks.value);
function retry() { void selectCycle(selectedCycleId.value); }
const canOpen=(task:any)=>!!task.id&&(task.status==='SUBMITTED'||(!!peerGate.value&&peerGate.value.open));
function chipText(task:any){if(task.status==='SUBMITTED')return '已提交';if(gateBlocked.value)return gateReason.value==='CYCLE_NOT_REVIEWING'?'评价期已结束':'他评未开启';return '待评价';}
function chipClass(task:any){if(task.status==='SUBMITTED')return 'chip-green';return gateBlocked.value?'chip-muted':'chip-amber';}
function actionText(task:any){if(!task.id)return '任务待初始化';if(task.status==='SUBMITTED')return '查看记录';return canOpen(task)?'开始评价':'他评未开启';}
const showSelfDeadline=(task:any)=>task.status!=='SUBMITTED'&&gateReason.value==='SELF_PHASE';
</script>

<template>
  <div class="personal-standard tasks-workspace">
    <div class="page-head"><div><h1 class="page-title">待我评价</h1><p class="page-sub">查看分配给你的对象，结合实际观察与月度成果完成评价。</p></div><label class="period-picker"><span class="sr-only">环评周期</span><select :value="selectedCycleId" @change="selectCycle(($event.target as HTMLSelectElement).value)"><option v-for="cycle in cycles" :key="cycle.id" :value="cycle.id">{{cycle.month}} 环评</option></select></label></div>
    <div class="metric-grid"><div class="metric-card"><span>环评月份</span><strong>{{selectedCycle?.month??'—'}}</strong><small>请选择要处理的月度环评任务</small></div><div class="metric-card"><span>待完成</span><strong>{{loading?'—':pending.length}}</strong><small>已分配，尚未提交</small></div><div class="metric-card"><span>已完成</span><strong>{{loading?'—':submitted.length}}</strong><small>本周期已提交评价</small></div><div class="metric-card"><span>任务总数</span><strong>{{loading?'—':tasks.length}}</strong><small>不含自评</small></div></div>
    <div v-if="error" class="notice notice-warning" role="alert">{{ error }} <button class="text-button" @click="retry">重试</button></div>
    <div v-if="gateBlocked" class="gate-banner" :class="{closed:gateReason==='CYCLE_NOT_REVIEWING'}" role="status">
      <b>{{ gateReason==='CYCLE_NOT_REVIEWING' ? '评价期已结束' : '他评未开启' }}</b>
      <p v-if="gateReason==='SELF_PHASE'">当前处于自评阶段（自评截止 {{ deadline(selfCloseAt) }}）。自评需要上传月度成果材料，为避免材料定稿前被互相查看，自评截止后才开放他评。</p>
      <p v-else-if="gateReason==='SELF_REVIEW_PENDING'">你本月还没有提交自评。他评页面会展示他人的月度成果材料，请先完成自评并上传材料后再参与他评。</p>
      <p v-else>本周期不在评价阶段，仅可查看已提交的评价记录。</p>
      <RouterLink v-if="gateReason==='SELF_PHASE'||gateReason==='SELF_REVIEW_PENDING'" class="gate-link" to="/self-review">去完成本月自评 →</RouterLink>
    </div>
    <section class="card task-panel">
      <div class="list-head"><div><h2>{{ selectedCycle?.month ?? '当前' }} 环评任务</h2><p>列表仅包含本人被授权的任务，不显示评价关系或岗位身份。</p></div><div class="segmented"><button v-for="item in [{key:'ALL',label:'全部'}, {key:'PENDING',label:'待完成'}, {key:'SUBMITTED',label:'已完成'}]" :key="item.key" :class="{active:filter===item.key}" @click="filter=item.key as any">{{ item.label }} <span>{{ item.key==='ALL'?tasks.length:item.key==='PENDING'?pending.length:submitted.length }}</span></button></div></div>
      <div v-if="loading" class="empty">正在从服务端加载任务…</div>
      <div v-else-if="!shown.length" class="empty-state"><div class="empty-icon">评</div><h3>{{ tasks.length ? '此分类暂无任务' : '当前没有待评价对象' }}</h3><p>{{ tasks.length ? '切换筛选查看其他任务。' : '月评正式发起并完成评审分配后，任务会出现在这里。当前不会填充演示任务。' }}</p></div>
      <div v-else class="task-list"><article v-for="task in shown" :key="task.assignmentId" class="task-row">
        <div class="task-avatar">{{ task.name.slice(0,1) }}</div>
        <div class="task-main"><b>{{ task.name }}</b><small>{{task.department||'部门未提供'}}</small><small>评价对象 · 本月评价任务</small></div>
        <span class="chip" :class="chipClass(task)">{{ chipText(task) }}</span>
        <div class="task-deadline"><small>{{ showSelfDeadline(task)?'自评截止':'提交截止' }}</small><b>{{ showSelfDeadline(task)?deadline(selfCloseAt):deadline(selectedCycle?.closeAt) }}</b></div>
        <button class="btn" :disabled="!canOpen(task)" :class="task.status==='SUBMITTED'?'':'btn-primary'" @click="router.push('/reviews/' + task.id)">{{ actionText(task) }} <span>→</span></button>
      </article></div>
    </section>
    <p class="privacy-note"><span>i</span> 评价内容仅用于本期环评。个人端不会显示其他评价人的姓名、部门或排名。</p>
  </div>
</template>

<style scoped>
.eyebrow{margin:0 0 4px;color:var(--lark-primary);font:12px/18px 'Times New Roman',serif;letter-spacing:.12em}.page-head{align-items:center;margin-bottom:22px}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:18px}.metric-card{display:flex;flex-direction:column;padding:16px 19px;border:1px solid var(--lark-border-light);border-radius:9px;background:#fff}.metric-card span{font-size:13px;color:var(--lark-text-2)}.metric-card strong{font:700 28px/36px 'Times New Roman',serif}.metric-card small{color:var(--lark-text-3);font-size:12px}.task-panel{padding:0 22px 12px}.list-head{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px 0;border-bottom:1px solid var(--lark-border-light)}.list-head h2{margin:0 0 4px;font-size:17px}.list-head p{margin:0;color:var(--lark-text-3);font-size:13px}.segmented{display:flex;gap:4px;padding:3px;border-radius:7px;background:#f2f3f5}.segmented button{padding:5px 9px;border:0;border-radius:5px;background:transparent;color:var(--lark-text-2);font:inherit;cursor:pointer;white-space:nowrap}.segmented button.active{background:#fff;color:var(--lark-primary);box-shadow:0 1px 3px #1f23291a}.segmented span{font-family:'Times New Roman',serif}.task-row{display:flex;align-items:center;gap:14px;padding:15px 0;border-bottom:1px solid var(--lark-border-light)}.task-row:last-child{border-bottom:0}.task-avatar{width:40px;height:40px;display:grid;place-items:center;flex:none;border-radius:50%;background:#eaf1ff;color:var(--lark-primary);font-size:16px}.task-main{flex:1;min-width:0}.task-main b,.task-main small{display:block}.task-main b{font-size:15px}.task-main small,.task-result small{color:var(--lark-text-3);font-size:12px}.task-result{text-align:right;min-width:55px}.task-result strong{display:block;font:600 18px 'Times New Roman',serif}.task-result small{display:block}.empty-state{text-align:center;padding:38px 12px}.empty-state h3{margin:0 0 5px}.empty-state p{max-width:460px;margin:0 auto;color:var(--lark-text-2)}.empty-icon{display:grid;place-items:center;width:42px;height:42px;margin:0 auto 12px;border-radius:12px;background:var(--lark-primary-bg);color:var(--lark-primary)}.privacy-note{display:flex;gap:8px;align-items:center;color:var(--lark-text-3);font-size:12px}.privacy-note span{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#edf1f7}.text-button{padding:0;border:0;background:none;color:var(--lark-primary);cursor:pointer}@media(max-width:680px){.list-head{align-items:flex-start;flex-direction:column}.task-row{flex-wrap:wrap}.task-main{min-width:55%}.task-result{margin-left:auto}.task-row .btn{width:100%}.metric-grid{grid-template-columns:repeat(3,1fr)}.metric-card{padding:12px}.metric-card strong{font-size:23px}}
.cycle-switcher{display:flex;align-items:center;gap:22px;padding:14px 16px;margin-bottom:18px;border:1px solid var(--lark-border-light);border-radius:10px;background:#fff}.cycle-switcher-title{min-width:145px}.cycle-switcher-title b,.cycle-switcher-title span{display:block}.cycle-switcher-title span{margin-top:4px;color:var(--lark-text-3);font-size:12px}.cycle-switcher-tabs{display:flex;gap:8px;overflow:auto}.cycle-switcher-tabs button{min-width:145px;padding:10px 14px;border:1px solid var(--lark-border-light);border-radius:8px;background:#fff;text-align:left;cursor:pointer}.cycle-switcher-tabs button:hover{border-color:var(--lark-primary);background:var(--lark-primary-bg)}.cycle-switcher-tabs button.active{border-color:var(--lark-primary);box-shadow:0 0 0 2px #3370ff22;color:var(--lark-primary)}.cycle-switcher-tabs strong,.cycle-switcher-tabs span{display:block}.cycle-switcher-tabs span{margin-top:4px;color:var(--lark-text-3);font-size:12px}@media(max-width:680px){.cycle-switcher{align-items:flex-start;flex-direction:column;gap:10px}.cycle-switcher-title{min-width:0}}
</style>

<style scoped>
.metric-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.metric-card{padding:24px;border-radius:10px;gap:4px;box-shadow:0 2px 8px #172b4d03}.metric-card strong{font-family:inherit;color:#172b4d;font-size:27px}.metric-card small,.task-main small{font-size:13px}.task-row{padding:25px 0;gap:20px}.task-avatar{width:58px;height:58px;font-size:24px}.task-main b{font-size:18px}.task-deadline{border-left:1px solid #e5eaf2;padding-left:24px;min-width:180px}.task-deadline small,.task-deadline b{display:block}.task-deadline small{color:#667085}.period-picker{width:260px}.period-picker select{width:100%;padding:14px;border:1px solid #e5eaf2;border-radius:8px;background:#fff}.chip-amber{background:#eef4ff;color:#246bfd}.task-panel{border:1px solid #e5eaf2;border-radius:10px}.task-main{overflow-wrap:anywhere}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@media(max-width:1100px){.metric-grid{grid-template-columns:repeat(2,1fr)}.task-deadline{min-width:0}}@media(max-width:680px){.page-head{align-items:flex-start;flex-direction:column;gap:14px}.task-deadline{margin-left:auto;border:0;padding:0}.metric-card{padding:16px}.period-picker{max-width:100%}}
.gate-banner{display:flex;flex-direction:column;gap:4px;padding:14px 18px;margin-bottom:16px;border:1px solid #ffe2bf;border-left:4px solid #f0a020;border-radius:8px;background:#fffbf3}
.gate-banner b{font-size:14px;color:#a3610a}
.gate-banner p{margin:0;color:#7a5a2e;font-size:13px;line-height:1.7}
.gate-banner.closed{border-color:#e5eaf2;border-left-color:#9aa5b4;background:#f7f8fa}
.gate-banner.closed b{color:#5f6b7a}.gate-banner.closed p{color:#667085}
.gate-link{align-self:flex-start;margin-top:6px;color:#246bfd;font-size:13px;text-decoration:none}
.chip-muted{background:#f2f3f5;color:#5f6b7a}
.task-row .btn:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}
</style>