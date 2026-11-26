import { BadRequestException } from '@nestjs/common';
export interface Evidence { id:string; kind:string; text:string }
export interface GrowthInput { cycle:string; dimensions:string[]; evidence:Evidence[]; history:{cycle:string;summary:string}[] }
const invalid=()=>{throw new BadRequestException({code:'GROWTH_CONTENT_INVALID'});};
// Scores, identities, URLs and numeric literals are never part of qualitative report prose.
export function prose(value:unknown,max=4000):string {
  if(typeof value!=='string'||!value.trim()||value.length>max||/[0-9０-９]|https?:|得分|评分|均分|排名|百分|百分点|满分|评价者|评委姓名|[零一二三四五六七八九十百点]+\s*分/.test(value))return invalid();
  return value.trim();
}
export function validateReport(value:any,input:GrowthInput) {
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const available=new Set(input.evidence.map(e=>e.id));
  const refs=(v:any)=>{
    if(!Array.isArray(v)||!v.length||v.length>20||v.some(x=>typeof x!=='string'||!available.has(x)))return invalid();
    return [...new Set(v)] as string[];
  };
  const claims=(v:any)=>{
    if(!Array.isArray(v)||v.length<1||v.length>3)return invalid();
    return v.map(x=>({text:prose(x?.text,800),evidence_ids:refs(x?.evidence_ids)}));
  };
  const overall_summary=prose(value.overall_summary,180);
  if([...overall_summary].length<100)return invalid();
  const evidence_references=refs(value.evidence_references);
  if(!Array.isArray(value.keywords)||value.keywords.length>8)return invalid();
  const keywords=value.keywords.map((x:any)=>{
    const word=prose(x?.word,12);if([...word].length<2)return invalid();
    // Count literal, non-overlapping mentions in the immutable current-cycle text, never AI numbers.
    const count=input.evidence.reduce((n,e)=>n+e.text.split(word).length-1,0);
    if(!count)return invalid();return {word,count};
  });
  if(new Set(keywords.map((x:any)=>x.word)).size!==keywords.length)return invalid();
  if(!Array.isArray(value.capability_features)||value.capability_features.length!==input.dimensions.length)return invalid();
  const capability_features=input.dimensions.map(d=>{
    const matches=value.capability_features.filter((x:any)=>x.dimension===d);if(matches.length!==1)return invalid();
    return {dimension:d,...claims([matches[0]])[0]};
  });
  return {overall_summary,strengths:claims(value.strengths),improvements:claims(value.improvements),
    growth_suggestions:claims(value.growth_suggestions),action_plan:claims(value.action_plan),keywords,
    traits:claims(value.traits),capability_features,
    trend_summary:input.history.length<1?'历史周期不足，暂不形成趋势判断。':prose(value.trend_summary,1000),
    evidence_references};
}
/** Explicit projection for legacy records as well: no unknown JSON properties reach members/PDFs. */
export function personalContent(value:any,input?:GrowthInput|null):any {
  try {
    if(value?.overall_summary&&input)return validateReport(value,input);
    if(!value)return null;
    const r:Record<string,string>={};for(const k of ['strengths','weaknesses','suggestions','directions'])r[k]=prose(value[k]);return r;
  } catch {return null;}
}
