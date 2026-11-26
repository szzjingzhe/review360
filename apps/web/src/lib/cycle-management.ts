export interface ManagedCycle {id:string;title:string;month:string;status:string;open_at:string;self_close_at?:string|null;close_at:string;publish_at:string;ruleset_id:string;row_version:number;rule_version?:number;participants:number;materials:number;self_submitted:number;peer_expected:number;peer_submitted:number;materialRate:number|null;selfRate:number|null;peerRate:number|null;management_stage?:string|null;can_manage?:boolean}
export interface CycleDetail {cycle:ManagedCycle;participants:Array<{user_id:string;display_name:string;department_name:string|null;role_snapshot:string;eligibility:string;exclusion_reason:string|null}>;stateLog:Array<{from_status:string;to_status:string;created_at:string;reason:string;actor_name?:string|null}>;permissions:{canCreate:boolean;canEdit:boolean;canRefresh:boolean;canDelete:boolean;canRestore:boolean;canArchive:boolean;canCancel:boolean;canPause:boolean;canResume:boolean}}
export const cycleStatus=(c:Pick<ManagedCycle,'status'|'management_stage'>)=>c.management_stage??({DRAFT:'草稿',PENDING_OPEN:'未开始',REVIEWING:'评价中',PAUSED:'已暂停',CALIBRATING:'待核验 / 待发布',PARTIALLY_PUBLISHED:'部分发布',PUBLISHED:'已发布',ARCHIVED:'已归档',CANCELLED:'已撤销'}[c.status]??c.status);
export const dateTime=(v?:string|null)=>v?new Date(v).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'尚未设置';
export function filterCycles(rows:ManagedCycle[],query:string,status:string,year:string,archived:boolean){const keyword=query.trim().toLowerCase();return rows.filter(c=>(c.status==='ARCHIVED')===archived&&(!keyword||`${c.title} ${c.month}`.toLowerCase().includes(keyword))&&(!year||c.month.startsWith(year))&&(!status||cycleStatus(c)===status));}
export function validateCycleForm(form:{title:string;month:string;open_at:string;self_close_at?:string|null;close_at:string;publish_at:string;ruleset_id:string},rows:ManagedCycle[],editing?:string){
 if(!form.title.trim())return '请填写周期名称。';
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(form.month))return '请选择有效的评价月份。';
 if(rows.some(c=>c.id!==editing&&c.month.slice(0,7)===form.month))return '该月份已存在周期，请查看已有周期。';
 const a=Date.parse(form.open_at),b=Date.parse(form.close_at),c=Date.parse(form.publish_at),s=form.self_close_at?Date.parse(form.self_close_at):null;
 if(![a,b,c].every(Number.isFinite)||a>=b||b>c)return '开始时间必须早于截止时间，结果发布时间不得早于截止时间。';
 if(s!==null&&(!Number.isFinite(s)||a>=s||s>b))return '自评截止时间必须晚于评价开始时间、且不晚于评价截止时间。';
 if(!form.ruleset_id)return '请选择已冻结的评分规则。';
 return '';
}
