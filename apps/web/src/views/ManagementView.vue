<script setup lang="ts">
import {computed,defineAsyncComponent,onMounted,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useAuth} from '../stores/auth';
import {managementRequest,cycleStage} from '../api/management';
import CyclesView from './CyclesView.vue';
import CycleManagement from './CycleManagement.vue';
import AssignmentRelationsView from './AssignmentRelationsView.vue';
import AnnouncementEditor from '../components/AnnouncementEditor.vue';
import ModelSettingsPanel from '../components/ModelSettingsPanel.vue';
import MonthlyNavigation from '../components/MonthlyNavigation.vue';
import RulesetsView from './RulesetsView.vue';
import ResultsView from './ResultsView.vue';
import ManagementExceptions from '../components/ManagementExceptions.vue';
import FeedbackManagementView from './FeedbackManagementView.vue';
import OrganizationView from './OrganizationView.vue';
import UserManagementView from './UserManagementView.vue';
import AuditView from './AuditView.vue';
import RolePermissionsPanel from '../components/RolePermissionsPanel.vue';
import GrowthReviewPanel from '../components/GrowthReviewPanel.vue';
import MonthlyInsights from '../components/MonthlyInsights.vue';
import MonthlyArchive from '../components/MonthlyArchive.vue';
const ManagementCockpit=defineAsyncComponent(()=>import('../components/ManagementCockpit.vue'));
const route=useRoute(),auth=useAuth();
const router=useRouter();
const module=computed(()=>String(route.params.module??''));
const tab=computed(()=>String(route.params.section??route.query.tab??(module.value==='settings'?'users':'cycles')));
const cycles=ref<any[]>([]),departments=ref<any[]>([]),rows=ref<any[]>([]),submissions=ref<any[]>([]);
const trends=ref<any[]>([]);
const cycleId=ref(''),departmentId=ref(''),history=ref(false),error=ref(''),loading=ref(false);
const current=computed(()=>cycles.value.find(c=>c.id===cycleId.value));
const titles:Record<string,string>={'':'管理工作台',monthly:'月评管理',rules:'评价规则',insights:'月报洞察',archives:'月评档案',feedback:'反馈申诉',settings:'系统设置'};
const tabs=computed(()=>module.value==='settings'?[['users','用户与飞书绑定'],['organization','组织架构'],['roles','角色权限'],['model','模型配置'],['audit','操作日志']]:[]);
const distributions=computed(()=>['0–59','60–79','80–100'].map((label,index)=>({label,count:rows.value.filter(r=>{const v=r.payload_json?.final_score;return v!=null&&(index===0?Number(v)<60:index===1?Number(v)>=60&&Number(v)<80:Number(v)>=80);}).length})));
const dimensions=computed(()=>{
 const map=new Map<string,{label:string;sum:number;count:number;selfSum:number;selfCount:number}>();
 for(const row of rows.value){for(const [series,isSelf] of [['peerItems',false],['selfItems',true]] as const){
  for(const item of row.dimension_aggregates?.[series]??[]){
   const metric=row.dimension_metadata?.[item.itemId];if(!metric?.code||item.avgScore==null)continue;
   const d=map.get(metric.code)??{label:metric.label,sum:0,count:0,selfSum:0,selfCount:0};
   if(isSelf){d.selfSum+=Number(item.avgScore);d.selfCount++;}else{d.sum+=Number(item.avgScore);d.count++;}map.set(metric.code,d);
  }
 }}
 return [...map.values()].map(d=>({...d,peer:d.count?d.sum/d.count:null,self:d.selfCount?d.selfSum/d.selfCount:null}));
});
const historyTrend=computed(()=>[...new Set(trends.value.map(r=>r.month))].sort().map(month=>{const values=trends.value.filter(r=>r.month===month&&r.payload_json.final_score!=null).map(r=>Number(r.payload_json.final_score));return {month,average:values.length?values.reduce((a,b)=>a+b,0)/values.length:null};}));
const departmentSummary=computed(()=>departments.value.map(d=>({name:d.name,count:new Set(rows.value.filter(r=>r.department_id===d.id).map(r=>`${r.cycle_id}:${r.target_id}`)).size})));
async function loadRows(){if(module.value!=='archives')return;
 loading.value=true;error.value='';try{rows.value=await managementRequest(`management/archives?cycleId=${cycleId.value}&history=${history.value}`);
 if(module.value==='archives'&&tab.value==='submissions')submissions.value=await managementRequest(`management/submissions?cycleId=${cycleId.value}`);
 }catch(e){error.value=e instanceof Error?e.message:'加载失败';}finally{loading.value=false;}}
async function load(){loading.value=true;try{[cycles.value,departments.value]=await Promise.all([managementRequest('management/dashboard'),managementRequest('management/departments')]);cycleId.value=(cycles.value.find(c=>c.id===route.query.cycleId)??(cycles.value.find(c=>['REVIEWING','CALIBRATING','PARTIALLY_PUBLISHED'].includes(c.status))??cycles.value.find(c=>c.status==='PUBLISHED')??cycles.value[0]))?.id??'';departmentId.value=departments.value[0]?.id??'';await loadRows();}catch(e){error.value=e instanceof Error?e.message:'加载失败';}finally{loading.value=false;}}
const needsParentData=computed(()=>module.value==='insights'||(module.value==='monthly'&&tab.value==='growth'));
onMounted(()=>{if(needsParentData.value)void load();});watch(needsParentData,v=>{if(v&&!cycles.value.length)void load();});watch(module,()=>{error.value='';});
async function settingsTabKey(event:KeyboardEvent,index:number){
 if(module.value!=='settings')return;
 const keys=tabs.value.map(([key])=>key);let next=index;
 if(event.key==='ArrowRight')next=(index+1)%keys.length;
 else if(event.key==='ArrowLeft')next=(index+keys.length-1)%keys.length;
 else if(event.key==='Home')next=0;else if(event.key==='End')next=keys.length-1;else return;
 event.preventDefault();await router.replace({path:route.path,query:{...route.query,tab:keys[next]}});
 document.getElementById('settings-tab-'+keys[next])?.focus();
}
</script>
<template>
 <div class="management" :class="{'settings-page':module==='settings'}">
  <header v-if="module"><h1>{{titles[module]??'管理端'}}</h1><p>{{module==='settings'?'管理用户与飞书绑定、组织架构、角色权限和操作日志。':module==='monthly'?'管理月评周期、参评名单与评价时间规则，作为整期评价的基础配置。':'按正式周期快照管理月评，结果确认与发布由授权人员执行。'}}</p></header>
  <MonthlyNavigation v-if="module==='monthly'"/>
  <nav v-if="tabs.length" class="tabs" :role="module==='settings'?'tablist':undefined" :aria-label="module==='settings'?'系统设置模块':undefined"><RouterLink v-for="([key,label],index) in tabs" :key="key" :id="module==='settings'?'settings-tab-'+key:undefined" :to="{path:route.path,query:{tab:key}}" :class="{active:tab===key}" :role="module==='settings'?'tab':undefined" :aria-selected="module==='settings'?tab===key:undefined" :aria-controls="module==='settings'?'settings-panel-'+key:undefined" :tabindex="module==='settings'?(tab===key?0:-1):undefined" @keydown="settingsTabKey($event,index)">{{label}}</RouterLink></nav>
  <p v-if="error" class="notice notice-danger" role="alert">{{error}} <button class="btn" @click="load">重试</button></p>
  <ManagementCockpit v-if="!module"/>
  <template v-else-if="module==='monthly'">
   <CycleManagement v-if="tab==='cycles'"/>
   <AssignmentRelationsView v-else-if="tab==='relations'" />
   <AnnouncementEditor v-else-if="tab==='announcement'" />
   <ManagementExceptions v-else-if="tab==='exceptions'"/>
   <ResultsView v-else-if="tab==='results'"/>
   <GrowthReviewPanel v-else-if="tab==='growth'" :cycles="cycles"/>
  </template>
  <RulesetsView v-else-if="module==='rules'"/>
  <FeedbackManagementView v-else-if="module==='feedback'"/>
  <MonthlyInsights v-else-if="module==='insights'" :cycles="cycles" :departments="departments" v-model:cycle-id="cycleId" v-model:department-id="departmentId"/>
  <MonthlyArchive v-else-if="module==='archives'"/>
  <section v-else-if="module==='settings'" :id="'settings-panel-'+tab" class="settings-content" role="tabpanel" :aria-labelledby="'settings-tab-'+tab"><OrganizationView v-if="tab==='organization'"/><AuditView v-else-if="tab==='audit'"/><RolePermissionsPanel v-else-if="tab==='roles'"/><ModelSettingsPanel v-else-if="tab==='model'"/><UserManagementView v-else/></section>
  <template v-else-if="module==='archives'||module==='insights'">
   <div class="filters"><label>周期 <select v-model="cycleId"><option v-for="c in cycles" :key="c.id" :value="c.id">{{c.title}} · {{c.month}}</option></select></label><label v-if="module==='insights'">部门 <select v-model="departmentId"><option v-for="d in departments" :key="d.id" :value="d.id">{{d.name}}</option></select></label><label v-if="module==='archives'"><input v-model="history" type="checkbox"> 查看历史发布版本及更正链</label></div>
   <section class="panel" v-if="module==='insights'"><h2>本部门正式成绩分布</h2><p>只统计所选部门的最新有效发布版本，部门归属来自周期快照。</p><div v-for="d in distributions" :key="d.label" class="trend"><span>{{d.label}}</span><progress :max="Math.max(rows.length,1)" :value="d.count"/><span>{{d.count}} 人</span></div><p v-if="!rows.length">本部门暂无正式发布成绩。</p><h2 style="margin-top:24px">维度与自他评差异</h2><table><thead><tr><th>维度</th><th>他评汇总</th><th>自评汇总</th><th>差值（自评－他评）</th></tr></thead><tbody><tr v-for="d in dimensions" :key="d.label"><td>{{d.label}}</td><td>{{d.peer?.toFixed(2)??'—'}}</td><td>{{d.self?.toFixed(2)??'—'}}</td><td>{{d.self!=null&&d.peer!=null?(d.self-d.peer).toFixed(2):'—'}}</td></tr></tbody></table><h2 style="margin-top:24px">本部门历史趋势</h2><div v-for="t in historyTrend" :key="t.month" class="trend"><span>{{t.month}}</span><progress v-if="t.average!=null" :value="t.average" max="100"/><span>{{t.average?.toFixed(2)??'—'}}</span></div></section>
   <section class="panel scroll" v-else-if="tab==='cycles'"><table><thead><tr><th>周期</th><th>阶段</th><th>有效人数</th><th>发布人数</th></tr></thead><tbody><tr v-for="c in cycles" :key="c.id"><td>{{c.month}} {{c.title}}</td><td>{{cycleStage(c.status)}}</td><td>{{c.participants}}</td><td>{{c.published}}</td></tr></tbody></table></section>
   <section class="panel scroll" v-else-if="tab==='submissions'"><table><thead><tr><th>成员</th><th>参评资格</th><th>材料</th><th>自评</th></tr></thead><tbody><tr v-for="s in submissions" :key="s.user_id"><td>{{s.display_name}}</td><td>{{s.eligibility}}</td><td>{{s.active_version_id?'已提交':'未提交'}}</td><td>{{s.self_status==='SUBMITTED'?'已提交':'未提交'}}</td></tr></tbody></table></section>
   <section class="panel" v-else-if="tab==='departments'"><h2>部门发布结果</h2><p>不作跨部门平均分或排名比较。</p><p v-for="d in departmentSummary" :key="d.name">{{d.name}}：{{d.count}} 份正式发布结果</p></section>
   <section class="panel scroll" v-else><table><thead><tr><th>成员</th><th>历史部门</th><th>版本</th><th>最终分</th><th>自评分</th><th>他评平均分</th><th>有效他评数量</th><th>更正来源</th></tr></thead><tbody><tr v-for="r in rows" :key="r.id"><td>{{r.display_name}}</td><td>{{r.department_name??'—'}}</td><td>{{r.publication_version}}</td><td>{{r.payload_json.final_score??'—'}}</td><td>{{r.payload_json.self_score??'—'}}</td><td>{{r.peer_average??'—'}}</td><td>{{r.payload_json.peer_count??'—'}}</td><td>{{r.supersedes_id??'首次发布'}}</td></tr></tbody></table><p v-if="!rows.length">暂无正式发布结果</p></section>
  </template>
 </div>
</template>
<style scoped>
.management{color:#172b4d;min-width:0}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:0 0 14px}header{margin-bottom:20px}p,small{color:#748196;line-height:1.7}header p{margin:0}.tabs,.links,.filters{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 20px;align-items:center}.tabs a,.links a{padding:9px 14px;border-radius:7px;color:#42628b;background:#fff;text-decoration:none}.tabs a.active{color:#246bfd;box-shadow:inset 0 -2px #246bfd}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}.panel{background:white;border:1px solid #e1e8f2;border-radius:12px;padding:22px;margin-bottom:18px;min-width:0;text-decoration:none}.stats strong{font-size:26px;display:block;color:#172b4d;margin:12px 0}.stats p{font-size:12px}.stats small{display:block}.ring{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;margin:10px 0}.ring i{display:block;width:35px;height:35px;border-radius:50%;background:white}.trend{display:flex;gap:16px;align-items:center;padding:12px 0}.trend>span:first-child{min-width:75px}.trend progress{flex:1}.trend span:last-child{min-width:100px;font-size:13px}progress{width:100%;height:10px;accent-color:#3370ff}select{min-height:36px;border:1px solid #dce4ef;border-radius:7px;padding:5px 10px;max-width:100%}.filters label{display:flex;gap:8px;align-items:center}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:13px 10px;border-bottom:1px solid #edf1f7;white-space:nowrap}th{background:#f4f7fc;color:#687890}.scroll{overflow:auto}@media(max-width:1300px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:750px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:16px}.stats strong{font-size:23px}.trend{gap:8px}.trend span:last-child{min-width:65px}}

/* System-settings-only surface. Other modules keep their existing tab/card styles. */
.settings-page>header{margin-bottom:12px}.settings-page>.tabs{gap:28px;flex-wrap:nowrap;overflow-x:auto;margin-bottom:24px;border-bottom:1px solid var(--lark-border-light,#e5eaf2);padding:0;scrollbar-width:thin}
.settings-page>.tabs a{position:relative;flex:none;display:inline-flex;align-items:center;min-height:46px;padding:0 0 12px;border:0;border-radius:0;background:transparent;color:var(--lark-text-2,#646a73);font-size:14px;line-height:22px;box-shadow:none;text-decoration:none;white-space:nowrap}
.settings-page>.tabs a:hover{color:var(--lark-primary,#3370ff)}.settings-page>.tabs a.active{color:var(--lark-primary,#3370ff);font-weight:600;box-shadow:none}.settings-page>.tabs a.active:after{content:'';position:absolute;inset:auto 0 0;height:2px;background:var(--lark-primary,#3370ff)}.settings-page>.tabs a:focus-visible{outline:2px solid #a9c7ff;outline-offset:-2px}
.settings-content{min-width:0}.settings-page :deep(.card){padding:22px 24px;border:1px solid var(--lark-border-light,#e8edf4);border-radius:12px;box-shadow:0 2px 6px #172b4d03;margin-bottom:20px;background:#fff}.settings-page :deep(h2){font-size:18px;line-height:26px;margin:0;font-weight:600}.settings-page :deep(.page-title){font-size:20px;line-height:28px}.settings-page :deep(.btn){min-height:36px;padding:6px 14px;border-radius:7px;font-size:13px;box-shadow:none}.settings-page :deep(select),.settings-page :deep(input:not([type=checkbox])){min-height:36px;border:1px solid var(--lark-border,#dce4ef);border-radius:7px;background:#fff;padding:6px 10px;font:inherit;font-size:13px;box-sizing:border-box}.settings-page :deep(textarea){border:1px solid var(--lark-border,#dce4ef);border-radius:7px;padding:10px;box-sizing:border-box;font:inherit;font-size:13px;resize:vertical}.settings-page :deep(.table){border:0;border-radius:0;font-size:13px}.settings-page :deep(.table th){background:#f5f7fb;color:#68758a;font-weight:500}.settings-page :deep(.table th),.settings-page :deep(.table td){padding:13px 14px;line-height:21px;border-bottom:1px solid #edf1f6}.settings-page :deep(.notice){margin:14px 0;padding:10px 12px;font-size:13px;line-height:20px;border-radius:7px}.settings-page :deep(.notice-error){color:#b42318;background:#fff4f3;border:1px solid #fee4e2}.settings-page :deep(.notice-success){color:#18815f;background:#effaf4;border:1px solid #d9f2e4}
@media(max-width:760px){.settings-page>.tabs{gap:24px;margin-bottom:20px}.settings-page :deep(.card){padding:18px 16px}.settings-page>header h1{font-size:26px}}

</style>

