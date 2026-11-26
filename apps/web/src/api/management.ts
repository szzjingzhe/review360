export async function managementRequest<T=any>(path:string,body?:unknown,method?:string):Promise<T> {
 const send=()=>fetch('/api/v1/'+path,{credentials:'include',method:method??(body===undefined?'GET':'POST'),
   headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 let response=await send();
 // 凭证偶发丢失（代理/浏览器瞬时问题）时静默重试一次，避免用户直接看到 401
 if(response.status===401){await new Promise(r=>setTimeout(r,150));response=await send();}
 const json=await response.json();
 if(!response.ok){
   const code=json.code??json.message??`请求失败（${response.status}）`;
   throw new Error(code==='UNAUTHENTICATED'||code==='SESSION_INVALID'?'AUTH_REQUIRED':code);
 }
 return json.data;
}
export const cycleStage=(status:string)=>({DRAFT:'草稿',PENDING_OPEN:'待开始',REVIEWING:'评价中',PAUSED:'已暂停',CALIBRATING:'已截止 · 待发布结果',
 PARTIALLY_PUBLISHED:'部分发布',PUBLISHED:'已发布',ARCHIVED:'已归档',CANCELLED:'已撤销'}[status]??status);
