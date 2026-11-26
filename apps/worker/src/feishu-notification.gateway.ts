import { createHash } from 'node:crypto';
import { readFeishuConnection } from '@360/domain';
import type {DbClient,NotificationGateway,OutboundNotification,GatewaySendResult} from '@360/domain';

/** Feishu acceptance is recorded separately from receipt/read confirmation. */
export class FeishuNotificationGateway implements NotificationGateway {
 private token='';private expires=0;private credentialHash='';
 constructor(private readonly db:DbClient,private readonly config:NodeJS.ProcessEnv=process.env,private readonly request:typeof fetch=fetch){}
 private async post(path:string,body:unknown,token?:string){
  const response=await this.request('https://open.feishu.cn/open-apis'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  const data=await response.json() as {code?:number;tenant_access_token?:string;expire?:number;data?:{message_id?:string}};
  if(!response.ok||data.code)throw new Error('FEISHU_PROVIDER_'+(data.code??response.status));
  return data;
 }
 async send(message:OutboundNotification):Promise<GatewaySendResult>{
  let connection;
  try {
   connection = this.config.SESSION_SECRET ? await readFeishuConnection(this.db, message.orgId, this.config.SESSION_SECRET) : null;
  } catch { return {ok:false,error:'FEISHU_CONFIGURATION_UNAVAILABLE'}; }
  const app=connection?.appId??this.config.FEISHU_APP_ID;
  const secret=connection?.secret??this.config.FEISHU_APP_SECRET;
  const tenant=connection?.tenantKey??this.config.FEISHU_TENANT_KEY;
  const org=connection?message.orgId:this.config.FEISHU_ORG_ID;
  if(!app||!secret||!tenant||!org)return {ok:false,error:'FEISHU_NOT_CONFIGURED'};
  if(message.orgId!==org)return {ok:false,error:'FEISHU_ORGANIZATION_MISMATCH'};
  if(!['FEISHU','IN_APP'].includes(message.channel))return {ok:false,error:'NOTIFICATION_CHANNEL_NOT_CONFIGURED'};
  const identities=await this.db.query<{external_id:string}>(`SELECT e.external_id FROM external_identities e
    JOIN users u ON u.id=e.user_id WHERE u.id=$1 AND u.org_id=$2 AND u.status='ACTIVE'
    AND e.provider='FEISHU' AND e.tenant_key=$3 AND e.approved=true`,[message.recipientId,org,tenant]);
  if(identities.rows.length!==1||!/^ou_[A-Za-z0-9_-]+$/.test(identities.rows[0].external_id))return {ok:false,error:'FEISHU_RECIPIENT_NOT_BOUND'};
  try{
   const credentialHash=createHash('sha256').update(JSON.stringify([app,secret])).digest('hex');
   if(!this.token||this.expires<=Date.now()||credentialHash!==this.credentialHash){
    const data=await this.post('/auth/v3/tenant_access_token/internal',{app_id:app,app_secret:secret});
    if(!data.tenant_access_token)throw new Error('FEISHU_TOKEN_MISSING');
    this.credentialHash=credentialHash;this.token=data.tenant_access_token;this.expires=Date.now()+Math.max(0,(Number(data.expire??7200)-120))*1000;
   }
   const titles:Record<string,string>={RESULT_PUBLISHED:'你的环评结果已发布',FEEDBACK_SUBMITTED:'你的申诉已登记',FEEDBACK_RESOLVED:'你的申诉已有处理结果',FEEDBACK_REREVIEW_OPENED:'你的二次复核已登记',FEEDBACK_REREVIEW_RESOLVED:'你的二次复核已有处理结果',SYSTEM_TEST:'系统通知测试，不涉及评分'};
   const title=titles[String(message.payload.type)]??'你的360环评有一条状态更新';
   const origin=this.config.APP_ORIGIN??'';
   // 允许调用方用 payload.text 下发完整文案（催办提醒需要带具体剩余数量和截止时间）。
   const custom=typeof (message.payload as {text?:unknown})?.text==='string'?String((message.payload as {text:string}).text).trim():'';
   const body=custom||(title+'。请登录360环评系统查看。'+(origin?'\n'+origin:''));
   const data=await this.post('/im/v1/messages?receive_id_type=open_id',{receive_id:identities.rows[0].external_id,msg_type:'text',content:JSON.stringify({text:body}),uuid:message.id},this.token);
   const id=data.data?.message_id;
   return id?{ok:true,accepted:true,messageId:id}:{ok:false,error:'FEISHU_MESSAGE_ACK_MISSING'};
  }catch(error){this.token='';const code=error instanceof Error?error.message:'';return {ok:false,error:/^FEISHU_[A-Z_0-9-]+$/.test(code)?code:'FEISHU_TRANSPORT_ERROR'};}
 }
}
