/** Template-driven validation: names, weights and reason policy remain configuration-owned. */
export interface ScoreItem { itemId:string; score:number|null; reason?:string|null }
export interface TemplateScoreItem { id:string; weight:number; required?:boolean }
export class ReviewValidationError extends Error {
  constructor(readonly code:string,readonly itemId?:string){super(code);}
}
export function validateReviewItems(template:ReadonlyArray<TemplateScoreItem>,value:unknown,complete:boolean):ScoreItem[] {
  if(!template.length || template.some(t=>!Number.isInteger(t.weight)||t.weight<0||t.weight>100)
    || template.reduce((n,t)=>n+t.weight,0)!==100 || new Set(template.map(t=>t.id)).size!==template.length)
    throw new ReviewValidationError('TEMPLATE_INVALID');
  if(!Array.isArray(value))throw new ReviewValidationError('ITEMS_INVALID');
  const allowed=new Map(template.map(t=>[t.id,t]));const seen=new Set<string>();
  for(const item of value){
    if(!item||typeof item.itemId!=='string'||!allowed.has(item.itemId))throw new ReviewValidationError('ITEM_NOT_IN_TEMPLATE',item?.itemId);
    if(seen.has(item.itemId))throw new ReviewValidationError('DUPLICATE_ITEM',item.itemId);seen.add(item.itemId);
    if((complete||item.score!==null)&&(!Number.isInteger(item.score)||item.score<0||item.score>100))throw new ReviewValidationError('SCORE_INVALID',item.itemId);
    if(item.reason!=null&&typeof item.reason!=='string')throw new ReviewValidationError('REASON_INVALID',item.itemId);
  }
  if(complete){
    for(const item of template)if(item.required!==false&&!seen.has(item.id))throw new ReviewValidationError('REQUIRED_ITEM_MISSING',item.id);
  }
  return value;
}
/** Full template denominator; missing dimensions never cause weight renormalization. */
export function reviewScoreBp(template:ReadonlyArray<TemplateScoreItem>,value:unknown):number {
  const items=validateReviewItems(template,value,true);const weights=new Map(template.map(t=>[t.id,t.weight]));
  return Math.round(items.reduce((sum,i)=>sum+i.score!*weights.get(i.itemId)!,0));
}
