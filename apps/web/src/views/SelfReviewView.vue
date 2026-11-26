<script setup lang="ts">
import { codePointLength, meaningfulTextLength, requiresItemReason, itemReasonError, reasonFreeRange } from '../lib/itemReasons';

import ScoreInput from '../components/ScoreInput.vue';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { mockApi } from '../api';
import { useAuth } from '../stores/auth';
import { hydrateSelfReview, scoreError, scoreValue, selfDraft, selfTotal, type SelfMetric, type SelfReviewForm } from '../lib/selfReview';

const auth=useAuth();
const cycles=ref<any[]>([]),cycleId=ref(''),review=ref<SelfReviewForm|null>(null);
const loading=ref(true),busy=ref<'save'|'submit'|null>(null),message=ref(''),loadError=ref('');
const messageKind=ref<'success'|'error'>('success'),savedFingerprint=ref(''),badNumber=ref<Record<string,boolean>>({}),now=ref(Date.now());
let loadSequence=0,clock:ReturnType<typeof setInterval>|undefined;
const currentCycle=computed(()=>cycles.value.find(c=>c.id===cycleId.value));
const revisionInfo=ref<{expired:boolean;dueAt:string|null}|null>(null);
const canRevise=computed(()=>!!revisionInfo.value&&!revisionInfo.value.expired);
const readOnly=computed(()=>!!review.value&&review.value.status!=='DRAFT');
const fingerprint=()=>review.value?JSON.stringify({draft:selfDraft(review.value),texts:review.value.items.map(i=>i.scoreText)}):'';
const dirty=computed(()=>!!review.value&&!readOnly.value&&fingerprint()!==savedFingerprint.value);
const inputErrors=computed(()=>review.value?.items.some(i=>!!scoreError(i.scoreText)||badNumber.value[i.id])??false);
const total=computed(()=>review.value?.status==='SUBMITTED'?(Number.isFinite(review.value.scoreBp)&&review.value.scoreBp!==null?review.value.scoreBp/100:null):review.value?selfTotal(review.value.items):null);
const scoredCount=computed(()=>review.value?.items.filter(i=>scoreValue(i.scoreText)!==null&&!badNumber.value[i.id]).length??0);
const periodClosed=computed(()=>{if(canRevise.value)return !!revisionInfo.value?.dueAt&&now.value>new Date(revisionInfo.value.dueAt).getTime();const c=currentCycle.value;return !c||c.status!=='REVIEWING'||!!c.closeAt&&now.value>new Date(c.closeAt).getTime();});
const reasonIssues=computed(()=>readOnly.value?[]:(review.value?.items??[]).filter(i=>!!itemReasonError(scoreValue(i.scoreText),i.reason,review.value?.reasonRules)));
const overallRequired=computed(()=>{const f=review.value,r=f?.reasonRules;if(!f||r?.mode!=='prd')return 0;return total.value!==null&&total.value>=r.highInclusive?(r.overallMinChars??0):0;});
const freeRange=computed(()=>reasonFreeRange(review.value?.reasonRules));
const unscoredNames=computed(()=>(review.value?.items??[]).filter(i=>scoreValue(i.scoreText)===null||badNumber.value[i.id]).map(i=>i.label));
const blockers=computed(()=>{
  if(readOnly.value||!review.value)return [] as string[];
  const list:string[]=[];
  if(inputErrors.value)list.push('有分数输入格式不正确');
  if(unscoredNames.value.length)list.push('还有 '+unscoredNames.value.length+' 项指标未评分（'+unscoredNames.value.join('、')+'）');
  if(reasonIssues.value.length)list.push('还需为 '+reasonIssues.value.map(i=>i.label).join('、')+' 填写评分理由');
  if(overallRequired.value&&meaningfulTextLength(review.value.overallReason)<overallRequired.value)list.push('本月总结至少 '+overallRequired.value+' 字');
  if(!review.value.readConfirmed)list.push('请勾选“我已阅读并确认本周期月报材料版本”');
  return list;
});
function reasonRequired(item:{scoreText:string}){return requiresItemReason(scoreValue(item.scoreText),review.value?.reasonRules);}
function reasonHint(item:{scoreText:string;reason:string}){return itemReasonError(scoreValue(item.scoreText),item.reason,review.value?.reasonRules);}
function reasonTag(item:{scoreText:string}){if(readOnly.value)return '已提交';return reasonRequired(item)?`必填 · 至少 ${review.value?.reasonRules?.minChars??30} 字`:`选填 · ${freeRange.value.min}—${freeRange.value.max} 分可不填`;}
function focusReason(id?:string){const el=document.getElementById('reason-'+(id??reasonIssues.value[0]?.id));el?.scrollIntoView({block:'center',behavior:'smooth'});el?.focus();}
const canSubmit=computed(()=>!!review.value&&!loading.value&&!busy.value&&!readOnly.value&&!periodClosed.value);
const canSave=computed(()=>!!review.value&&!loading.value&&!busy.value&&!readOnly.value&&!inputErrors.value);
const weightTotal=computed(()=>review.value?.items.reduce((s,i)=>s+i.weight,0)??0);
const stateText=computed(()=>loading.value?'加载中':loadError.value?'暂不可用':!review.value?'无自评任务':({DRAFT:'草稿',SUBMITTED:'已提交',WITHDRAWN:'已撤回'}[review.value.status]??review.value.status));
const cycleRange=computed(()=>{const c=currentCycle.value;const a=dateText(c?.openAt),b=dateText(c?.closeAt);return a||b?(a||'未配置开始时间')+' — '+(b||'未配置结束时间'):'';});
const submitHint=computed(()=>readOnly.value?'已提交或已结束的自评不可在此修改。':periodClosed.value?'当前周期不开放提交，已有草稿仍可按原规则保存。':blockers.value.length?'还差：'+blockers.value.join('；'):'信息已完整，可以提交自评。');
const icons={calendar:'M8 3v4m8-4v4M4 10h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1ZM8 14h2m4 0h2m-8 3h2',file:'M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8m-8 4h6',info:'M12 10v7m0-10v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'};
function dateText(value?:string){if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});}
function errorText(e:any){const code=String(e?.code??e?.message??e);const labels:Record<string,string>={NOT_CYCLE_PARTICIPANT:'当前账号不在本周期有效参评名单中。',REVIEW_PERIOD_CLOSED:'当前评价期已结束，无法新建或提交自评。',READ_CONFIRM_REQUIRED:'请先确认已阅读本周期主月报。',REVIEW_ALREADY_SUBMITTED:'该自评已提交，请重新加载查看。',NOT_REVIEW_OWNER:'无权修改这份自评。',TEMPLATE_NOT_FOUND:'当前周期尚未配置可用的自评模板。'};return labels[code]??'请求未完成，请稍后重试。';}
async function initialize(){loading.value=true;loadError.value='';try{cycles.value=await mockApi.listCycles();cycleId.value=cycles.value.find(c=>c.status==='REVIEWING')?.id??cycles.value[0]?.id??'';await loadReview();}catch{loadError.value='周期信息加载失败，请重试。';loading.value=false;}}
async function loadReview(){const seq=++loadSequence,id=cycleId.value;loading.value=true;loadError.value='';message.value='';review.value=null;revisionInfo.value=null;badNumber.value={};savedFingerprint.value='';try{if(!id||!auth.user)return;const data=await mockApi.getSelfReviewPage(id);if(seq!==loadSequence)return;if(data){revisionInfo.value=data.revisionRequest??null;const revising=data.review.status==='SUBMITTED'&&canRevise.value;const source=revising&&data.draft?.rowVersion?{...data,review:{...data.review,status:'DRAFT'}}:revising?{...data,review:{...data.review,status:'DRAFT'},draft:{...data.draft,dataJson:data.latestRevision}}:data;review.value=hydrateSelfReview(source);savedFingerprint.value=fingerprint();}}catch(e){if(seq===loadSequence)loadError.value=errorText(e);}finally{if(seq===loadSequence)loading.value=false;}}
function changeCycle(event:Event){const select=event.target as HTMLSelectElement;if(dirty.value&&!window.confirm('当前自评有未保存的内容，切换周期会丢失这些修改。是否继续？')){select.value=cycleId.value;return;}cycleId.value=select.value;void loadReview();}
function changeScore(item:SelfMetric,event:Event){const input=event.target as HTMLInputElement;item.scoreText=input.value;badNumber.value[item.id]=input.validity.badInput;}
function normalizeScore(item:SelfMetric){const value=scoreValue(item.scoreText);if(value!==null&&!badNumber.value[item.id])item.scoreText=String(value);}
function stepScore(item:SelfMetric,direction:number){if(readOnly.value||busy.value||scoreError(item.scoreText)||badNumber.value[item.id])return;item.scoreText=String(Math.min(100,Math.max(0,(scoreValue(item.scoreText)??0)+direction)));}
async function saveDraft(){if(!review.value||!canSave.value)return;busy.value='save';message.value='';try{await mockApi.saveSelfReviewDraft(review.value.id,selfDraft(review.value));savedFingerprint.value=fingerprint();messageKind.value='success';message.value='自评草稿已保存。';}catch(e){messageKind.value='error';message.value='保存失败：'+errorText(e)+' 当前填写内容已保留。';}finally{busy.value=null;}}
async function submit(){if(!review.value||!canSubmit.value){messageKind.value='error';message.value=periodClosed.value?'当前周期不开放提交。':readOnly.value?'已提交的自评不可重复提交。':'正在处理，请稍候。';return;}if(blockers.value.length){messageKind.value='error';message.value='暂时不能提交：'+blockers.value.join('；')+'。';if(unscoredNames.value.length){const target=review.value.items.find(i=>unscoredNames.value.includes(i.label));document.getElementById('score-'+target?.id)?.scrollIntoView({block:'center',behavior:'smooth'});document.getElementById('score-'+target?.id)?.focus();}else if(reasonIssues.value.length)focusReason();else if(overallRequired.value)document.getElementById('self-summary')?.focus();else document.querySelector('.confirmation-line input')?.scrollIntoView({block:'center',behavior:'smooth'});return;}busy.value='submit';message.value='';try{const form=review.value;await mockApi.saveSelfReviewDraft(form.id,selfDraft(form));savedFingerprint.value=fingerprint();const bp=canRevise.value?await mockApi.submitRevision(form.id):await mockApi.submitReview(form.id);revisionInfo.value=null;form.status='SUBMITTED';form.scoreBp=Number(bp);form.detailsUnavailable=false;messageKind.value='success';message.value='自评已提交，自评总分 '+(Number(bp)/100).toFixed(2)+' 分，不计入最终综合分。';}catch(e){try{const fresh=await mockApi.getSelfReviewPage(cycleId.value);if(fresh?.review.status==='SUBMITTED'&&!fresh.revisionRequest){review.value=hydrateSelfReview(fresh);savedFingerprint.value=fingerprint();messageKind.value='success';message.value='自评已提交，自评总分 '+(Number(review.value.scoreBp)/100).toFixed(2)+' 分，不计入最终综合分。';return;}}catch{/* Do not infer success while the server is unavailable. */}messageKind.value='error';message.value='提交失败：'+((e as any)?.violations?.[0]?.detail??errorText(e))+' 当前填写内容已保留。';if((e as any)?.violations?.[0]?.itemId)focusReason((e as any).violations[0].itemId);}finally{busy.value=null;}}
function beforeUnload(event:BeforeUnloadEvent){if(dirty.value||busy.value){event.preventDefault();event.returnValue='';}}
onBeforeRouteLeave(()=>{if(!auth.user)return true;if(busy.value)return false;return !dirty.value||window.confirm('当前自评有未保存的内容，离开会丢失这些修改。是否继续？');});
onMounted(()=>{void initialize();window.addEventListener('beforeunload',beforeUnload);clock=setInterval(()=>{now.value=Date.now();},30000);});
onUnmounted(()=>{window.removeEventListener('beforeunload',beforeUnload);if(clock)clearInterval(clock);});
</script>

<template>
 <div class="self-workspace personal-standard" :aria-busy="loading||!!busy">
  <header class="self-heading"><div><h1>我的自评</h1><p>自评用于成长对照，不计入最终综合分；请结合本月实际工作情况进行客观评价。</p></div><div class="cycle-picker"><label for="self-cycle" class="sr-only">环评周期</label><select id="self-cycle" :value="cycleId" :disabled="loading||!!busy||!cycles.length" @change="changeCycle"><option v-if="!cycles.length" value="">暂无环评周期</option><option v-for="cycle in cycles" :key="cycle.id" :value="cycle.id">{{cycle.month}} · {{cycle.title}}</option></select></div></header>
  <div v-if="loadError" class="self-notice error" role="alert"><span>{{loadError}}</span><button type="button" @click="cycles.length?loadReview():initialize()">重新加载</button></div>
  <div v-if="message" class="self-notice" :class="messageKind" :role="messageKind==='error'?'alert':'status'">{{message}}</div>
  <section class="self-overview" aria-label="自评概览">
   <article class="overview-card"><span class="self-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="icons.calendar"/></svg></span><div><h2>当前周期</h2><strong>{{currentCycle?.month||'—'}}</strong><p>{{cycleRange||'以实际周期配置为准'}}</p></div></article>
   <article class="overview-card"><span class="self-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="icons.file"/></svg></span><div><h2>自评状态</h2><strong>{{stateText}}</strong><p>{{readOnly?'已提交内容仅供查看':dirty?'有未保存的修改':review?'可先保存草稿，完成后再提交':'按本周期参评名单展示'}}</p></div></article>
   <article class="overview-card explanation-card"><span class="self-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="icons.info"/></svg></span><div><h2>自评说明</h2><strong>用于成长对照</strong><p>自评单独展示，不计入最终综合分。</p></div></article>
  </section>
  <section v-if="loading" class="self-panel empty-state" role="status">正在读取本周期自评…</section>
  <section v-else-if="!review" class="self-panel empty-state"><h2>{{loadError?'自评暂不可用':'暂无自评任务'}}</h2><p>{{loadError?'请重试加载，当前未显示任何评分数据。':currentCycle?'当前身份在所选周期没有可用的自评任务。':'当前暂无可用环评周期。'}}</p></section>
  <div v-else class="self-columns">
   <div class="self-main">
    <section class="self-panel" aria-labelledby="metrics-title">
     <div class="section-heading"><h2 id="metrics-title">指标自评（百分制）</h2><span v-if="!review.detailsUnavailable">已评分 {{scoredCount}} / {{review.items.length}} 项</span></div><p class="section-subtitle">各项满分 100 分，按真实指标权重计算自评总分。</p>
     <div v-if="review.detailsUnavailable" class="detail-notice">自评已提交。当前接口未返回逐项分数与评分依据，以下明细暂不可用；总分及已返回的总结内容仍可查看。</div>
     <div v-if="!review.items.length" class="detail-notice">当前模板没有可用指标，请核对周期配置。</div>
     <article v-for="(item,index) in review.items" :key="item.id" class="metric-card" :data-metric="item.code||item.id">
      <div class="metric-heading"><div class="metric-identity"><span class="metric-number" aria-hidden="true">{{index+1}}</span><div><div class="metric-title"><h3 :id="'metric-'+item.id">{{item.label}}</h3><span class="weight-badge">权重 {{item.weight}}%</span></div><p>{{item.description}}</p></div></div>
       <div class="score-area"><div v-if="review.detailsUnavailable" class="unavailable-score">明细暂不可用</div><ScoreInput v-else :id="'score-'+item.id" v-model="item.scoreText" :label="item.label" :disabled="readOnly||!!busy" @invalid="badNumber[item.id]=$event"/></div>
      </div>
      <p v-if="scoreError(item.scoreText)||badNumber[item.id]" class="field-error" role="alert">{{badNumber[item.id]?'请输入有效的整数分数。':scoreError(item.scoreText)}}</p>
      <div class="reason-heading"><label :for="'reason-'+item.id">评分依据与具体表现 <span>{{reasonTag(item)}}</span></label><small v-if="!review.detailsUnavailable">{{(review.reasonRules?.mode==='prd'?meaningfulTextLength(item.reason):codePointLength(item.reason))}}{{!readOnly&&reasonRequired(item)?' / '+(review.reasonRules?.minChars??30):''}} 字</small></div>
      <textarea :id="'reason-'+item.id" v-model="item.reason" rows="2" :aria-required="!readOnly&&reasonRequired(item)" :aria-invalid="!readOnly&&!!reasonHint(item)" :aria-describedby="'reason-error-'+item.id" :disabled="readOnly||!!busy" :placeholder="review.detailsUnavailable?'接口暂未返回该项已提交的评分依据。':item.placeholder"></textarea><p v-if="!readOnly&&reasonHint(item)" :id="'reason-error-'+item.id" class="field-error">{{reasonHint(item)}}</p>
     </article>
    </section>
    <section class="self-panel report-confirmation" aria-labelledby="report-title"><div class="section-heading"><h2 id="report-title">月报引用确认</h2><RouterLink to="/monthly-report">查看月度成果 ↗</RouterLink></div><p>请先核对本周期主月报，再确认已阅读。提交时由现有后端机制固定材料版本。</p><label class="confirmation-line"><input type="checkbox" v-model="review.readConfirmed" :disabled="readOnly||!!busy"/><span>我已阅读并确认本周期月报材料版本</span></label></section>
    <section class="self-panel reflection-panel" aria-labelledby="reflection-title"><div class="section-heading"><h2 id="reflection-title">本月总结与成长计划</h2><span>以下内容均为选填</span></div>
     <div class="reflection-field"><label for="self-summary">本月总结 <small v-if="overallRequired">必填 · 至少 {{overallRequired}} 个有效文字或数字</small></label><textarea id="self-summary" v-model="review.overallReason" rows="3" :disabled="readOnly||!!busy" placeholder="回顾本月主要工作、成果及目标达成情况。"></textarea></div>
     <div class="reflection-field"><label for="self-reflection">成长反思</label><textarea id="self-reflection" v-model="review.comment" rows="3" :disabled="readOnly||!!busy" placeholder="说明能力成长、遇到的问题，以及准备如何改进。"></textarea></div>
     <div class="reflection-field"><label for="self-plan">下月行动计划</label><textarea id="self-plan" v-model="review.nextPlan" rows="3" :disabled="readOnly||!!busy" placeholder="列出下月重点目标、具体行动与预期结果。"></textarea></div>
    </section>
    <section class="self-panel total-panel" aria-label="自评总分与操作"><div class="total-row"><div><h2>自评总分</h2><p>{{review.status==='SUBMITTED'?'以服务端已提交分数为准':'按当前指标权重自动计算，满分 100 分'}}</p></div><div class="total-value"><strong v-if="total!==null&&!inputErrors">{{total.toFixed(2)}}</strong><strong v-else class="incomplete">{{readOnly?'—':'未完成'}}</strong><span>/ 100</span></div></div><div class="action-row"><p>{{submitHint}}</p><div><button type="button" class="self-button" :disabled="!canSave" @click="saveDraft">{{busy==='save'?'正在保存…':'保存草稿'}}</button><button type="button" class="self-button primary" :disabled="!canSubmit" @click="submit">{{busy==='submit'?'正在提交…':review.status==='SUBMITTED'?'已提交':'提交自评'}}</button></div></div></section>
   </div>
   <aside class="self-panel scoring-guide" aria-labelledby="guide-title"><div class="guide-title"><span class="self-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path :d="icons.info"/></svg></span><h2 id="guide-title">评分说明</h2></div><section><h3>评分范围</h3><p>各项指标满分 100 分，使用整数分。</p><ul><li>0 分与 100 分为评分区间的两端。</li><li><b>{{freeRange.min}}—{{freeRange.max}} 分</b>为常态区间，评分理由可不填。</li><li>低于 {{freeRange.min}} 分或高于 {{freeRange.max}} 分，须填写至少 {{review.reasonRules?.minChars??30}} 字理由说明原因。</li><li>请结合实际工作表现客观评分。</li><li>未评分与 0 分分别记录。</li></ul></section><section><h3>权重说明</h3><ul class="weight-list"><li v-for="item in review.items" :key="item.id"><span>{{item.label}}</span><strong>{{item.weight}}%</strong></li></ul><p class="formula-note">总分 = 各项得分与权重乘积之和 ÷ 权重之和。</p><p v-if="weightTotal!==100" class="formula-note">当前配置权重合计 {{weightTotal}}%，按现有加权平均口径计算。</p></section><section><h3>填写建议</h3><ul><li>结合本月实际工作，尽量使用具体事实。</li><li>避免只写“良好”“一般”等模糊描述。</li><li>说明问题时，可补充原因与改进方向。</li><li>根据本周期规则填写评分理由：常态区间可留空，超出区间必须说明原因。</li></ul></section><section class="example-guide"><h3>示例参考</h3><h4>工作表现</h4><p>按计划完成核心任务，并说明交付结果与质量。</p><h4>改进方向</h4><p>识别沟通或时间管理中的不足，给出具体改进措施。</p><h4>支持需求</h4><p>描述所需指导、资源或协同支持；暂无需求可填写“暂无”。</p></section></aside>
  </div>
 </div>
</template>

<style scoped>
.self-workspace{--self-blue:#246bfd;--self-title:#172b4d;--self-muted:#667085;--self-border:#e5eaf2;display:grid;gap:20px;min-width:0;color:var(--self-title);font-size:14px;}
.self-heading{display:flex;align-items:center;justify-content:space-between;gap:24px;}
.self-heading h1{margin:0 0 10px;font-size:28px;font-weight:650;line-height:1.4;letter-spacing:-.02em;}
.self-heading p{margin:0;max-width:730px;color:var(--self-muted);font-size:14px;line-height:24px;}
.cycle-picker{flex:0 1 295px;min-width:220px;}
.cycle-picker select{width:100%;min-width:0;padding:11px 12px;border:1px solid #d6e0ef;border-radius:7px;background:#fff;color:#405778;font:inherit;font-size:13px;}
.self-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;}
.overview-card{display:flex;align-items:center;gap:14px;min-width:0;padding:20px;border:1px solid var(--self-border);border-radius:11px;background:#fff;box-shadow:0 2px 6px #172b4d05;}
.overview-card>div{min-width:0;}
.overview-card h2{margin:0 0 6px;font-size:13px;font-weight:500;color:var(--self-muted);}
.overview-card strong{font-size:23px;line-height:30px;font-weight:650;}
.overview-card p{margin:6px 0 0;color:var(--self-muted);font-size:12px;line-height:20px;overflow-wrap:anywhere;}
.explanation-card strong{font-size:17px;font-weight:500;}
.self-icon{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:12px;background:#eef4ff;color:var(--self-blue);}
.self-icon svg{width:23px;height:23px;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;}
.self-columns{display:grid;grid-template-columns:minmax(0,7fr) minmax(260px,3fr);align-items:start;gap:20px;}
.self-main{display:grid;gap:18px;min-width:0;}
.self-panel{min-width:0;padding:22px;border:1px solid var(--self-border);border-radius:11px;background:#fff;box-shadow:0 2px 6px #172b4d05;}
.section-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px;}
.self-panel h2{margin:0;font-size:18px;font-weight:600;line-height:27px;}
.section-heading>span{color:#8190a5;font-size:12px;}
.section-subtitle{margin:0 0 18px;color:var(--self-muted);font-size:13px;line-height:22px;}
.metric-card{min-width:0;padding:18px;margin-top:14px;border:1px solid #e8edf5;border-radius:9px;background:#fff;}
.metric-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px;}
.metric-identity{display:flex;align-items:flex-start;gap:11px;min-width:0;}
.metric-identity>div{min-width:0;}
.metric-number{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px;border-radius:9px;background:#f0f5ff;color:#3972d5;font-size:17px;font-weight:600;}
.metric-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px;}
.metric-title h3{margin:0;font-size:15px;line-height:24px;font-weight:600;}
.weight-badge{padding:2px 6px;border-radius:4px;background:#eef4ff;color:#4674bd;font-size:11px;line-height:18px;white-space:nowrap;}
.metric-identity p{margin:5px 0 0;color:#7e8da3;font-size:12px;line-height:21px;overflow-wrap:anywhere;}
.score-area{flex:0 0 232px;text-align:right;}
.score-control{display:flex;align-items:center;height:36px;border:1px solid #dce5f2;border-radius:6px;overflow:hidden;background:#fff;}
.score-control:focus-within{outline:3px solid #c7d9ff;outline-offset:2px;}
.score-control button{flex:0 0 29px;height:100%;padding:0;border:0;background:#f5f8ff;color:var(--self-blue);font-size:19px;cursor:pointer;}
.score-control button:disabled{color:#a8b5c8;background:#f8fafc;cursor:not-allowed;}
.score-control input{width:0;min-width:0;flex:1;padding:0 2px;border:0;outline:0;text-align:center;background:transparent;color:var(--self-title);font:inherit;font-size:14px;font-weight:600;appearance:textfield;-moz-appearance:textfield;}
.score-control input::-webkit-outer-spin-button,.score-control input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.score-control input::placeholder{font-size:11px;font-weight:400;color:#98a4b7;}
.score-control>span{padding-right:7px;color:#8492a8;font-size:12px;}
.score-control input:disabled{color:#72819a;}
.score-control.invalid{border-color:#dc8a84;}
.score-area small{display:block;margin-top:6px;color:#8492a8;font-size:11px;}
.unavailable-score{padding:8px;border:1px solid #e5eaf2;border-radius:6px;color:#98a2b3;background:#f8fafc;font-size:12px;}
.reason-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px;}
.reason-heading label,.reflection-field>label{font-size:13px;font-weight:500;line-height:22px;}
.reason-heading label>span{margin-left:5px;color:#8a97aa;font-size:11px;font-weight:400;}
.reason-heading small{font-size:11px;color:#8a97aa;white-space:nowrap;}
.self-workspace textarea{display:block;width:100%;min-width:0;padding:10px 11px;border:1px solid #e0e6ef;border-radius:6px;background:#fff;color:#344967;font:inherit;font-size:13px;line-height:23px;resize:vertical;}
.self-workspace textarea::placeholder{color:#98a4b7;}
.self-workspace textarea:focus{outline:2px solid #bdd3fc;outline-offset:1px;border-color:#7ca6f0;}
.self-workspace textarea:disabled{background:#fafbfd;color:#687b95;}
.metric-card textarea{min-height:68px;}
.field-error{margin:-3px 0 10px;font-size:12px;color:#bc4841;line-height:21px;}
.report-confirmation p{margin:10px 0 14px;color:var(--self-muted);font-size:13px;line-height:23px;}
.report-confirmation a{font-size:12px;color:var(--self-blue);text-decoration:none;}
.confirmation-line{display:flex;align-items:flex-start;gap:9px;color:#405778;font-size:13px;line-height:23px;cursor:pointer;}
.confirmation-line input{width:16px;height:16px;flex:0 0 16px;margin:3px 0 0;accent-color:var(--self-blue);}
.reflection-field{margin-top:16px;}
.reflection-field>label{display:block;margin-bottom:7px;}
.total-row{display:flex;align-items:center;justify-content:space-between;gap:15px;}
.total-row p{margin:5px 0 0;color:var(--self-muted);font-size:12px;line-height:21px;}
.total-value{display:flex;align-items:baseline;gap:8px;white-space:nowrap;}
.total-value strong{font-size:29px;font-weight:650;font-variant-numeric:tabular-nums;color:#204c91;}
.total-value strong.incomplete{font-size:20px;color:#7d8ca2;}
.total-value>span{font-size:14px;color:#8998ad;}
.action-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;padding-top:18px;margin-top:17px;border-top:1px solid #edf0f5;}
.action-row>p{flex:1;min-width:180px;margin:0;color:#8390a5;font-size:12px;line-height:21px;}
.action-row>div{display:flex;gap:10px;}
.self-button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:8px 15px;border:1px solid #dce4ef;border-radius:6px;background:#fff;color:#405778;font:inherit;font-size:13px;cursor:pointer;}
.self-button.primary{border-color:var(--self-blue);background:var(--self-blue);color:#fff;}
.self-button:hover:not(:disabled){border-color:#adc8fa;color:var(--self-blue);background:#f7faff;}
.self-button.primary:hover:not(:disabled){background:#1b5ee1;color:#fff;}
.self-button:disabled{border-color:#e3e8f0;background:#f4f6fa;color:#a1adbd;cursor:not-allowed;}
.self-workspace button:focus-visible,.self-workspace select:focus-visible,.self-workspace a:focus-visible,.confirmation-line input:focus-visible{outline:3px solid #b0cafb;outline-offset:3px;}
.scoring-guide{padding:20px;}
.guide-title{display:flex;align-items:center;gap:10px;margin-bottom:22px;}
.guide-title .self-icon{flex-basis:32px;width:32px;height:32px;border-radius:9px;}
.guide-title .self-icon svg{width:18px;height:18px;}
.guide-title h2{font-size:17px;}
.scoring-guide section+section{margin-top:24px;}
.scoring-guide h3{margin:0 0 9px;font-size:14px;font-weight:600;line-height:22px;}
.scoring-guide p,.scoring-guide li{color:#71839e;font-size:13px;line-height:24px;overflow-wrap:anywhere;}
.scoring-guide p{margin:0 0 7px;}
.scoring-guide ul{padding-left:18px;margin:0;}
.scoring-guide .weight-list{padding:0;list-style:none;}
.weight-list li{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
.weight-list strong{color:#596f90;font-size:12px;font-weight:500;white-space:nowrap;}
.scoring-guide .formula-note{margin-top:11px;color:#8295b2;font-size:12px;line-height:22px;}
.example-guide{padding:15px;border:1px solid #e7edf9;border-radius:7px;background:#f8faff;}
.example-guide h4{margin:14px 0 3px;color:#5478ae;font-size:12px;font-weight:600;}
.example-guide p{font-size:12px;line-height:22px;}
.detail-notice{margin:14px 0;padding:11px 13px;border:1px solid #dde7f8;border-radius:7px;background:#f6f9ff;color:#6c83a5;font-size:13px;line-height:23px;}
.self-notice{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 16px;border:1px solid #d3e9dc;border-radius:8px;background:#f2faf6;color:#2d8261;font-size:13px;line-height:23px;}
.self-notice.error{border-color:#eed6d1;background:#fff7f5;color:#af4840;}
.self-notice button{padding:0;border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer;}
.empty-state{padding:40px 20px;text-align:center;color:#8493a9;line-height:24px;}
.empty-state h2{font-size:18px;color:#607391;}
.empty-state p{margin:10px 0 0;font-size:13px;}
.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;}
@media(max-width:1250px){.self-columns{grid-template-columns:minmax(0,7fr) minmax(235px,3fr);gap:16px;}.self-panel{padding:18px;}.overview-card{padding:17px 14px;gap:11px;}.overview-card .self-icon{flex-basis:34px;width:34px;height:34px;border-radius:9px;}.metric-card{padding:15px;}.metric-heading{flex-wrap:wrap;}.score-area{margin-left:auto;}.self-heading{gap:16px;}.cycle-picker{flex-basis:250px;}.overview-card strong{font-size:21px;}.explanation-card strong{font-size:16px;}}
@media(max-width:1000px){.self-columns{grid-template-columns:1fr;}.scoring-guide{order:2;}.self-heading{align-items:flex-start;flex-direction:column;gap:15px;}.cycle-picker{flex-basis:auto;width:100%;}.self-overview{gap:12px;}.overview-card{align-items:flex-start;flex-direction:column;}.metric-heading{flex-wrap:nowrap;}}
@media(max-width:620px){.self-workspace{gap:16px;}.self-heading h1{font-size:25px;}.self-overview{grid-template-columns:1fr;}.overview-card{flex-direction:row;align-items:center;padding:16px;}.self-panel{padding:16px;}.metric-heading{flex-wrap:wrap;gap:12px;}.metric-card{padding:14px;}.score-area{margin-left:43px;flex-basis:232px;text-align:left;}.metric-identity{width:100%;}.total-row{align-items:flex-start;flex-direction:column;}.action-row>div{width:100%;justify-content:flex-end;}.self-heading p{font-size:13px;}.metric-title h3{font-size:14px;}}
</style>





