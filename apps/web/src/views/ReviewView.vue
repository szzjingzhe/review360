<script setup lang="ts">
import { codePointLength, meaningfulTextLength, requiresItemReason, itemReasonError, reasonFreeRange } from '../lib/itemReasons';

import {computed,onMounted,onUnmounted,ref,watch} from 'vue';
import {onBeforeRouteLeave,onBeforeRouteUpdate,useRoute} from 'vue-router';
import {mockApi} from '../api';
import ScoreInput from '../components/ScoreInput.vue';
import MaterialPreviewDrawer from '../components/MaterialPreviewDrawer.vue';
import {hydrateSelfReview,selfDraft,selfTotal,scoreError,scoreValue,type SelfReviewForm} from '../lib/selfReview';
const route=useRoute(),form=ref<SelfReviewForm|null>(null),detail=ref<any>(null),materials=ref<any>(null),materialError=ref(''),loadError=ref(''),message=ref(''),busy=ref(false),baseline=ref(''),allMaterials=ref(false),selected=ref<any>(null),invalid=ref<Record<string,boolean>>({});
let sequence=0;
const fingerprint=()=>JSON.stringify(form.value?{draft:selfDraft(form.value),scores:form.value.items.map(i=>i.scoreText)}:null);
const revision=computed(()=>detail.value?.revisionRequest);
const canRevise=computed(()=>!!revision.value&&!revision.value.expired);
const readOnly=computed(()=>!!form.value&&(form.value.status!=='DRAFT'&&!canRevise.value));
const dirty=computed(()=>!readOnly.value&&!!form.value&&fingerprint()!==baseline.value);
const total=computed(()=>readOnly.value&&form.value?.scoreBp!=null?form.value.scoreBp/100:form.value?selfTotal(form.value.items):null);
const reasonIssues=computed(()=>readOnly.value?[]:(form.value?.items??[]).filter(i=>!!itemReasonError(scoreValue(i.scoreText),i.reason,form.value?.reasonRules)));
const overallRequired=computed(()=>{const f=form.value,r=f?.reasonRules;if(!f||r?.mode!=='prd')return 0;return total.value!==null&&total.value>=r.highInclusive?(r.overallMinChars??0):0;});
const freeRange=computed(()=>reasonFreeRange(form.value?.reasonRules));
const scoredCount=computed(()=>(form.value?.items??[]).filter(i=>scoreValue(i.scoreText)!==null&&!invalid.value[i.id]).length);
const unscoredNames=computed(()=>(form.value?.items??[]).filter(i=>scoreValue(i.scoreText)===null||invalid.value[i.id]).map(i=>i.label));
const reasonShortNames=computed(()=>reasonIssues.value.map(i=>i.label));
const blockers=computed(()=>{
  if(readOnly.value||!form.value)return [] as string[];
  const list:string[]=[];
  if(invalid.value&&Object.values(invalid.value).some(Boolean))list.push('有分数输入格式不正确');
  if(unscoredNames.value.length)list.push('还有 '+unscoredNames.value.length+' 项指标未评分（'+unscoredNames.value.join('、')+'）');
  if(reasonShortNames.value.length)list.push('还需为 '+reasonShortNames.value.join('、')+' 填写评分理由');
  if(overallRequired.value&&meaningfulTextLength(form.value.overallReason)<overallRequired.value)list.push('整体评价说明至少 '+overallRequired.value+' 字');
  if(!form.value.readConfirmed)list.push('请勾选“我已阅读评价规范”');
  return list;
});
function reasonRequired(item:{scoreText:string}){return requiresItemReason(scoreValue(item.scoreText),form.value?.reasonRules);}
function reasonTag(item:{scoreText:string}){if(readOnly.value)return '已提交';return reasonRequired(item)?`必填 · 至少 ${form.value?.reasonRules?.minChars??30} 字`:`选填 · ${freeRange.value.min}—${freeRange.value.max} 分可不填`;}
function reasonHint(item:{scoreText:string;reason:string}){return itemReasonError(scoreValue(item.scoreText),item.reason,form.value?.reasonRules);}
function focusReason(id?:string){const el=document.getElementById('reason-'+(id??reasonIssues.value[0]?.id));el?.scrollIntoView({block:'center',behavior:'smooth'});el?.focus();}
const valid=computed(()=>form.value&&total.value!==null&&!form.value.items.some(i=>scoreError(i.scoreText)||invalid.value[i.id]));
const shownMaterials=computed(()=>allMaterials.value?materials.value?.materials??[]:(materials.value?.materials??[]).slice(0,3));
function openLink(url:string){window.open(url,'_blank','noopener,noreferrer');}
function errorText(e:any){const m=String(e?.message??e);return ({READ_CONFIRM_REQUIRED:'请先确认已阅读评价规范。',REVIEW_PERIOD_CLOSED:'当前评价期已结束。',PEER_REVIEW_NOT_OPEN:'他评暂未开启：当前仍在统一自评阶段，自评截止后才开放他评。',PEER_REVIEW_LOCKED_SELF_PENDING:'他评暂未开启：请先完成并提交本月自评（含材料上传）。',MATERIAL_ACCESS_DENIED:'没有查看此任务材料的权限。',MATERIAL_ACCESS_CLOSED:'当前阶段不开放评价材料访问。',MATERIAL_FILE_MISSING:'文件不存在或已不可用。'} as Record<string,string>)[m]??m;}
async function load(id:string){const seq=++sequence;form.value=null;detail.value=null;materials.value=null;materialError.value='';loadError.value='';message.value='';selected.value=null;invalid.value={};allMaterials.value=false;try{const data=await mockApi.getReviewPage(id);if(seq!==sequence)return;detail.value=data;const revising=data.review.status==='SUBMITTED'&&data.revisionRequest&&!data.revisionRequest.expired;
const source=revising&&data.draft?.rowVersion?{...data,review:{...data.review,status:'DRAFT'}}:data;
form.value=hydrateSelfReview(source);
const hints:Record<string,{description:string;placeholder:string}>={
 delivery:{description:'工作任务的完成情况、质量及交付及时性。',placeholder:'例如：按时完成了本月重点任务，成果质量符合预期；说明需求分析、沟通或交付中的具体表现。'},
 collaboration:{description:'团队协作、沟通配合及对他人的支持。',placeholder:'例如：在跨部门沟通中积极协调资源，主动分享经验，为团队成员提供有效支持。'},
 growth:{description:'专业能力提升、学习主动性及改进效果。',placeholder:'例如：主动学习新技术并应用到实际工作，结合具体成果说明能力提升。'},
 innovation:{description:'工作方法、流程优化或业务创新方面的表现。',placeholder:'例如：提出并推动流程优化方案，提升工作效率，说明实际改进效果。'}
};
form.value.items.forEach(item=>{const original=data.template.items.find((i:any)=>i.id===item.id),hint=hints[item.code];if(hint){item.description=original.description||hint.description;item.placeholder=original.placeholder||original.fillingHint||hint.placeholder;}});
form.value.status=data.review.status;baseline.value=fingerprint();void loadMaterials(id,seq);
}catch(e){if(seq===sequence)loadError.value=errorText(e);}}
async function loadMaterials(id=String(route.params.reviewId),seq=sequence){materialError.value='';try{const data=await mockApi.getReviewMaterials(id);if(seq===sequence)materials.value=data;}catch(e){if(seq===sequence)materialError.value=errorText(e);}}
async function act(submit=false){if(busy.value||readOnly.value||!form.value)return;if(submit&&blockers.value.length){message.value='暂时不能提交：'+blockers.value.join('；')+'。';if(unscoredNames.value.length){const target=form.value.items.find(i=>unscoredNames.value.includes(i.label));document.getElementById('score-'+target?.id)?.scrollIntoView({block:'center',behavior:'smooth'});document.getElementById('score-'+target?.id)?.focus();}else if(reasonShortNames.value.length)focusReason();else if(overallRequired.value&&meaningfulTextLength(form.value.overallReason)<overallRequired.value)document.getElementById('overall')?.focus();else document.querySelector('.confirm input')?.scrollIntoView({block:'center',behavior:'smooth'});return;}if(submit&&reasonIssues.value.length){message.value='请补充评分指标的必填理由。';focusReason();return;}if(busy.value||readOnly.value||!form.value)return;if(form.value.items.some(i=>scoreError(i.scoreText)||invalid.value[i.id])){message.value='请修正分数输入。';return;}if(submit&&(!valid.value||!form.value.readConfirmed)){message.value='请完成所有评分，并确认已阅读评价规范。';return;}busy.value=true;message.value='';try{if(submit&&materials.value?.basis==='CURRENT'){
const fresh=await mockApi.getReviewMaterials(form.value.id);
const versionKey=(data:any)=>JSON.stringify(data.materials.map((f:any)=>f.id).sort());
if(versionKey(fresh)!==versionKey(materials.value)){materials.value=fresh;form.value.readConfirmed=false;message.value='成果材料已更新，请重新查看材料并确认后提交。';return;}
}await mockApi.saveSelfReviewDraft(form.value.id,selfDraft(form.value));baseline.value=fingerprint();if(submit){if(canRevise.value)await mockApi.submitRevision(form.value.id);else await mockApi.submitReview(form.value.id);await load(form.value.id);message.value='评价已成功提交。';}else message.value='草稿已保存。';}catch(e){if(submit&&form.value){try{const fresh=await mockApi.getReviewPage(form.value.id);if(fresh.review.status==='SUBMITTED'&&(!canRevise.value||fresh.latestRevision?.revisionNo>(detail.value?.latestRevision?.revisionNo??0))){await load(form.value.id);message.value='评价已成功提交。';return;}}catch{/* Preserve entered content when the server cannot confirm persistence. */}}message.value='操作失败：'+((e as any)?.violations?.[0]?.detail??errorText(e));if((e as any)?.violations?.[0]?.itemId)focusReason((e as any).violations[0].itemId);}finally{busy.value=false;}}
function leave(){return !busy.value&&(!dirty.value||window.confirm('当前评价有未保存内容，离开会丢失修改。是否继续？'));}
function unload(e:BeforeUnloadEvent){if(dirty.value||busy.value){e.preventDefault();e.returnValue='';}}
onBeforeRouteLeave(leave);onBeforeRouteUpdate(leave);watch(()=>route.params.reviewId,id=>void load(String(id)));onMounted(()=>{void load(String(route.params.reviewId));window.addEventListener('beforeunload',unload);});onUnmounted(()=>{sequence++;window.removeEventListener('beforeunload',unload);});
</script>
<template>
 <div class="evaluation-page personal-standard">
  <RouterLink class="back" to="/tasks">← 返回待我评价</RouterLink>
  <div v-if="loadError" class="panel"><h2>评价任务暂时无法打开</h2><p role="alert">{{loadError}}</p></div>
  <div v-else-if="!form" class="panel">正在加载评价任务…</div>
  <template v-else>
   <header><div><p class="blue">月度评价</p><h1>评价：{{detail.review.target.displayName}}</h1><p>请结合本月具体事实与成果进行评价，提交后将按本周期规则校验。</p></div><span class="badge">{{form.status==='SUBMITTED'?'已提交':form.status==='DRAFT'?'草稿':'已撤回'}}</span></header>
   <div v-if="revision" class="panel">核验意见：{{revision.reason||'—'}}<p>修订截止：{{revision.dueAt?new Date(revision.dueAt).toLocaleString('zh-CN'):'未设置'}} {{revision.expired?'（已过期）':''}}</p></div>
   <div class="columns">
    <aside class="materials"><section class="panel"><h2>月度成果材料</h2><p>结合实际工作与可核实成果评价。{{materials?.basis==='SNAPSHOT'?'以下为提交时固定的材料版本。':'提交前展示当前有效版本；更新材料后请重新核对。'}}</p>
     <p v-if="materialError" role="alert">{{materialError}} <button class="link" @click="loadMaterials()">重试</button></p><p v-else-if="!materials">正在加载材料…</p><p v-else-if="materials.snapshotUnavailable">历史评价未记录材料快照，暂无法提供对应材料。</p><p v-else-if="!materials.materials.length">暂无可供查看的成果材料</p>
     <button v-for="file in shownMaterials" :key="file.id" class="file" @click="file.externalUrl?openLink(file.externalUrl):(selected=file)"><span class="file-icon">{{file.externalUrl?'LINK':file.fileName.split('.').pop()?.toUpperCase()}}</span><span><b>{{file.fileName}}</b><small>{{file.type==='MONTHLY_REPORT'?'主月报':'补充材料'}} · V{{file.version}}{{file.externalUrl?' · 飞书云文档':''}}</small><small>{{new Date(file.createdAt).toLocaleString('zh-CN')}}</small></span><span>↗</span></button>
     <button v-if="materials?.materials.length>3" class="all link" @click="allMaterials=!allMaterials">{{allMaterials?'收起':'查看全部材料（'+materials.materials.length+'）'}} →</button>
    </section><section class="panel"><h2>让评价有据可依</h2><ul><li>围绕指标描述具体事实。</li><li>结合成果与协作中的实际表现。</li><li>请根据本周期规则填写评分理由。</li></ul></section></aside>
    <main class="form-column"><section class="panel"><h2>评价指标（百分制）</h2><p>各指标满分 100 分，按对应权重计算综合分。</p>
     <p v-if="form.detailsUnavailable">历史评分明细暂不可用。</p><p v-if="!form.items.length">当前模板暂无可用指标。</p>
     <article v-for="(item,index) in form.items" :key="item.id" class="dimension"><div class="dimension-head"><div class="identity"><span class="number">{{index+1}}</span><div><h3>{{item.label}} <span class="weight">权重 {{item.weight}}%</span></h3><p>{{item.description}}</p></div></div><ScoreInput v-if="!form.detailsUnavailable" v-model="item.scoreText" :id="'score-'+item.id" :label="item.label" :disabled="readOnly||busy" @invalid="invalid[item.id]=$event"/></div><label :for="'reason-'+item.id">评价依据与具体表现 <small>{{reasonTag(item)}}</small></label><textarea :id="'reason-'+item.id" v-model="item.reason" :aria-required="!readOnly&&reasonRequired(item)" :aria-invalid="!readOnly&&!!reasonHint(item)" :aria-describedby="'reason-error-'+item.id" :disabled="readOnly||busy" rows="2" :placeholder="item.placeholder"/><small class="count">{{(form.reasonRules?.mode==='prd'?meaningfulTextLength(item.reason):codePointLength(item.reason))}}{{!readOnly&&reasonRequired(item)?' / '+(form.reasonRules?.minChars??30):''}} 字</small><p v-if="!readOnly&&reasonHint(item)" :id="'reason-error-'+item.id" class="reason-error">{{reasonHint(item)}}</p></article>
    </section><section class="panel"><label for="overall">整体评价 <small>{{overallRequired?`必填 · 至少 ${overallRequired} 个有效文字或数字`:`选填`}}</small></label><textarea id="overall" v-model="form.overallReason" :disabled="readOnly||busy" rows="3" placeholder="概括本月表现、主要贡献与成长建议"/><label class="confirm"><input v-model="form.readConfirmed" type="checkbox" :disabled="readOnly||busy"/>我已阅读评价规范，并确认评价内容真实</label></section></main>
    <aside class="guide panel"><h2>评分说明</h2><h3>评分范围</h3><ul><li>各指标满分 100 分。</li><li>支持 0–100 整数分。</li><li><b>{{freeRange.min}}—{{freeRange.max}} 分</b>为常态区间，评分理由可不填。</li><li>低于 {{freeRange.min}} 分或高于 {{freeRange.max}} 分，须填写至少 {{form.reasonRules?.minChars??30}} 字理由说明原因。</li><li>结合实际表现客观评分。</li></ul><h3>权重说明</h3><ul><li v-for="item in form.items" :key="item.id">{{item.label}} <b>{{item.weight}}%</b></li></ul><p>综合分按各项得分与权重加权计算。</p><h3>填写建议</h3><ul><li>结合本月具体工作事实。</li><li>尽量使用可验证的成果或案例。</li><li>避免只写“良好”“一般”等结论。</li><li>需要时说明原因与改进方向。</li></ul></aside>
   </div>
   <div class="action-bar"><div><b>评价总分</b><small>{{total===null?'已评 '+scoredCount+' / '+form.items.length+' 项':'按指标权重自动计算（满分 100 分）'}}</small></div><strong>{{total===null?'未完成':total.toFixed(2)}} <small v-if="total!==null">/ 100</small></strong><div class="actions"><button class="btn" :disabled="readOnly||busy" @click="act()">保存草稿</button><button class="btn btn-primary" :disabled="readOnly||busy" :title="blockers.length?blockers.join('；'):''" @click="act(true)">{{busy?'处理中…':canRevise?'提交修订版':'提交评价'}}</button></div><p v-if="message" role="status">{{message}}</p><p v-else-if="!readOnly&&!busy&&blockers.length" class="blockers">还差：{{blockers.join('；')}}</p></div>
   <MaterialPreviewDrawer v-if="selected" :key="selected.id" :review-id="form.id" :file="selected" @close="selected=null"/>
  </template>
 </div>
</template>
<style scoped>
.evaluation-page{color:#172b4d;--blue:#246bfd}.back,.link{color:#42628e;text-decoration:none}.link{background:none;border:0;cursor:pointer;font:inherit;color:var(--blue)}header{display:flex;align-items:center;justify-content:space-between;margin:20px 0}h1{font-size:28px;margin:4px 0}h2{font-size:17px;margin:0 0 12px}h3{font-size:14px;margin:0 0 6px}p{color:#667085;font-size:13px;line-height:1.7;margin:8px 0}.blue{color:var(--blue)}.badge,.weight{background:#eef4ff;color:var(--blue);padding:3px 7px;border-radius:4px;font-size:12px}.panel{padding:20px;border:1px solid #e5eaf2;border-radius:10px;background:#fff;box-shadow:0 2px 6px #172b4d03;min-width:0;margin-bottom:14px}.columns{display:grid;grid-template-columns:minmax(200px,1fr) minmax(0,2.15fr) minmax(200px,.95fr);gap:14px;align-items:start}.form-column{min-width:0}.dimension{padding:20px 0 10px;border-top:1px solid #e5eaf2}.dimension-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;margin-bottom:14px}.identity{display:flex;gap:10px;min-width:0}.number{display:grid;place-items:center;width:40px;height:40px;flex:none;border-radius:50%;background:#eef4ff;color:var(--blue);font-size:22px}.weight{display:inline-block;font-size:11px;font-weight:400}.dimension-head p{margin:4px 0}.dimension label,label[for=overall]{display:block;font-size:13px;margin-bottom:7px}label small,.count{color:#8492a8;font-size:11px}.count{display:block;text-align:right}textarea{display:block;box-sizing:border-box;width:100%;resize:vertical;padding:10px 12px;border:1px solid #e5eaf2;border-radius:6px;font:inherit;font-size:13px;line-height:1.65;background:#fff}textarea:focus{outline:2px solid #c7d9ff;border-color:var(--blue)}textarea:disabled{background:#fafbfd;color:#667085}ul{padding-left:18px;color:#667085;font-size:13px;line-height:1.9}.guide h3{margin-top:24px}.guide li b{float:right;margin-left:8px}.file{display:flex;gap:10px;align-items:center;width:100%;padding:15px 0;border:0;background:none;text-align:left;cursor:pointer;color:#172b4d}.file>span:nth-child(2){flex:1;min-width:0}.file b{overflow-wrap:anywhere;font-size:13px}.file small{display:block;color:#667085;font-size:11px;margin-top:4px}.file-icon{font-size:10px;display:grid;place-items:center;flex:none;width:34px;height:40px;background:#eef4ff;color:var(--blue);border-radius:5px}.all{width:100%;padding:10px;background:#f5f8ff}.confirm{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px}.confirm input{width:auto}.action-bar{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:20px;flex-wrap:wrap;background:#fff;padding:16px 20px;border:1px solid #e5eaf2;border-radius:10px;box-shadow:0 -4px 20px #172b4d08}.action-bar>div:first-child{flex:1}.action-bar small{display:block;color:#667085;font-size:12px}.action-bar strong{font-size:28px}.action-bar strong small{display:inline;font-weight:400}.actions{display:flex;gap:10px}.action-bar p{width:100%;margin:0}.file:hover{background:#f7f9fc}@media(min-width:1500px){.columns{gap:18px}}@media(max-width:1150px){.columns{grid-template-columns:minmax(190px,.85fr) minmax(0,2fr)}.guide{grid-column:1/-1}}@media(max-width:760px){.columns{display:flex;flex-direction:column}.columns>*{width:100%;box-sizing:border-box}.dimension-head{flex-wrap:wrap}.panel{padding:16px}.action-bar{position:static}.actions{width:100%}.actions .btn{flex:1}h1{font-size:24px}header{gap:12px}}
</style>

<style scoped>
.reason-error{color:#c2413b;font-size:12px;margin:5px 0}textarea[aria-invalid=true]{border-color:#dc8a84}
.blockers{width:100%;margin:0;color:#b45309;font-size:12px;line-height:1.6}
</style>




