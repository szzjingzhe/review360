export interface ReportDimension { key:string|null; label:string; weight:number|null; position:number; score:number|null }
export interface GrowthReport {id:string;cycleId:string;month:string;version:number;publishedAt:string;openAt:string;closeAt:string;finalScore:number|null;formula:string;simulationNotice:string;peers:ReportDimension[];self:ReportDimension[]}
export function reportScore(value:unknown):number|null {
 if(value===null||value===undefined||(typeof value!=='number'&&typeof value!=='string')||String(value).trim()==='')return null;
 const number=Number(value);return Number.isFinite(number)&&number>=0&&number<=100?number:null;
}
export function growthReport(row:Record<string,any>):GrowthReport {
 const payload=row.payload_json??{},meta=row.display_metadata??{};
 const dimensions=(name:'peer'|'self'):ReportDimension[]=>{
  const data=Array.isArray(payload[name+'_items'])?payload[name+'_items']:[];
  return data.map((item:Record<string,any>,index:number)=>{const m=meta[name==='peer'?'peerItems':'selfItems']?.[index];
   return {key:m?.key??null,label:String(item.label??'未命名指标'),weight:typeof m?.weight==='number'?m.weight:null,position:m?.position??index,score:reportScore(item.avg_score)};
  }).sort((a:ReportDimension,b:ReportDimension)=>a.position-b.position);
 };
 return {id:row.id,cycleId:row.cycle_id??'',month:payload.month??row.month??'',version:Number(row.publication_version??1),publishedAt:row.published_at??'',openAt:meta.cycle?.openAt??'',closeAt:meta.cycle?.closeAt??'',finalScore:reportScore(payload.final_score),formula:payload.formula_version??'',simulationNotice:payload.simulation===true?(typeof payload.simulation_notice==='string'?payload.simulation_notice:'本报告为本地模拟数据，不代表真实评价结果。'):'',peers:dimensions('peer'),self:dimensions('self')};
}
export function latestReports(rows:Record<string,any>[]):GrowthReport[]{
 const latest=new Map<string,GrowthReport>();
 for(const raw of rows){const r=growthReport(raw),key=r.cycleId||'legacy:'+r.month;const old=latest.get(key);if(!old||r.version>old.version||r.version===old.version&&r.publishedAt>old.publishedAt)latest.set(key,r);}
 return [...latest.values()].sort((a,b)=>b.month.localeCompare(a.month)||b.publishedAt.localeCompare(a.publishedAt));
}
export function comparableDimensions(a:ReportDimension[],b:ReportDimension[]):boolean {
 return !!a.length&&a.length===b.length&&a.every(item=>item.key!==null&&b.some(other=>other.key===item.key&&other.weight===item.weight));
}
export function formatReportScore(value:number|null):string {return value===null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(value);}
