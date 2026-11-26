export const MONTHLY_SECTIONS=[{key:'cycles',label:'周期管理',icon:'cycle'},{key:'relations',label:'评价分配',icon:'people'},{key:'announcement',label:'公告编辑',icon:'megaphone'},{key:'exceptions',label:'异常核验',icon:'check'},{key:'results',label:'结果管理',icon:'layers'},{key:'growth',label:'成长分析',icon:'chart'}] as const;
export function monthlyPath(section: string='cycles',cycleId?:string){return '/management/monthly/'+section+(cycleId?'/'+encodeURIComponent(cycleId):'');}
export const monthlyLabel=(section:unknown)=>MONTHLY_SECTIONS.find(s=>s.key===section)?.label??'周期管理';
