const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function growthPdfHtml(report:any,name:string,history:any[]) {
  const c=report.content;
  const list=(items:any)=>Array.isArray(items)?'<ul>'+items.map(x=>'<li>'+esc(x.text)+'</li>').join('')+'</ul>':'<p>'+esc(items)+'</p>';
  const section=(title:string,body:string)=>'<section><h2>'+esc(title)+'</h2>'+body+'</section>';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>我的成长报告</title><style>
  @page{size:A4;margin:18mm}body{font-family:'Noto Sans CJK SC','Microsoft YaHei',sans-serif;color:#172b4d;font-size:10.5pt;line-height:1.5}h1{font-size:24pt;color:#245fe5;margin:0 0 12pt}h2{font-size:14pt;color:#245fe5;border-bottom:1px solid #dce6f3;padding-bottom:5pt;margin:12pt 0 8pt}section{margin:12pt 0}p{margin:6pt 0}li{margin-bottom:5pt}p,li{orphans:3;widows:3}h2{page-break-after:avoid}.meta{color:#697a91}.bar{background:#dbe8ff;padding:4pt 8pt;margin:5pt 0}footer{font-size:9pt;color:#697a91;margin-top:12pt}</style></head><body>
  <h1>我的成长报告</h1><p class="meta">${esc(name)} · ${esc(report.month)} · 发布版本 ${esc(report.version)} · 报告版本 ${esc(report.reportVersion)}</p>
  ${section('AI成长画像','<p>'+esc(c.overall_summary??'此历史报告未生成综合画像，以下保留已确认内容。')+'</p>')}
  ${section('能力特征画像',(c.capability_features??[]).map((x:any)=>'<p><b>'+esc(x.dimension)+'</b> · '+esc(x.text)+'</p>').join('')||'<p>此历史报告未生成能力特征画像。</p>')}
  ${section('评价关键词分布',(c.keywords??[]).map((x:any)=>{const width=Math.max(1,Math.round(x.count/Math.max(...c.keywords.map((k:any)=>k.count))*90));return '<p>'+esc(x.word)+' · '+esc(x.count)+' 次</p><table width="100%" cellpadding="3" cellspacing="0"><tr><td width="'+width+'%" bgcolor="#8FB3FA" style="background-color:#8FB3FA;font-size:3pt">&nbsp;</td><td width="'+(100-width)+'%" bgcolor="#F0F4FA" style="background-color:#F0F4FA;font-size:3pt">&nbsp;</td></tr></table>';}).join('')||'<p>暂无可核验关键词统计。</p>')}
  ${section('个人成长特征',list(c.traits??[]))}
  ${section('历史成长趋势',history.length<2?'<p>不足两个有效周期，暂不形成趋势判断。</p>':history.map(x=>'<p><b>'+esc(x.month)+'</b> · '+esc(x.month===report.month?'本期成长画像见报告开篇。':x.content.overall_summary??'历史已确认报告')+'</p>').join('')+'<p>'+esc(c.trend_summary)+'</p>')}
  ${section('个人优势',list(c.strengths))}${section('待提升方面',list(c.improvements??c.weaknesses))}
  ${section('成长建议',list(c.growth_suggestions??c.suggestions))}${section('下月行动计划',list(c.action_plan??c.directions))}
  <footer>数据范围：本次正式发布版本关联的本人自评、材料版本备注、经核对的匿名反馈及已确认历史报告；未读取月报原文件或云文档。关键词为本期文字中的实际提及次数，不代表能力或评价成绩。AI分析经人工核对，仅供个人成长参考，行动建议不会自动创建任务。不展示数值成绩及评价者身份。</footer></body></html>`;
}
