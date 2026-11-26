import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { SessionService } from './session.service';
import type { AuthContext } from './current-user.decorator';
import { insecureHttpApproved } from '../config/env.validation';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FEISHU_STATE_COOKIE='s360_feishu_state';
export const FEISHU_ADMISSION_COOKIE='s360_feishu_admission';
@Injectable()
export class FeishuAdmissionService {
  // Single-use, server-side challenges. Multiple API instances require sticky OAuth routing.
  private readonly states=new Map<string,number>();
  constructor(@Inject('DATABASE_POOL') private readonly db:Pool,private readonly config:ConfigService,private readonly sessions:SessionService) {}
  cookieOptions(state=false) {
    const httpException=insecureHttpApproved({APP_ORIGIN:this.config.get('APP_ORIGIN'),FEISHU_REDIRECT_URI:this.config.get('FEISHU_REDIRECT_URI'),ALLOW_INSECURE_HTTP_ORIGIN:this.config.get('ALLOW_INSECURE_HTTP_ORIGIN')});
    return {httpOnly:true,secure:!httpException&&(this.config.get('APP_ENV')==='production'||process.env.NODE_ENV==='production'),sameSite:'lax' as const,path:state?'/api/v1/auth/feishu':'/api/v1',maxAge:state?10*60*1000:12*60*60*1000};
  }
  mapping() {
    const tenant=this.config.get<string>('FEISHU_TENANT_KEY')??'',orgId=this.config.get<string>('FEISHU_ORG_ID')??'';
    if(!tenant||!UUID.test(orgId)) throw new ForbiddenException({code:'FEISHU_MAPPING_NOT_CONFIGURED'});
    return {tenant,orgId};
  }
  issueState() {
    this.mapping();const now=Date.now();
    for(const [key,expires] of this.states)if(expires<=now)this.states.delete(key);
    if(this.states.size>=10000)throw new ForbiddenException({code:'FEISHU_STATE_CAPACITY'});
    const value=randomBytes(32).toString('base64url');
    this.states.set(createHash('sha256').update(value).digest('hex'),now+10*60*1000);return value;
  }
  consumeState(state:string,cookie:string) {
    const a=Buffer.from(state),b=Buffer.from(cookie);
    if(!state||a.length!==b.length||!timingSafeEqual(a,b))throw new UnauthorizedException({code:'FEISHU_STATE_INVALID'});
    const key=createHash('sha256').update(state).digest('hex'),expires=this.states.get(key);this.states.delete(key);
    if(!expires||expires<=Date.now())throw new UnauthorizedException({code:'FEISHU_STATE_INVALID'});
  }
  async deny(code:string):Promise<never> {
    const {orgId}=this.mapping();
    await this.db.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,reason)
      SELECT id,NULL,'auth.feishu.denied','authentication',$2 FROM organizations WHERE id=$1`,[orgId,code]);
    throw new UnauthorizedException({code});
  }
  async login(identity:Record<string,unknown>,userAgent?:string) {
    const {tenant,orgId}=this.mapping();
    // Never substitute the configured tenant for a missing or mismatched provider identity.
    if(identity.tenant_key!==tenant)return this.deny('FEISHU_TENANT_MISMATCH');
    const externalId=typeof identity.open_id==='string'?identity.open_id:'';
    if(!externalId)return this.deny('FEISHU_IDENTITY_MISSING');
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      await this.identityLock(client,tenant,externalId);
      const found=await client.query(`SELECT u.id,u.org_id FROM external_identities e JOIN users u ON u.id=e.user_id
        WHERE e.provider='FEISHU' AND e.tenant_key=$1 AND e.external_id=$2 AND e.approved=true
          AND u.org_id=$3 AND u.status='ACTIVE' FOR SHARE OF e,u`,[tenant,externalId,orgId]);
      let user=found.rows[0];
      if(!user) {
        const existing=(await client.query(`SELECT u.org_id,u.status FROM external_identities e JOIN users u ON u.id=e.user_id
          WHERE e.provider='FEISHU' AND e.tenant_key=$1 AND e.external_id=$2 FOR SHARE OF e,u`,[tenant,externalId])).rows[0];
        if(existing) {
          await client.query('ROLLBACK');
          return this.deny(existing.org_id!==orgId||existing.status!=='ACTIVE'?'FEISHU_ACCOUNT_UNAVAILABLE':'FEISHU_IDENTITY_NOT_APPROVED');
        }
        user=await this.firstLoginIdentity(client,tenant,orgId,externalId,identity.name);
      }
      // The identity locks remain held until the session and login audit are committed.
      const token=await this.sessions.createSession(user.id,orgId,userAgent,client);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id) VALUES($1,$2,'auth.feishu.login','user',$3)`,[orgId,user.id,user.id]);
      await client.query('COMMIT');return token;
    } catch(e) {await client.query('ROLLBACK');if((e as {code?:string}).code==='23505')throw new ConflictException({code:'FEISHU_BINDING_CONFLICT'});throw e;}finally{client.release();}
  }
  /** Product-approved exact-name association, only after OAuth and tenant verification. */
  private async firstLoginIdentity(client:PoolClient,tenant:string,orgId:string,externalId:string,name:unknown) {
    if(!/^ou_[A-Za-z0-9_-]{1,128}$/.test(externalId)||typeof name!=='string'||!name.trim()||name.trim().length>200)
      throw new UnauthorizedException({code:'FEISHU_IDENTITY_MISSING'});
    const displayName=name.trim();
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['FEISHU_NAME',orgId,displayName])]);
    const matched=(await client.query(`SELECT id,org_id,status FROM users WHERE org_id=$1 AND display_name=$2 AND result_view_only=false FOR UPDATE`,[orgId,displayName])).rows;
    if(matched.length>1)throw new ConflictException({code:'FEISHU_NAME_AMBIGUOUS'});
    let user=matched[0];
    if(user&&user.status!=='ACTIVE')throw new UnauthorizedException({code:'FEISHU_ACCOUNT_UNAVAILABLE'});
    if(user) {
      const bound=await client.query("SELECT id FROM external_identities WHERE user_id=$1 AND provider='FEISHU' AND tenant_key=$2 AND approved",[user.id,tenant]);
      if(bound.rowCount)throw new ConflictException({code:'FEISHU_ACCOUNT_ALREADY_BOUND'});
    }else {
      user=(await client.query(`INSERT INTO users(id,org_id,display_name,result_view_only) VALUES(gen_random_uuid(),$1,$2,true) RETURNING id,org_id`,[orgId,displayName])).rows[0];
      await client.query(`INSERT INTO capability_grants(org_id,user_id,capability,scope_type) VALUES($1,$2,'result.read_published','ORG')`,[orgId,user.id]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2::uuid,'auth.feishu.viewer.create','user',$2::text,'In-tenant OAuth identity outside member roster; published results only')`,[orgId,user.id]);
    }
    const binding=(await client.query(`INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU',$2,$3,true) RETURNING id`,[user.id,tenant,externalId])).rows[0];
    await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'auth.feishu.auto_bind','external_identity',$3,$4)`,[orgId,user.id,binding.id,matched.length?'OAuth tenant verified; unique exact member name; existing permissions preserved':'OAuth tenant verified; result-only viewer identity']);
    return user;
  }
  private async identityLock(client:PoolClient,tenant:string,externalId:string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['FEISHU',tenant,externalId])]);
  }
  private receiptHash(token:string) {return createHash('sha256').update(token).digest('hex');}
  private validateProvider(identity:Record<string,unknown>) {
    const {tenant,orgId}=this.mapping();
    if(identity.tenant_key!==tenant)throw new UnauthorizedException({code:'FEISHU_TENANT_MISMATCH'});
    if(typeof identity.open_id!=='string'||!/^ou_[A-Za-z0-9_-]{1,128}$/.test(identity.open_id))throw new UnauthorizedException({code:'FEISHU_IDENTITY_MISSING'});
    return {tenant,orgId,externalId:identity.open_id};
  }
  /** Called only after a valid OAuth exchange and failed approved-identity lookup. */
  async requestAdmission(identity:Record<string,unknown>) {
    const {tenant,orgId,externalId}=this.validateProvider(identity);
    const receipt=randomBytes(32).toString('base64url'),client=await this.db.connect();
    try {
      await client.query('BEGIN');await this.identityLock(client,tenant,externalId);
      const binding=(await client.query(`SELECT e.approved,u.status,u.org_id FROM external_identities e JOIN users u ON u.id=e.user_id
        WHERE e.provider='FEISHU' AND e.tenant_key=$1 AND e.external_id=$2 FOR SHARE OF e,u`,[tenant,externalId])).rows[0];
      if(binding && (binding.org_id!==orgId||binding.status!=='ACTIVE'))throw new UnauthorizedException({code:'FEISHU_ACCOUNT_UNAVAILABLE'});
      // A concurrent approval must be followed by a fresh OAuth login, never a session here.
      if(binding?.approved)throw new ConflictException({code:'FEISHU_RELOGIN_REQUIRED'});
      const existing=(await client.query("SELECT id,org_id FROM feishu_admission_requests WHERE provider='FEISHU' AND tenant_key=$1 AND external_id=$2 FOR UPDATE",[tenant,externalId])).rows[0];
      if(existing&&existing.org_id!==orgId)throw new ConflictException({code:'FEISHU_BINDING_CONFLICT'});
      const result=await client.query(`INSERT INTO feishu_admission_requests(org_id,tenant_key,external_id,display_name,status,receipt_hash,receipt_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours')
        ON CONFLICT(provider,tenant_key,external_id) DO UPDATE SET receipt_hash=EXCLUDED.receipt_hash,
          receipt_expires_at=EXCLUDED.receipt_expires_at,last_seen_at=now(),
          status=CASE WHEN feishu_admission_requests.status='APPROVED' THEN 'REVOKED' ELSE feishu_admission_requests.status END
        RETURNING id,status`,[orgId,tenant,externalId,typeof identity.name==='string'?identity.name.trim().slice(0,200):'',binding?'REVOKED':'PENDING',this.receiptHash(receipt)]);
      if(!existing)await client.query(`INSERT INTO audit_events(org_id,action,resource_type,resource_id,reason)
        VALUES($1,'auth.feishu.admission.request','feishu_admission_request',$2,'OAuth identity verified; existing member not selected automatically')`,[orgId,result.rows[0].id]);
      await client.query('COMMIT');return {receipt,status:result.rows[0].status};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async admissionStatus(receipt:string) {
    if(!/^[A-Za-z0-9_-]{43}$/.test(receipt))throw new NotFoundException({code:'ADMISSION_RECEIPT_INVALID'});
    const {orgId,tenant}=this.mapping();
    const row=(await this.db.query(`SELECT status,created_at,reviewed_at FROM feishu_admission_requests
      WHERE receipt_hash=$1 AND receipt_expires_at>now() AND org_id=$2 AND tenant_key=$3`,[this.receiptHash(receipt),orgId,tenant])).rows[0];
    if(!row)throw new NotFoundException({code:'ADMISSION_RECEIPT_EXPIRED'});
    return row; // No external identifiers, account choices, tokens or administrator notes.
  }
  async listAdmissions(actor:AuthContext,status?:string,page=1) {
    const {orgId,tenant}=this.mapping();if(actor.orgId!==orgId)throw new ForbiddenException({code:'FEISHU_ORG_MISMATCH'});
    if(status&&!['PENDING','APPROVED','REJECTED','REVOKED'].includes(status)||!Number.isInteger(page)||page<1||page>100000)throw new BadRequestException({code:'FIELD_INVALID'});
    const params=[orgId,tenant,status??null];
    const count=await this.db.query(`SELECT count(*)::int AS total FROM feishu_admission_requests WHERE org_id=$1 AND tenant_key=$2 AND ($3::text IS NULL OR status=$3)`,params);
    const rows=await this.db.query(`SELECT r.id,r.tenant_key,r.external_id,r.display_name,r.status,r.approved_user_id,
      u.display_name AS approved_user_name,r.review_reason,r.reviewed_at,r.created_at,r.last_seen_at
      FROM feishu_admission_requests r LEFT JOIN users u ON u.id=r.approved_user_id AND u.org_id=r.org_id
      WHERE r.org_id=$1 AND r.tenant_key=$2 AND ($3::text IS NULL OR r.status=$3)
      ORDER BY r.created_at DESC,r.id LIMIT 50 OFFSET $4`,[...params,(page-1)*50]);
    return {items:rows.rows,total:count.rows[0].total,page,pageSize:50};
  }
  async listBindings(actor:AuthContext) {
    const {orgId,tenant}=this.mapping();if(actor.orgId!==orgId)throw new ForbiddenException({code:'FEISHU_ORG_MISMATCH'});
    return (await this.db.query(`SELECT e.id,e.user_id,u.display_name,e.tenant_key,e.external_id,e.approved,u.status AS user_status
      FROM external_identities e JOIN users u ON u.id=e.user_id WHERE u.org_id=$1 AND e.tenant_key=$2 AND e.provider='FEISHU'
      ORDER BY u.display_name,e.id`,[orgId,tenant])).rows;
  }
  /** Reviewer explicitly selects an existing member; provider name never selects one. */
  async reviewAdmission(actor:AuthContext,id:string,body:{decision?:unknown;user_id?:unknown;reason?:unknown}) {
    const {orgId,tenant}=this.mapping();if(actor.orgId!==orgId)throw new ForbiddenException({code:'FEISHU_ORG_MISMATCH'});
    if(!body||typeof body!=='object')throw new BadRequestException({code:'FIELD_INVALID'});
    if(!UUID.test(id)||!['APPROVED','REJECTED'].includes(String(body.decision))||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500
      ||body.decision==='APPROVED'&&(typeof body.user_id!=='string'||!UUID.test(body.user_id)))throw new BadRequestException({code:'FIELD_INVALID'});
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      const ref=(await client.query('SELECT external_id FROM feishu_admission_requests WHERE id=$1 AND org_id=$2 AND tenant_key=$3',[id,orgId,tenant])).rows[0];
      if(!ref)throw new NotFoundException({code:'ADMISSION_NOT_FOUND'});
      await this.identityLock(client,tenant,ref.external_id);
      const request=(await client.query('SELECT * FROM feishu_admission_requests WHERE id=$1 AND org_id=$2 AND tenant_key=$3 FOR UPDATE',[id,orgId,tenant])).rows[0];
      if(request.status==='APPROVED'||body.decision==='REJECTED'&&request.status!=='PENDING')throw new ConflictException({code:'ADMISSION_ALREADY_REVIEWED'});
      if(body.decision==='APPROVED') {
        const user=(await client.query("SELECT id FROM users WHERE id=$1 AND org_id=$2 AND status='ACTIVE' FOR UPDATE",[body.user_id,orgId])).rows[0];
        if(!user)throw new NotFoundException({code:'USER_NOT_FOUND'});
        const bound=(await client.query("SELECT id,user_id FROM external_identities WHERE provider='FEISHU' AND tenant_key=$1 AND external_id=$2 FOR UPDATE",[tenant,request.external_id])).rows[0];
        if(bound&&bound.user_id!==user.id)throw new ConflictException({code:'FEISHU_BINDING_CONFLICT'});
        const other=await client.query("SELECT id FROM external_identities WHERE user_id=$1 AND provider='FEISHU' AND tenant_key=$2 AND external_id<>$3 AND approved=true",[user.id,tenant,request.external_id]);
        if(other.rowCount)throw new ConflictException({code:'FEISHU_ACCOUNT_ALREADY_BOUND'});
        if(bound)await client.query('UPDATE external_identities SET approved=true WHERE id=$1',[bound.id]);
        else await client.query("INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU',$2,$3,true)",[user.id,tenant,request.external_id]);
      }
      await client.query(`UPDATE feishu_admission_requests SET status=$2,approved_user_id=CASE WHEN $2='APPROVED' THEN $3::uuid ELSE approved_user_id END,
        reviewed_by=$4,review_reason=$5,reviewed_at=now() WHERE id=$1`,[id,body.decision,body.decision==='APPROVED'?body.user_id:null,actor.userId,body.reason.trim()]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason)
        VALUES($1,$2,'auth.feishu.admission.review','feishu_admission_request',$3,$4)`,[orgId,actor.userId,id,JSON.stringify({decision:body.decision,userId:body.decision==='APPROVED'?body.user_id:null,reason:body.reason.trim()})]);
      await client.query('COMMIT');return {id,status:body.decision};
    }catch(e){await client.query('ROLLBACK');if((e as {code?:string}).code==='23505')throw new ConflictException({code:'FEISHU_BINDING_CONFLICT'});throw e;}finally{client.release();}
  }

  /** Reused by batch prebinding within its caller-owned transaction. */
  async bindInTransaction(client:PoolClient,actor:AuthContext,body:{user_id?:unknown;external_id?:unknown;reason?:unknown}) {
    const {tenant,orgId}=this.mapping();
    if(actor.orgId!==orgId)throw new ForbiddenException({code:'FEISHU_ORG_MISMATCH'});
    if(typeof body.user_id!=='string'||!UUID.test(body.user_id)||typeof body.external_id!=='string'||!/^ou_[A-Za-z0-9_-]{1,128}$/.test(body.external_id)||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500)
      throw new BadRequestException({code:'FIELD_INVALID'});
      await this.identityLock(client,tenant,body.external_id);
      const user=await client.query("SELECT id FROM users WHERE id=$1 AND org_id=$2 AND status='ACTIVE' FOR UPDATE",[body.user_id,orgId]);
      if(!user.rowCount)throw new NotFoundException({code:'USER_NOT_FOUND'});
      const other=await client.query("SELECT id FROM external_identities WHERE user_id=$1 AND provider='FEISHU' AND tenant_key=$2 AND external_id<>$3 AND approved=true",[body.user_id,tenant,body.external_id]);
      if(other.rowCount)throw new ConflictException({code:'FEISHU_ACCOUNT_ALREADY_BOUND'});
      const existing=await client.query("SELECT id,user_id FROM external_identities WHERE provider='FEISHU' AND tenant_key=$1 AND external_id=$2 FOR UPDATE",[tenant,body.external_id]);
      if(existing.rowCount&&existing.rows[0].user_id!==body.user_id)throw new ConflictException({code:'FEISHU_BINDING_CONFLICT'});
      let id=existing.rows[0]?.id;
      if(id)await client.query('UPDATE external_identities SET approved=true WHERE id=$1',[id]);
      else {
        const created=await client.query(`INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved)
          VALUES($1,'FEISHU',$2,$3,true) ON CONFLICT DO NOTHING RETURNING id`,[body.user_id,tenant,body.external_id]);
        if(!created.rowCount)throw new ConflictException({code:'FEISHU_BINDING_CONFLICT'});id=created.rows[0].id;
      }
      await client.query(`UPDATE feishu_admission_requests SET status='APPROVED',approved_user_id=$1,reviewed_by=$2,
        review_reason=$3,reviewed_at=now() WHERE org_id=$4 AND tenant_key=$5 AND external_id=$6 AND provider='FEISHU'`,
        [body.user_id,actor.userId,body.reason.trim(),orgId,tenant,body.external_id]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'auth.feishu.bind','external_identity',$3,$4)`,[orgId,actor.userId,id,body.reason.trim()]);
    return {id,approved:true};
  }
  async bind(actor:AuthContext,body:{user_id?:unknown;external_id?:unknown;reason?:unknown}) {
    const client=await this.db.connect();
    try{await client.query('BEGIN');const result=await this.bindInTransaction(client,actor,body);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');if((error as {code?:string}).code==='23505')throw new ConflictException({code:'FEISHU_BINDING_CONFLICT'});throw error;}
    finally{client.release();}
  }
  async revoke(actor:AuthContext,id:string) {
    if(!UUID.test(id))throw new NotFoundException({code:'BINDING_NOT_FOUND'});
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      const reference=(await client.query("SELECT e.tenant_key,e.external_id FROM external_identities e JOIN users u ON u.id=e.user_id WHERE e.id=$1 AND u.org_id=$2 AND e.provider='FEISHU'",[id,actor.orgId])).rows[0];
      if(!reference)throw new NotFoundException({code:'BINDING_NOT_FOUND'});
      await this.identityLock(client,reference.tenant_key,reference.external_id);
      const identity=await client.query(`SELECT e.user_id FROM external_identities e JOIN users u ON u.id=e.user_id
        WHERE e.id=$1 AND u.org_id=$2 AND e.provider='FEISHU' FOR UPDATE OF e`,[id,actor.orgId]);
      if(!identity.rowCount)throw new NotFoundException({code:'BINDING_NOT_FOUND'});
      await client.query('UPDATE external_identities SET approved=false WHERE id=$1',[id]);
      await client.query("UPDATE feishu_admission_requests SET status='REVOKED',reviewed_by=$1,reviewed_at=now(),review_reason='管理员撤销绑定' WHERE org_id=$2 AND tenant_key=$3 AND external_id=$4 AND provider='FEISHU'",[actor.userId,actor.orgId,reference.tenant_key,reference.external_id]);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL',[identity.rows[0].user_id,actor.orgId]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id) VALUES($1,$2,'auth.feishu.revoke','external_identity',$3)`,[actor.orgId,actor.userId,id]);
      await client.query('COMMIT');return {id,approved:false};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
}
