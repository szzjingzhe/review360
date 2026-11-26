<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref} from 'vue';
import {mockApi} from '../api';
import ReportDimensionsChart from '../components/ReportDimensionsChart.vue';
import {latestReports,comparableDimensions,formatReportScore,type GrowthReport} from '../lib/growthReport';
const reports=ref<GrowthReport[]>([]),selectedId=ref(''),loading=ref(true),error=ref(''),printing=ref(false);
let sequence=0;
const current=computed(()=>reports.value.find(r=>r.id===selectedId.value));
const comparable=computed(()=>!!current.value&&comparableDimensions(current.value.peers,current.value.self));
const peerRows=computed(()=>current.value?.peers.map((i,index)=>({key:i.key??'peer-'+index,label:i.label,weight:i.weight,peer:i.score,self:comparable.value?current.value!.self.find(s=>s.key===i.key)?.score??null:null}))??[]);
const selfRows=computed(()=>current.value?.self.map((i,index)=>({key:i.key??'self-'+index,label:i.label,weight:i.weight,peer:null,self:i.score}))??[]);
const formulaText=computed(()=>current.value?.formula==='self30_peer70_same_group@v1.0-m5'?'按本周期正式规则：自评 30% ＋ 他评 70%':'按本周期已发布规则计算');
function date(value:string){if(!value)return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleDateString('zh-CN');}
const period=computed(()=>current.value?(date(current.value.openAt)&&date(current.value.closeAt)?date(current.value.openAt)+' — '+date(current.value.closeAt):'周期日期暂未提供'):'');
async function load(){const seq=++sequence;loading.value=true;error.value='';try{const rows=await mockApi.getMyGrowthReports();if(seq!==sequence)return;reports.value=latestReports(rows);if(!reports.value.some(r=>r.id===selectedId.value))selectedId.value=reports.value[0]?.id??'';}catch{if(seq===sequence){reports.value=[];selectedId.value='';error.value='成长报告暂时加载失败，请稍后重试。';}}finally{if(seq===sequence)loading.value=false;}}
function exportReport(){if(!current.value||printing.value||loading.value)return;printing.value=true;try{window.print();}finally{printing.value=false;}}
onMounted(()=>void load());onUnmounted(()=>sequence++);
</script>
<template>
 <div class="growth-report personal-standard">
  <header class="report-heading"><div><h1>我的成长报告</h1><p>已发布结果可查看，进行中的月评不会提前公开。</p></div><div class="report-controls no-print"><label><span class="sr-only">评价周期，仅展示本人已发布结果</span><select v-model="selectedId" :disabled="loading||!reports.length||printing"><option v-if="!reports.length" value="">暂无已发布周期</option><option v-for="report in reports" :key="report.id" :value="report.id">{{report.month}} 环评</option></select><small v-if="current">{{period}}</small></label><button class="btn export-button" :disabled="!current||loading||printing" title="打印当前报告或另存为PDF" @click="exportReport"><span aria-hidden="true">↧</span> {{printing?'正在准备…':'导出报告'}}</button></div></header>
  <section v-if="loading" class="report-panel empty-state" role="status">正在加载已发布的成长报告…</section>
  <section v-else-if="error" class="report-panel empty-state" role="alert"><h2>报告暂不可用</h2><p>{{error}}</p><button class="btn" @click="load">重新加载</button></section>
  <section v-else-if="!current" class="report-panel empty-state"><h2>暂无已发布的成长报告</h2><p>结果正式发布后，会在这里展示。进行中的评价结果不会提前公开。</p></section>
  <template v-else>
   <p v-if="current.simulationNotice" class="simulation-notice">{{current.simulationNotice}}</p>
   <section class="report-panel overview" aria-labelledby="overview-title"><div class="overview-content"><div class="report-name"><h2 id="overview-title">{{current.month}} · 个人月度评价报告</h2><span class="published">已发布</span><small>v{{current.version}}</small></div><div class="overview-columns"><div class="score-block"><span>综合得分</span><div class="published-score"><strong>{{formatReportScore(current.finalScore)}}</strong><span>/ 100</span></div><p>{{formulaText}}</p></div><div class="summary-block"><span>本月整体评价</span><h3>暂无已发布整体评价</h3><p>当前报告暂未提供成长反馈摘要，可结合下方维度数据回顾本月表现。</p></div></div></div>
   </section>
   <section class="report-panel analysis" aria-labelledby="analysis-title"><div class="analysis-heading"><div><h2 id="analysis-title">评价维度分析</h2><p>{{comparable?'对照匿名他评与我的自评，了解自身优势与待提升方向。':'自评与他评指标不同，分别展示，不作逐项对比。'}} 缺失分数以“—”显示。</p></div><div class="legend"><span><i class="peer-dot"></i>匿名他评</span><span><i class="self-dot"></i>我的自评</span></div></div>
    <ReportDimensionsChart v-if="comparable" title="自评与匿名他评维度对照" :rows="peerRows" peer self/>
    <div v-else class="separate-charts"><section><h3>匿名他评维度</h3><ReportDimensionsChart v-if="peerRows.length" title="匿名他评维度" :rows="peerRows" peer/><p v-else class="chart-empty">本周期暂无可展示的匿名他评维度数据。</p></section><section><h3>我的自评维度</h3><ReportDimensionsChart v-if="selfRows.length" title="我的自评维度" :rows="selfRows" self/><p v-else class="chart-empty">本周期暂无已发布的自评维度数据。</p></section></div>
   </section>
   <div class="feedback-grid"><section class="report-panel feedback-card strengths-card"><h2><span class="feedback-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 10H4v10h3V10Zm3 10h7a2 2 0 0 0 2-1.6l1-6A2 2 0 0 0 18 10h-5l1-5a2 2 0 0 0-2-2l-3 7v9a1 1 0 0 0 1 1Z"/></svg></span>优势反馈 · 匿名汇总</h2><p>本周期暂无已发布的优势反馈。</p></section><section class="report-panel feedback-card improvements-card"><h2><span class="feedback-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M9 17h6m-6 3h6m-5 2h4M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z"/></svg></span>改进建议 · 匿名汇总</h2><p>本周期暂无已发布的改进建议。</p></section></div>
   <p class="privacy-note"><span aria-hidden="true">ⓘ</span> 以上内容为本月匿名评价的汇总结果，仅用于个人成长参考，不展示评价人名单或来源评分。</p>
  </template>
 </div>
</template>
<style scoped>
.growth-report{color:#172b4d;--report-blue:#246bfd}.report-heading{display:flex;justify-content:space-between;align-items:center;gap:22px;margin-bottom:20px}.report-heading h1{font-size:28px;line-height:1.3;margin:0 0 7px;font-weight:700}.report-heading p,.report-panel p{color:#667085;font-size:13px;line-height:1.75;margin:0}.report-controls{display:flex;align-items:stretch;gap:12px;flex:none}.report-controls label{min-width:230px;padding:8px 12px;border:1px solid #e5eaf2;border-radius:8px;background:#fff}.report-controls select{display:block;width:100%;border:0;padding:0;min-height:25px;color:#172b4d;background:#fff;font:inherit;font-size:14px;cursor:pointer}.report-controls select:focus-visible{outline:2px solid #a9c9ff}.report-controls small{display:block;color:#8492a8;font-size:11px;margin-top:3px}.export-button{background:#fff;border-color:#e5eaf2;padding:10px 18px;white-space:nowrap}.export-button span{font-size:20px;margin-right:5px}.report-panel{padding:24px;border:1px solid #e5eaf2;border-radius:10px;background:#fff;box-shadow:0 2px 8px #172b4d03;margin-bottom:16px;min-width:0;box-sizing:border-box}.report-panel h2{font-size:17px;line-height:1.5;margin:0 0 7px}.overview{display:flex;align-items:center;gap:25px;min-height:205px}.overview-content{flex:1;min-width:0}.report-name{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:20px}.report-name h2{margin:0}.report-name small{font-size:11px;color:#8492a8}.published{font-size:12px;background:#ecfdf3;color:#12805c;padding:2px 7px;border-radius:4px}.overview-columns{display:grid;grid-template-columns:minmax(220px,.85fr) minmax(0,1.3fr);gap:28px}.score-block>span,.summary-block>span{color:#667085;font-size:13px}.published-score{display:flex;gap:10px;align-items:baseline;margin:6px 0}.published-score strong{font-size:42px;font-weight:700;line-height:1.2;color:var(--report-blue);font-variant-numeric:tabular-nums}.published-score>span{color:#8492a8;font-size:16px}.score-block p{font-size:12px}.summary-block{border-left:1px solid #e5eaf2;padding-left:28px}.summary-block h3{font-size:17px;margin:9px 0 6px}.analysis-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:14px}.legend{display:flex;gap:16px;flex-wrap:wrap;color:#667085;font-size:12px;flex:none}.legend span{display:flex;gap:7px;align-items:center}.legend i{width:10px;height:10px;border-radius:50%;display:inline-block}.peer-dot{background:#246bfd}.self-dot{background:#a9c9ff}.separate-charts{display:grid;grid-template-columns:1fr 1fr;gap:24px}.separate-charts>section{min-width:0}.separate-charts>section+section{border-left:1px solid #e5eaf2;padding-left:24px}.separate-charts h3{color:#667085;font-size:13px;font-weight:500;margin:0 0 8px}.chart-empty{display:grid;place-content:center;min-height:200px;text-align:center}.feedback-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.feedback-card{min-height:118px}.feedback-card h2{color:#246bfd}.feedback-card p{margin-top:13px;padding:10px 12px;background:#f7f9fc;border-radius:6px}.privacy-note{display:flex;align-items:flex-start;gap:8px;border:1px solid #dce8ff;background:#eef5ff;color:#667b99;font-size:12px;padding:9px 12px;border-radius:6px;line-height:1.7;margin:0}.privacy-note>span{color:#246bfd}.simulation-notice{padding:10px 12px;border:1px solid #dce8ff;border-radius:6px;background:#f5f8ff;color:#667085;font-size:12px;margin:0 0 14px}.empty-state{padding:60px 24px;text-align:center}.empty-state .btn{margin-top:18px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@media(min-width:1600px){.report-panel{padding:26px 30px}}@media(max-width:1150px){.report-heading{align-items:flex-start}.report-controls label{min-width:190px}.overview-columns{grid-template-columns:1fr 1.1fr;gap:20px}.summary-block{padding-left:20px}.analysis-heading{flex-direction:column;gap:10px}}@media(max-width:760px){.report-heading{flex-direction:column;gap:16px}.report-controls{width:100%;flex-wrap:wrap}.report-controls label{flex:1;min-width:150px}.report-panel{padding:18px}.overview-columns{grid-template-columns:1fr}.summary-block{border-left:0;border-top:1px solid #e5eaf2;padding:16px 0 0}.separate-charts,.feedback-grid{grid-template-columns:1fr}.separate-charts>section+section{border-left:0;border-top:1px solid #e5eaf2;padding:16px 0 0}.report-heading h1{font-size:25px}.published-score strong{font-size:38px}}

/* Local decorative assets; data bindings and the shared page background stay unchanged. */
.overview {
 background-color: #f7faff;
 background-image: url('../assets/growth-report/score-growth-blue.png');
 background-repeat: no-repeat;
 background-position: right center;
 background-size: auto 100%;
 border-color: #e0e9f7;
 box-shadow: 0 4px 16px #234b8308;
}
.overview-content { padding-right: 25%; }
.published-score strong { font-size: 48px; letter-spacing: -.025em; }
.summary-block { border-left-color: #d8e4f4; }
.summary-block p { max-width: 440px; }
.analysis-heading p { margin-top: 4px; }
.feedback-grid { align-items: stretch; }
.feedback-card {
 min-height: 156px;
 margin-bottom: 16px;
 background-repeat: no-repeat;
 background-position: center;
 background-size: cover;
 border-color: #e0ede8;
 box-shadow: 0 3px 12px #172b4d05;
}
.strengths-card { background-color: #f1fbf7; background-image: url('../assets/growth-report/strengths-mint-wave.png'); }
.improvements-card { background-color: #fffaf2; background-image: url('../assets/growth-report/improvements-warm-wave.png'); border-color: #f0e6d7; }
.feedback-card h2 { display: flex; align-items: center; gap: 12px; color: #172b4d; }
.feedback-icon { display: grid; place-items: center; flex: 0 0 36px; width: 36px; height: 36px; border-radius: 10px; color: #239776; background: #e0f5ec; }
.feedback-icon svg { width: 23px; height: 23px; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.improvements-card .feedback-icon { color: #cb8b32; background: #fff0d8; }
.feedback-card p { margin-top: 14px; padding: 12px 14px; background: #ffffffb8; border: 1px solid #ffffffa6; border-radius: 8px; color: #536371; }
.improvements-card p { background: #fffdf8c9; }
@media(max-width:1150px) { .overview-content { padding-right: 22%; } .overview-columns { grid-template-columns: minmax(160px,.8fr) minmax(0,1.2fr); } }
@media(max-width:760px) {
 .overview { background-position: right top; background-size: auto 170px; }
 .overview-content { padding-right: 0; }
 .report-name { padding-right: 70px; }
 .published-score strong { font-size: 42px; }
 .overview-columns { grid-template-columns: 1fr; }
 .summary-block { background: #ffffffbd; border-radius: 8px; padding: 14px; }
 .feedback-card { min-height: 140px; }
}
</style>
<style>
@page growthReport {size:A4 portrait;margin:12mm}
@media print{
 body:has(.growth-report){background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
 body:has(.growth-report) .side,body:has(.growth-report) .topbar,body:has(.growth-report) .no-print{display:none!important}
 body:has(.growth-report) .shell,body:has(.growth-report) .main-shell,body:has(.growth-report) .content{display:block!important;margin:0!important;padding:0!important;width:100%!important;max-width:none!important;min-height:0!important;overflow:visible!important}
 .growth-report{page:growthReport}.growth-report .report-panel{box-shadow:none;break-inside:avoid;padding:16px;margin-bottom:12px}.growth-report .report-heading{margin-bottom:12px}.growth-report .feedback-grid,.growth-report .separate-charts{grid-template-columns:1fr 1fr}.growth-report .overview-columns{grid-template-columns:1fr 1.3fr}.growth-report .summary-block{border-top:0;border-left:1px solid #e5eaf2;padding:0 0 0 20px}.growth-report .separate-charts>section+section{border-top:0;border-left:1px solid #e5eaf2;padding:0 0 0 20px}.growth-report .feedback-card{min-height:85px}.growth-report .overview{min-height:170px}
}
</style>
