import { ITEM_REASON_RULES, type ItemReasonRules } from './itemReasons';
export interface SelfMetric {
  id: string; code: string; label: string; weight: number;
  description: string; placeholder: string; scoreText: string; reason: string;
}
export interface SelfReviewForm {
  id: string; cycleId: string; status: string; items: SelfMetric[];
  overallReason: string; comment: string; nextPlan: string; readConfirmed: boolean;
  reasonRules: ItemReasonRules;
  scoreBp: number | null; submittedAt: string; detailsUnavailable: boolean;
}
const guidance: Record<string, {description: string; placeholder: string}> = {
  self_awareness: {description:'客观回顾工作表现，认识自己的优势与不足。',placeholder:'例如：本月能够独立完成需求分析；但时间管理仍有不足，部分任务出现延期。'},
  reflection: {description:'回顾本期工作，结合具体事实说明收获与改进方向。',placeholder:'例如：顺利完成核心功能开发，团队协作良好；但沟通反馈不够及时，影响了部分工作的推进。'},
  next_focus: {description:'说明下一阶段的重点目标、行动与改进方向。',placeholder:'例如：下月重点推进新版本上线，提升模块性能；加强跨部门沟通，优化计划，确保按时交付。'},
  support_needed: {description:'说明需要的指导、资源或协同支持；暂无需求可填写“暂无”。',placeholder:'例如：项目遇到技术难点，希望获得指导；需要协调测试资源以加快上线。如暂无需求，可填写“暂无”。'},
};

export function scoreError(text: string): string {
  if (!text.trim()) return '';
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text.trim()) || !Number.isFinite(Number(text))) return '请输入有效数字。';
  const score=Number(text);
  if (score<0||score>100) return '分数须在 0–100 分之间。';
  return Number.isInteger(score)?'':'仅支持整数分，调整步长为 1 分。';
}
export function scoreValue(text: string): number | null {
  return !text.trim()||scoreError(text)?null:Number(text);
}
/** Match the existing API's basis-point rounding, without treating a blank score as zero. */
export function selfTotal(items: Pick<SelfMetric,'weight'|'scoreText'>[]): number | null {
  if (!items.length || items.some(i=>scoreValue(i.scoreText)===null||!Number.isFinite(i.weight)||i.weight<0)) return null;
  const weight=items.reduce((sum,i)=>sum+i.weight,0);
  if (weight<=0) return null;
  return Math.round(items.reduce((sum,i)=>sum+Number(i.scoreText)*i.weight,0)/weight*100)/100;
}
export function hydrateSelfReview(data: Record<string,any>): SelfReviewForm {
  const submitted=data.review.status==='SUBMITTED';
  const revision=data.latestRevision;
  const source=submitted?(revision??{}):(data.draft?.dataJson??{});
  const saved=Array.isArray(source.items)?source.items:[];
  return {
    reasonRules:data.reasonRules??ITEM_REASON_RULES,
    id:data.review.id,cycleId:data.review.cycleId,status:data.review.status,
    items:(data.template?.items??[]).map((item:Record<string,any>)=>{
      const value=saved.find((s:Record<string,any>)=>(s.itemId??s.item_id)===item.id);
      const fallback=guidance[item.code];
      return {id:item.id,code:item.code??'',label:item.label,weight:Number(item.weight),
        description:item.description||fallback?.description||'请结合本期实际工作表现进行评价。',
        placeholder:item.placeholder||item.fillingHint||fallback?.placeholder||'例如：说明完成了什么、产生了什么结果，以及后续改进方向。',
        scoreText:value?.score==null?'':String(value.score),reason:value?.reason??''};
    }),
    overallReason:source.overallReason??source.overall_reason??'',comment:source.comment??'',nextPlan:source.nextPlan??source.next_plan??'',
    readConfirmed:!!(source.readConfirmed??source.read_confirmed),scoreBp:revision?.scoreBp==null?null:Number(revision.scoreBp),
    submittedAt:revision?.submittedAt??'',detailsUnavailable:submitted&&!Array.isArray(revision?.items),
  };
}
export function selfDraft(form: SelfReviewForm) {
  return {items:form.items.map(i=>({itemId:i.id,score:scoreValue(i.scoreText),reason:i.reason||null})),
    overallReason:form.overallReason||null,comment:form.comment||null,nextPlan:form.nextPlan||null,readConfirmed:form.readConfirmed};
}
