import {BadRequestException,ConflictException,ForbiddenException,HttpException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHash} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import type {AuthContext} from './current-user.decorator';
import {FeishuService} from './feishu.service';
import {FeishuAdmissionService} from './feishu-admission.service';
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
@Injectable()
export class FeishuPrebindingService {
 constructor(@Inject('DATABASE_POOL') private readonly db:Pool,private readonly config:ConfigService,
  private readonly feishu:FeishuService,private readonly admission:FeishuAdmissionService){}
 private mapping(actor:AuthContext){const tenant=this.config.get<string>('FEISHU_TENANT_KEY'),appId=this.config.get<string>('FEISHU_APP_ID');
  if(!tenant||!appId||this.config.get('FEISHU_ORG_ID')!==actor.orgId)throw new ForbiddenException({code:'FEISHU_ORG_MISMATCH'});return {tenant,appId};}
 private async directory(actor:AuthContext){const mapping=this.mapping(actor),directory=await this.feishu.readDirectory(actor.orgId);
  if(directory.tenantKey!==mapping.tenant||directory.appId!==mapping.appId)throw new ConflictException({code:'DIRECTORY_MAPPING_MISMATCH'});return directory;}
 private async transaction<T>(fn:(client:PoolClient)=>Promise<T>){const c=await this.db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 private async batch(c:Pool|PoolClient,actor:AuthContext,id:string,lock=false){const map=this.mapping(actor);if(!UUID.test(id))throw new NotFoundException({code:'PREBINDING_NOT_FOUND'});
  const row=(await c.query(`SELECT * FROM feishu_prebinding_batches WHERE id=$1 AND org_id=$2 AND tenant_key=$3 AND app_id=$4 ${lock?'FOR UPDATE':''}`,[id,actor.orgId,map.tenant,map.appId])).rows[0];
  if(!row)throw new NotFoundException({code:'PREBINDING_NOT_FOUND'});return row;}
 private ensureDraft(batch:any){if(batch.status!=='DRAFT')throw new ConflictException({code:'PREBINDING_ALREADY_APPLIED'});if(new Date(batch.expires_at).getTime()<=Date.now())throw new ConflictException({code:'PREBINDING_EXPIRED'});}
 private async audit(c:PoolClient,actor:AuthContext,action:string,id:string,detail:unknown){await c.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,$3,'feishu_prebinding_batch',$4,$5)`,[actor.orgId,actor.userId,action,id,JSON.stringify(detail)]);}
 async preview(actor:AuthContext){const directory=await this.directory(actor),map=this.mapping(actor);
  const result=await this.transaction(async c=>{
   const members=(await c.query(`SELECT u.id,u.display_name,coalesce(d.name,'未分配') AS department_name FROM users u
    LEFT JOIN department_memberships m ON m.user_id=u.id AND m.org_id=u.org_id AND m.valid_from<=current_date AND (m.valid_to IS NULL OR m.valid_to>current_date)
    LEFT JOIN departments d ON d.id=m.department_id AND d.org_id=u.org_id WHERE u.org_id=$1 AND u.status='ACTIVE' AND u.result_view_only=false ORDER BY u.id`,[actor.orgId])).rows;
   if(members.length>500)throw new BadRequestException({code:'PREBINDING_TOO_MANY_MEMBERS'});
   const bindings=(await c.query(`SELECT e.id,e.user_id,e.external_id,e.approved,u.org_id FROM external_identities e JOIN users u ON u.id=e.user_id WHERE e.provider='FEISHU' AND e.tenant_key=$1`,[map.tenant])).rows;
   const batch=(await c.query(`INSERT INTO feishu_prebinding_batches(org_id,tenant_key,app_id,created_by,visibility_json) VALUES($1,$2,$3,$4,$5) RETURNING id`,[actor.orgId,map.tenant,map.appId,actor.userId,directory.visibility])).rows[0];
   for(const member of members){const own=bindings.filter(b=>b.user_id===member.id),approved=own.filter(b=>b.approved);
    // Names suggest candidates only; they never establish verified state or binding.
    const candidates=directory.users.filter(u=>u.name===member.display_name);
    let status=approved.length===1?'BOUND':approved.length>1?'CONFLICT':!candidates.length?'UNMATCHED':candidates.length>1?'AMBIGUOUS':!candidates[0].active?'INACTIVE':'PENDING_VERIFICATION';
    if(!approved.length&&candidates.length===1&&members.filter(m=>m.display_name===member.display_name).length>1)status='CONFLICT';
    if(!approved.length&&candidates.some(u=>bindings.some(b=>b.external_id===u.openId&&b.user_id!==member.id)))status='CONFLICT';
    await c.query(`INSERT INTO feishu_prebinding_items(batch_id,org_id,user_id,member_name,department_name,match_status,candidates_json,bindings_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[batch.id,actor.orgId,member.id,member.display_name,member.department_name,status,JSON.stringify(candidates),JSON.stringify(own.map(b=>({id:b.id,openId:b.external_id,approved:b.approved})))]);
   }
   await this.audit(c,actor,'auth.feishu.prebinding.preview',batch.id,{members:members.length,contacts:directory.users.length});return batch.id;
  });return this.detail(actor,result);
 }
 async list(actor:AuthContext){const m=this.mapping(actor);return (await this.db.query(`SELECT id,status,created_at,expires_at,applied_at FROM feishu_prebinding_batches WHERE org_id=$1 AND tenant_key=$2 AND app_id=$3 ORDER BY created_at DESC LIMIT 50`,[actor.orgId,m.tenant,m.appId])).rows;}
 async detail(actor:AuthContext,id:string){const b=await this.batch(this.db,actor,id);const rows=(await this.db.query(`SELECT i.*,u.display_name AS verified_by_name FROM feishu_prebinding_items i LEFT JOIN users u ON u.id=i.verified_by AND u.org_id=i.org_id WHERE i.batch_id=$1 AND i.org_id=$2 ORDER BY i.member_name,i.id`,[id,actor.orgId])).rows;
  return {id:b.id,status:b.status,tenantKey:b.tenant_key,appId:b.app_id,createdAt:b.created_at,expiresAt:b.expires_at,visibility:b.visibility_json,lastResult:b.last_result_json,
   summary:Object.fromEntries(['BOUND','PENDING_VERIFICATION','CONFLICT','UNMATCHED','AMBIGUOUS','INACTIVE'].map(k=>[k,rows.filter(r=>r.match_status===k).length])),items:rows};}
 async verify(actor:AuthContext,batchId:string,itemId:string,body:{confirmed?:unknown;openId?:unknown;evidence?:unknown}){
  if(!UUID.test(itemId)||!body||typeof body.confirmed!=='boolean'||body.confirmed&&(typeof body.evidence!=='string'||!body.evidence.trim()||body.evidence.length>500))throw new BadRequestException({code:'VERIFICATION_REQUIRED'});
  await this.transaction(async c=>{const b=await this.batch(c,actor,batchId,true);this.ensureDraft(b);const item=(await c.query('SELECT * FROM feishu_prebinding_items WHERE id=$1 AND batch_id=$2 AND org_id=$3 FOR UPDATE',[itemId,batchId,actor.orgId])).rows[0];
   if(!item)throw new NotFoundException({code:'PREBINDING_ITEM_NOT_FOUND'});
   if(body.confirmed&&(item.match_status!=='PENDING_VERIFICATION'||item.candidates_json.length!==1||item.candidates_json[0].openId!==body.openId))throw new ConflictException({code:'PREBINDING_ITEM_NOT_ELIGIBLE'});
   await c.query(`UPDATE feishu_prebinding_items SET verified_open_id=$2,verification_evidence=$3,verified_by=$4,verified_at=$5 WHERE id=$1`,[itemId,body.confirmed?body.openId:null,body.confirmed?(body.evidence as string).trim():null,body.confirmed?actor.userId:null,body.confirmed?new Date():null]);
   await this.audit(c,actor,'auth.feishu.prebinding.verify',batchId,{itemId,confirmed:body.confirmed,evidence:body.confirmed?(body.evidence as string).trim():null});
  });return this.detail(actor,batchId);
 }
 async submit(actor:AuthContext,id:string,body:{itemIds?:unknown;visibilityConfirmed?:unknown;visibilityEvidence?:unknown}){
  if(!body||!Array.isArray(body.itemIds)||!body.itemIds.length||body.itemIds.length>500||body.itemIds.some(v=>typeof v!=='string'||!UUID.test(v))||new Set(body.itemIds).size!==body.itemIds.length)throw new BadRequestException({code:'PREBINDING_ITEMS_INVALID'});
  const itemIds=(body.itemIds as string[]).slice().sort(),hash=createHash('sha256').update(JSON.stringify(itemIds)).digest('hex'),existing=await this.batch(this.db,actor,id);
  if(existing.status==='APPLIED'){if(existing.submit_hash!==hash)throw new ConflictException({code:'PREBINDING_RETRY_MISMATCH'});return {...existing.last_result_json,replayed:true};}
  if(body.visibilityConfirmed!==true||typeof body.visibilityEvidence!=='string'||!body.visibilityEvidence.trim()||body.visibilityEvidence.length>500)throw new BadRequestException({code:'APP_VISIBILITY_CONFIRMATION_REQUIRED'});
  this.ensureDraft(existing);const directory=await this.directory(actor);
  const outcome=await this.transaction(async c=>{const batch=await this.batch(c,actor,id,true);
   if(batch.status==='APPLIED'){if(batch.submit_hash!==hash)throw new ConflictException({code:'PREBINDING_RETRY_MISMATCH'});return {...batch.last_result_json,replayed:true};}this.ensureDraft(batch);
   const selected=(await c.query(`SELECT * FROM feishu_prebinding_items WHERE batch_id=$1 AND org_id=$2 AND id=ANY($3::uuid[]) ORDER BY user_id FOR UPDATE`,[id,actor.orgId,itemIds])).rows;
   const results=itemIds.map(itemId=>({itemId,userId:selected.find(i=>i.id===itemId)?.user_id as string|undefined,status:'VALID',code:''}));
   for(const externalId of [...new Set<string>(selected.map(i=>i.verified_open_id).filter(Boolean))].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['FEISHU',batch.tenant_key,externalId])]);
   await c.query('SELECT id FROM users WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[actor.orgId,selected.map(i=>i.user_id)]);
   for(const r of results){const item=selected.find(i=>i.id===r.itemId);let code='';
    if(!item)code='PREBINDING_ITEM_NOT_FOUND';else if(item.match_status!=='PENDING_VERIFICATION'||!item.verified_by||!item.verified_open_id||!item.verification_evidence?.trim())code='VERIFICATION_REQUIRED';
    else {const contact=directory.users.find(u=>u.openId===item.verified_open_id);if(!contact?.active)code='FEISHU_IDENTITY_UNAVAILABLE';
     if(selected.filter(i=>i.verified_open_id===item.verified_open_id).length>1)code='DUPLICATE_IDENTITY_IN_BATCH';
     const user=(await c.query("SELECT id FROM users WHERE id=$1 AND org_id=$2 AND status='ACTIVE' FOR UPDATE",[item.user_id,actor.orgId])).rows[0];if(!user)code='USER_NOT_FOUND';
     const bindings=(await c.query("SELECT e.user_id,e.external_id,e.approved FROM external_identities e WHERE e.provider='FEISHU' AND e.tenant_key=$1 AND (e.external_id=$2 OR e.user_id=$3)",[batch.tenant_key,item.verified_open_id,item.user_id])).rows;
     if(bindings.some(e=>e.external_id===item.verified_open_id&&e.user_id!==item.user_id))code='FEISHU_BINDING_CONFLICT';
     else if(bindings.some(e=>e.user_id===item.user_id&&e.approved&&e.external_id!==item.verified_open_id))code='FEISHU_ACCOUNT_ALREADY_BOUND';
    }
    if(code){r.status='FAILED';r.code=code;}
   }
   if(results.some(r=>r.status==='FAILED')){for(const r of results)if(r.status==='VALID'){r.status='ROLLED_BACK';r.code='BATCH_NOT_COMMITTED';}
    const failure={batchId:id,committed:false,items:results};await c.query('UPDATE feishu_prebinding_batches SET attempts=attempts+1,last_result_json=$2 WHERE id=$1',[id,failure]);await this.audit(c,actor,'auth.feishu.prebinding.failed',id,failure);return failure;}
   // A concurrent legacy approval can still conflict during insertion. Roll back all
   // binding writes to this savepoint and retain only the failed-attempt audit.
   await c.query('SAVEPOINT prebinding_writes');let applying:string|undefined;
   try{for(const item of selected){applying=item.id;const already=(await c.query("SELECT id FROM external_identities WHERE provider='FEISHU' AND tenant_key=$1 AND external_id=$2 AND user_id=$3 AND approved",[batch.tenant_key,item.verified_open_id,item.user_id])).rowCount;
    await this.admission.bindInTransaction(c,actor,{user_id:item.user_id,external_id:item.verified_open_id,reason:('预绑定批次 '+id+'；核实人 '+item.verified_by+'；依据 '+item.verification_evidence).slice(0,500)});
    const r=results.find(r=>r.itemId===item.id)!;r.status=already?'ALREADY_BOUND':'BOUND';r.code='';}
   }catch(error){await c.query('ROLLBACK TO SAVEPOINT prebinding_writes');
    const dbCode=(error as {code?:string}).code;
    if(!(error instanceof HttpException)&&!['23505','23503','40P01'].includes(dbCode??''))throw error;
    const response=error instanceof HttpException?error.getResponse():null;
    const code=typeof response==='object'&&response&&'code' in response?String(response.code):'PREBINDING_CONCURRENT_CONFLICT';
    for(const r of results){r.status=r.itemId===applying?'FAILED':'ROLLED_BACK';r.code=r.itemId===applying?code:'BATCH_NOT_COMMITTED';}
    const failure={batchId:id,committed:false,items:results};await c.query('UPDATE feishu_prebinding_batches SET attempts=attempts+1,last_result_json=$2 WHERE id=$1',[id,failure]);await this.audit(c,actor,'auth.feishu.prebinding.failed',id,failure);return failure;
   }
   await c.query('RELEASE SAVEPOINT prebinding_writes');
   await c.query("UPDATE feishu_prebinding_items SET match_status='BOUND' WHERE batch_id=$1 AND org_id=$2 AND id=ANY($3::uuid[])",[id,actor.orgId,itemIds]);
   const result={batchId:id,committed:true,items:results};await c.query(`UPDATE feishu_prebinding_batches SET status='APPLIED',submit_hash=$2,applied_by=$3,applied_at=now(),attempts=attempts+1,last_result_json=$4 WHERE id=$1`,[id,hash,actor.userId,result]);
   await this.audit(c,actor,'auth.feishu.prebinding.apply',id,{...result,visibilityEvidence:(body.visibilityEvidence as string).trim()});return result;
  });if(!outcome.committed)throw new ConflictException({code:'PREBINDING_VALIDATION_FAILED',detail:outcome});return outcome;
 }
}
