/** Historical results require a real publication and a completed publication phase. */
export function publishedHistory<T extends {id:string;status:string;month:string}>(cycles:T[],results:Array<{cycle_id:string}>):T[]{
 const published=new Set(results.map(r=>r.cycle_id));
 return cycles.filter(c=>['PARTIALLY_PUBLISHED','PUBLISHED','ARCHIVED'].includes(c.status)&&published.has(c.id))
  .sort((a,b)=>b.month.localeCompare(a.month));
}
