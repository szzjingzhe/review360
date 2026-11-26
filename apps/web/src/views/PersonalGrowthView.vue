<script setup lang="ts">
import {computed,onMounted,ref} from 'vue';
import {managementRequest} from '../api/management';
const reports=ref<any[]>([]),selected=ref(''),loading=ref(false),error=ref(''),exporting=ref(false),exportError=ref('');
const current=computed(()=>reports.value.find(r=>r.id===selected.value)),content=computed(()=>current.value?.content);
const keywords=computed(()=>[...(content.value?.keywords??[])].sort((a,b)=>b.count-a.count));
const maxMentions=computed(()=>Math.max(1,...keywords.value.map(k=>k.count)));
const history=computed(()=>[...(current.value?.history??[]).map((h:any)=>({id:h.cycle,month:h.cycle,content:{overall_summary:h.summary}})),...(content.value?[current.value]:[])]);
function items(v:any):{text:string}[]{return Array.isArray(v)?v:typeof v==='string'?[{text:v}]:[];}
const details=computed(()=>[
 {title:'个人优势',hint:'来自材料与反馈的积极表现',items:items(content.value?.strengths)},
 {title:'待提升方面',hint:'客观回顾可以改善的环节',items:items(content.value?.improvements??content.value?.weaknesses)},
 {title:'成长建议',hint:'将反馈转化为具体的改进方法',items:items(content.value?.growth_suggestions??content.value?.suggestions)},
 {title:'下月行动计划',hint:'仅供成长参考，不自动创建任务',items:items(content.value?.action_plan??content.value?.directions)},
]);
async function load(){loading.value=true;error.value='';try{reports.value=await managementRequest('me/growth-analyses');if(!reports.value.some(r=>r.id===selected.value))selected.value=reports.value[0]?.id??'';}catch{error.value='成长报告加载失败，请检查网络后重试。';}finally{loading.value=false;}}
async function exportReport(){const r=current.value;if(!r?.content||exporting.value)return;exporting.value=true;exportError.value='';try{
 const response=await fetch(`/api/v1/me/growth-analyses/${r.id}/reports/${r.analysisId}/pdf`,{credentials:'include'});if(!response.ok)throw new Error();
 const blob=await response.blob();if(!blob.type.includes('application/pdf'))throw new Error();const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`我的成长报告-${r.month}-v${r.version}.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch{exportError.value='导出失败，报告可能已更新或服务暂不可用，请刷新后重试。';}finally{exporting.value=false;}}
onMounted(load);
</script>
<template>
 <div class="growth personal-standard">
  <header class="page-heading"><div><h1>我的成长报告</h1><p>基于月度成果、自评与多维评价反馈，帮助你了解自身优势与改进方向。</p></div><div class="controls">
   <select v-model="selected" :disabled="loading||!reports.length||exporting" aria-label="评价周期与发布版本"><option v-if="!reports.length" value="">暂无已发布周期</option><option v-for="r in reports" :key="r.id" :value="r.id">{{r.month}} · 发布版本 {{r.version}}{{r.superseded?'（历史版本）':''}}</option></select>
   <button class="btn btn-primary" :disabled="!content||exporting||loading" @click="exportReport">{{exporting?'正在导出…':'导出成长报告'}}</button></div></header>
  <p v-if="exportError" class="notice" role="alert">{{exportError}}</p>
  <section v-if="loading" class="report-card empty" role="status">正在加载成长报告…</section>
  <section v-else-if="error" class="report-card empty" role="alert"><p>{{error}}</p><button class="btn" @click="load">重新加载</button></section>
  <section v-else-if="!current" class="report-card empty"><h2>暂无已发布的成长报告</h2><p>评价结果发布并完成报告核对后，可在这里查看。</p></section>
  <template v-else>
   <section class="report-card portrait"><div class="section-heading"><div><span class="eyebrow">{{current.month}} · 月度成长回顾</span><h2>AI成长画像</h2></div><span class="status">{{content?'已确认':'待处理'}}</span></div>
    <p v-if="current.superseded" class="notice">此报告属于历史发布版本，请留意当前选择的周期与版本。</p>
    <p v-if="!content" class="empty-copy">{{current.insufficient?'本版本可用文字材料不足，暂不能形成可靠的成长分析。':current.status==='FAILED'?'本版本报告生成失败，等待管理员重试；不会展示未经核对的内容。':'本版本报告尚未生成或完成核对，暂不展示分析结论。'}}</p>
    <template v-else><p class="summary">{{content.overall_summary??'此历史报告未生成综合画像，以下保留已确认的成长反馈。'}}</p><div class="report-meta">基于已发布材料 · 人工核对后展示 · 报告版本 {{current.reportVersion}}</div></template>
   </section>
   <template v-if="content">
    <div class="analysis-grid">
     <section class="report-card"><h2>能力特征画像</h2><p class="caption">按本期正式模板定性解读</p><div v-if="content.capability_features?.length" class="features"><div v-for="f in content.capability_features" :key="f.dimension"><h3>{{f.dimension}}</h3><p>{{f.text}}</p></div></div><p v-else class="small-empty">此历史报告未生成维度分析。</p></section>
     <section class="report-card"><h2>评价关键词分布</h2><p class="caption">本期允许使用的文字中的实际提及次数</p><div v-if="keywords.length" class="keyword-chart" role="img" aria-label="文字关键词提及次数，不代表能力成绩"><div v-for="k in keywords" :key="k.word" class="keyword"><div><span>{{k.word}}</span><span>{{k.count}} 次</span></div><div class="track"><span :style="{width:(k.count/maxMentions*100)+'%'}"></span></div></div></div><p v-else class="small-empty">暂无可核验的关键词统计。</p></section>
     <section class="report-card"><h2>个人成长特征</h2><p class="caption">AI依据文字证据归纳，经人工核对</p><div v-if="content.traits?.length" class="traits"><span v-for="t in content.traits" :key="t.text">{{t.text}}</span></div><p v-else class="small-empty">此历史报告未生成成长标签。</p><p class="chart-note">特征用于理解反馈，不表示能力等级或评价排序。</p></section>
    </div>
    <section class="report-card"><h2>历史成长趋势</h2><p class="caption">仅回顾本人已发布且已确认的历史报告</p><div v-if="history.length>=2" class="trend"><ol><li v-for="r in history" :key="r.id"><span>{{r.month}}</span><p>{{r.content.overall_summary??'本周期已有已确认成长反馈，可切换周期查看详情。'}}</p></li></ol><aside><h3>AI趋势解读</h3><p>{{content.trend_summary??'当前报告未生成历史趋势解读。'}}</p></aside></div><div v-else class="small-empty">积累两个有效周期后，可在这里回顾成长主题的变化。</div></section>
    <div class="detail-grid"><section v-for="d in details" :key="d.title" class="report-card"><h2>{{d.title}}</h2><p class="caption">{{d.hint}}</p><ol><li v-for="(item,index) in d.items" :key="index">{{item.text}}</li></ol></section></div>
   </template>
  </template>
  <footer>数据范围：本人自评、提交时的材料版本备注、经核对的匿名反馈及已确认历史报告；不读取月报原文件或云文档。AI分析仅供成长参考，不展示数值成绩或评价者身份。</footer>
 </div>
</template>
<style scoped>
.growth{color:#172b4d;min-width:0}.page-heading{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:24px}h1{font-size:28px;margin:0 0 8px;line-height:1.4}h2{font-size:18px;margin:0 0 8px;line-height:1.5}h3{font-size:14px;margin:0 0 6px}p{color:#66758b;line-height:1.85;margin:0;overflow-wrap:anywhere}.controls{display:flex;gap:10px;flex-wrap:wrap;flex-shrink:0;max-width:100%}select{max-width:100%;min-height:38px;border:1px solid #dce4ef;border-radius:8px;background:white;padding:6px 12px;font:inherit;color:inherit}.report-card{padding:24px;background:#fff;border:1px solid #e1e8f2;border-radius:12px;margin-bottom:20px;min-width:0;box-shadow:0 2px 5px #172b4d03}.section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.eyebrow,.report-meta,.caption{font-size:12px;color:#7b899c}.eyebrow{display:block;margin-bottom:8px}.portrait{border-top:3px solid #3472ee}.summary{font-size:15px;line-height:2;margin:12px 0 18px;color:#344660}.status{font-size:12px;color:#267859;background:#edf8f2;padding:5px 12px;border-radius:6px;white-space:nowrap}.notice{padding:10px 14px;border-radius:6px;background:#fff7e8;color:#856326;margin:12px 0}.analysis-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 20px}.features{margin-top:20px}.features>div{padding:12px 0;border-bottom:1px solid #edf1f7}.features>div:last-child{border:0}.features p{font-size:13px}.keyword-chart{margin-top:26px}.keyword{margin:0 0 20px}.keyword>div:first-child{display:flex;justify-content:space-between;font-size:13px;gap:12px;margin-bottom:8px}.track{height:8px;background:#f0f4fa;border-radius:4px;overflow:hidden}.track span{display:block;height:100%;background:#5a8def;border-radius:4px}.traits{display:flex;flex-wrap:wrap;gap:10px;margin:26px 0}.traits span{font-size:13px;color:#3563a6;padding:8px 12px;border:1px solid #dce8fa;background:#f6f9ff;border-radius:6px;overflow-wrap:anywhere}.chart-note{font-size:12px;margin-top:24px}.trend{display:grid;grid-template-columns:1.3fr 1fr;gap:32px;margin-top:24px}.trend ol{margin:0 0 0 8px;padding-left:20px;border-left:2px solid #dce7f9;list-style:none}.trend li{position:relative;padding:0 0 24px 6px}.trend li:before{content:'';position:absolute;left:-27px;top:6px;width:10px;height:10px;background:#5a8def;border-radius:50%;border:2px solid #fff}.trend li>span{font-size:13px;font-weight:600;color:#3563a6}.trend p{font-size:13px;margin-top:6px}.trend aside{background:#f7f9fd;padding:20px;border-radius:8px;align-self:start}.detail-grid ol{padding-left:20px;margin-bottom:0}.detail-grid li{font-size:14px;line-height:1.9;padding:5px 0;color:#475a73;overflow-wrap:anywhere}.empty{text-align:center;padding:60px 24px}.empty button{margin-top:18px}.small-empty{padding:40px 0;text-align:center;font-size:13px;color:#8794a7}.empty-copy{padding:20px 0}footer{font-size:12px;color:#8290a5;line-height:1.8;padding-bottom:18px}@media(max-width:1200px){.page-heading{flex-direction:column}.analysis-grid{grid-template-columns:1fr 1fr}.analysis-grid>.report-card:last-child{grid-column:1/-1}}@media(max-width:760px){.analysis-grid,.detail-grid,.trend{grid-template-columns:1fr}.report-card{padding:20px}.controls{width:100%}.controls select{flex:1;min-width:0}.analysis-grid{gap:0}.page-heading h1{font-size:24px}}
</style>
