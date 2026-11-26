/** Pure decision; callers must supply only current effective PEER scores. */
export interface DifferenceRule { minReviews:number; mediumPoints:number; highPoints:number }
export function assessSelfPeerDifference(selfBp:number|null,peerBp:readonly number[],rule?:DifferenceRule) {
  if(!rule)return {status:'NOT_CONFIGURED' as const};
  if(!Number.isInteger(rule.minReviews)||rule.minReviews<2||!Number.isFinite(rule.mediumPoints)||!Number.isFinite(rule.highPoints)||rule.mediumPoints<0||rule.highPoints<rule.mediumPoints)throw new Error('DIFFERENCE_RULE_INVALID');
  if(selfBp===null)return {status:'NO_SELF' as const};
  if(peerBp.length<rule.minReviews)return {status:'INSUFFICIENT' as const,count:peerBp.length};
  const peerAverageBp=peerBp.reduce((sum,n)=>sum+n,0)/peerBp.length;
  const differencePoints=Math.abs(selfBp-peerAverageBp)/100;
  return {status:differencePoints>=rule.mediumPoints?'TRIGGERED' as const:'NORMAL' as const,
    severity:differencePoints>=rule.highPoints?'HIGH' as const:differencePoints>=rule.mediumPoints?'MEDIUM' as const:null,
    count:peerBp.length,peerAverageBp,differencePoints};
}
