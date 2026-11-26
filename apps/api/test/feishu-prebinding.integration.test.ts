import '../../../scripts/test-db-setup.cjs';
import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import {ConfigService} from '@nestjs/config';
import {ConflictException,ServiceUnavailableException} from '@nestjs/common';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {AppModule} from '../src/app.module';
import {FeishuService} from '../src/auth/feishu.service';
import {SessionService} from '../src/auth/session.service';
import {FeishuAdmissionService} from '../src/auth/feishu-admission.service';
let db:Pool,app:any,base:string,adminCookie:string,memberCookie:string,localAdminCookie:string;
const org=randomUUID(),otherOrg=randomUUID(),dept=randomUUID(),admin=randomUUID(),member=randomUUID(),localAdmin=randomUUID(),outsider=randomUUID(),tenant='batch-'+randomUUID(),appId='cli_test_'+randomUUID();
let provider:any;let contacts:any[]=[];let sourceTenant=tenant,sourceFailure=false;
const readDirectory=vi.fn(async()=>{if(sourceFailure)throw new ServiceUnavailableException({code:'FEISHU_DIRECTORY_UNAVAILABLE'});return {tenantKey:sourceTenant,appId,visibility:{state:'ADMIN_CONFIRMATION_REQUIRED',providerCode:99991672},users:contacts};});
const fullBody=(itemIds:string[])=>({itemIds,visibilityConfirmed:true,visibilityEvidence:'管理员已在飞书后台核实本批可用范围（隔离测试）'});
async function request(path:string,method='GET',body?:unknown,cookie=adminCookie){const r=await fetch(base+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});let json:any;try{json=await r.json();}catch{}return {status:r.status,json,cookies:r.headers.getSetCookie(),location:r.headers.get('location')};}
async function createMember(name='批量测试-'+randomUUID()){const id=randomUUID(),openId='ou_'+randomUUID().replaceAll('-','');await db.query('INSERT INTO users(id,org_id,display_name) VALUES($1,$2,$3)',[id,org,name]);await db.query('INSERT INTO department_memberships(org_id,user_id,department_id,valid_from) VALUES($1,$2,$3,current_date)',[org,id,dept]);contacts.push({openId,userId:'staff_'+randomUUID(),name,departmentNames:['飞书测试部'],active:true});return {id,openId,name};}
async function preview(){const r=await request('/auth/feishu/prebindings/preview','POST',{});expect(r.status).toBe(201);return r.json.data;}
function itemFor(b:any,id:string){return b.items.find((i:any)=>i.user_id===id);}
async function verify(b:any,id:string,evidence='已核对可信名册及独立渠道身份'){const item=itemFor(b,id);const r=await request(`/auth/feishu/prebindings/${b.id}/items/${item.id}/verification`,'PUT',{confirmed:true,openId:item.candidates_json[0]?.openId,evidence});expect(r.status).toBe(200);return r.json.data;}
async function oauth(){const s=await request('/auth/feishu/start','GET',undefined,'');const state=new URL(s.location!).searchParams.get('state'),cookie=s.cookies.find(c=>c.startsWith('s360_feishu_state='))!.split(';')[0];return request('/auth/feishu/callback?code=isolated&state='+state,'GET',undefined,cookie);}
beforeAll(async()=>{
 db=new Pool({connectionString:process.env.DATABASE_URL});for(const [id,name] of [[org,'隔离批量预绑定组织'],[otherOrg,'隔离外部组织']])await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,$2,'Asia/Shanghai')",[id,name]);
 for(const [id,oid,name] of [[admin,org,'批量管理员'],[member,org,'普通测试身份'],[localAdmin,org,'部门测试管理员'],[outsider,otherOrg,'外部测试身份']])await db.query('INSERT INTO users(id,org_id,display_name) VALUES($1,$2,$3)',[id,oid,name]);
 await db.query("INSERT INTO departments(id,org_id,code,name) VALUES($1,$2,'TEST','内部测试部')",[dept,org]);
 for(const [id,scope,sid] of [[admin,'ORG',null],[localAdmin,'DEPARTMENT',dept]])await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type,scope_id) VALUES($1,$2,'org.manage',$3,$4)",[org,id,scope,sid]);
 const config=new ConfigService({...process.env,APP_ENV:'production',APP_ORIGIN:'https://review.test',FEISHU_REDIRECT_URI:'https://review.test/api/v1/auth/feishu/callback',ALLOW_INSECURE_HTTP_ORIGIN:'',FEISHU_TENANT_KEY:tenant,FEISHU_ORG_ID:org,FEISHU_APP_ID:appId});
 const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(ConfigService).useValue(config).overrideProvider(FeishuService).useValue({enabled:()=>true,authorizeUrl:(state:string)=>'https://example.invalid/?state='+state,exchange:async()=>provider,readDirectory}).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api/v1';
 const sessions=app.get(SessionService);adminCookie='s360_session='+await sessions.createSession(admin,org);memberCookie='s360_session='+await sessions.createSession(member,org);localAdminCookie='s360_session='+await sessions.createSession(localAdmin,org);
});
afterAll(async()=>{if(app)await app.close();if(db){await db.query('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE org_id=$1',[org]);await db.end();}});
it('read-only candidate generation never approves same-name candidates or changes members, departments or existing bindings',async()=>{
 const fresh=await createMember(),bound=await createMember();await db.query("INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU',$2,$3,true)",[bound.id,tenant,bound.openId]);
 const b=await preview();expect(itemFor(b,fresh.id)).toMatchObject({match_status:'PENDING_VERIFICATION',verified_by:null,verified_open_id:null});expect(itemFor(b,bound.id).match_status).toBe('BOUND');
 expect((await db.query('SELECT 1 FROM external_identities WHERE user_id=$1',[fresh.id])).rowCount).toBe(0);expect((await db.query('SELECT department_id FROM department_memberships WHERE user_id=$1 AND valid_to IS NULL',[fresh.id])).rows[0].department_id).toBe(dept);
 const r=await request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',fullBody([itemFor(b,fresh.id).id]));expect(r.status).toBe(409);expect(r.json.detail.items[0].code).toBe('VERIFICATION_REQUIRED');expect(r.json.detail.committed).toBe(false);
});
it('only organization administrators may query, verify or import; missing and false verification remain ineligible',async()=>{
 const m=await createMember(),b=await preview(),item=itemFor(b,m.id),before=readDirectory.mock.calls.length;
 for(const cookie of [memberCookie,localAdminCookie]){expect((await request('/auth/feishu/prebindings','GET',undefined,cookie)).status).toBe(403);expect((await request('/auth/feishu/prebindings/preview','POST',{},cookie)).status).toBe(403);expect((await request(`/auth/feishu/prebindings/${b.id}/items/${item.id}/verification`,'PUT',{confirmed:true,openId:m.openId,evidence:'越权'},cookie)).status).toBe(403);expect((await request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',fullBody([item.id]),cookie)).status).toBe(403);}
 expect(readDirectory.mock.calls.length).toBe(before);expect((await request(`/auth/feishu/prebindings/${b.id}/items/${item.id}/verification`,'PUT',{confirmed:true,openId:m.openId,evidence:''})).status).toBe(400);
 expect((await request(`/auth/feishu/prebindings/${b.id}/items/${item.id}/verification`,'PUT',{confirmed:true,openId:'ou_not_the_candidate',evidence:'不能伪造候选'})).status).toBe(409);
});
it('verified binding succeeds, fresh OAuth uses the existing account and keeps department/role/capabilities; retries do not duplicate imports',async()=>{
 const m=await createMember();await db.query("INSERT INTO appointments(org_id,user_id,role,scope_dept_id,valid_from) VALUES($1,$2,'HEAD',$3,current_date)",[org,m.id,dept]);await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type,scope_id) VALUES($1,$2,'progress.read','DEPARTMENT',$3)",[org,m.id,dept]);
 let b=await preview();b=await verify(b,m.id,'已由管理员核实学号名册和成员本人 '+ '核'.repeat(450));const id=itemFor(b,m.id).id;
 const first=await request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',fullBody([id]));expect(first.status).toBe(201);expect(first.json.data).toMatchObject({committed:true,items:[{itemId:id,userId:m.id,status:'BOUND'}]});
 const retried=await request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',fullBody([id]));expect(retried.json.data.replayed).toBe(true);expect((await db.query('SELECT count(*)::int n FROM external_identities WHERE user_id=$1',[m.id])).rows[0].n).toBe(1);
 expect((await request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',fullBody([randomUUID()]))).status).toBe(409);
 provider={tenant_key:tenant,open_id:m.openId,name:'改名也不改内部身份'};const login=await oauth();expect(login.location).toBe('/');const cookie=login.cookies.find(c=>/^s360_session=[^;]/.test(c))!.split(';')[0];const me=(await request('/me','GET',undefined,cookie)).json.data;expect(me.user.id).toBe(m.id);expect(me.department.dept_id).toBe(dept);expect(me.appointments[0].role).toBe('HEAD');expect(me.capabilities.map((g:any)=>g.capability)).toEqual(['progress.read']);
 const binding=(await db.query('SELECT id FROM external_identities WHERE user_id=$1',[m.id])).rows[0].id;expect((await request(`/auth/feishu/bindings/${binding}/revoke`,'POST',{})).status).toBe(200);expect((await request('/me','GET',undefined,cookie)).status).toBe(401);
});
it('an existing correct binding is not overwritten or duplicated even if created after preview',async()=>{
 const m=await createMember();let b=await preview();b=await verify(b,m.id);const item=itemFor(b,m.id);
 const existing=await request('/auth/feishu/bindings','POST',{user_id:m.id,external_id:m.openId,reason:'独立预绑定先完成'});expect(existing.status).toBe(201);const bindingId=existing.json.data.id;
 const applied=await request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',fullBody([item.id]));expect(applied.json.data.items[0].status).toBe('ALREADY_BOUND');expect((await db.query('SELECT id FROM external_identities WHERE user_id=$1',[m.id])).rows).toEqual([{id:bindingId}]);
});
it('one late conflicting identity rolls back the entire batch, returns per-record reasons, and permits a corrected safe retry',async()=>{
 const a=await createMember(),b=await createMember();let snapshot=await preview();snapshot=await verify(snapshot,a.id);snapshot=await verify(snapshot,b.id);const ia=itemFor(snapshot,a.id),ib=itemFor(snapshot,b.id);
 await db.query("INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU',$2,$3,true)",[outsider,tenant,b.openId]);
 const failed=await request(`/auth/feishu/prebindings/${snapshot.id}/submit`,'POST',fullBody([ia.id,ib.id]));expect(failed.status).toBe(409);expect(failed.json.detail.committed).toBe(false);expect(failed.json.detail.items).toContainEqual(expect.objectContaining({itemId:ia.id,status:'ROLLED_BACK'}));expect(failed.json.detail.items).toContainEqual(expect.objectContaining({itemId:ib.id,status:'FAILED',code:'FEISHU_BINDING_CONFLICT'}));expect((await db.query('SELECT 1 FROM external_identities WHERE user_id=$1',[a.id])).rowCount).toBe(0);
 expect((await request(`/auth/feishu/prebindings/${snapshot.id}`)).json.data.lastResult.committed).toBe(false);
 await request(`/auth/feishu/prebindings/${snapshot.id}/items/${ib.id}/verification`,'PUT',{confirmed:false});const retry=await request(`/auth/feishu/prebindings/${snapshot.id}/submit`,'POST',fullBody([ia.id]));expect(retry.json.data.committed).toBe(true);
});
it('known conflicts, ambiguous/missing names and inactive identities cannot be explicitly verified into a batch',async()=>{
 const conflict=await createMember(),ambiguous=await createMember(),inactive=await createMember(),missing=await createMember();contacts=contacts.filter(c=>c.openId!==missing.openId);contacts.find(c=>c.openId===inactive.openId)!.active=false;contacts.push({...contacts.find(c=>c.openId===ambiguous.openId),openId:'ou_'+randomUUID().replaceAll('-','')});
 // An identity bound in a different organization remains a conflict, not a candidate to transfer.
 const alien=randomUUID();await db.query("INSERT INTO users(id,org_id,display_name) VALUES($1,$2,'隔离冲突账号')",[alien,otherOrg]);await db.query("INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU',$2,$3,true)",[alien,tenant,conflict.openId]);
 const b=await preview();for(const [m,status] of [[conflict,'CONFLICT'],[ambiguous,'AMBIGUOUS'],[inactive,'INACTIVE'],[missing,'UNMATCHED']] as const){const item=itemFor(b,m.id);expect(item.match_status).toBe(status);expect((await request(`/auth/feishu/prebindings/${b.id}/items/${item.id}/verification`,'PUT',{confirmed:true,openId:m.openId,evidence:'不能越过异常状态'})).status).toBe(409);}
});
it('directory failure, tenant mismatch, expired snapshot and unconfirmed app visibility fail closed',async()=>{
 const m=await createMember();sourceFailure=true;expect((await request('/auth/feishu/prebindings/preview','POST',{})).status).toBe(503);sourceFailure=false;sourceTenant='wrong-tenant';expect((await request('/auth/feishu/prebindings/preview','POST',{})).status).toBe(409);sourceTenant=tenant;
 let b=await preview();b=await verify(b,m.id);const item=itemFor(b,m.id);expect((await request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',{itemIds:[item.id]})).json.code).toBe('APP_VISIBILITY_CONFIRMATION_REQUIRED');
 await db.query("UPDATE feishu_prebinding_batches SET expires_at=now()-interval '1 second' WHERE id=$1",[b.id]);expect((await request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',fullBody([item.id]))).json.code).toBe('PREBINDING_EXPIRED');
 expect((await request('/auth/feishu/prebindings/'+randomUUID())).status).toBe(404);
});
it('simultaneous submissions of the same verified batch commit once and replay the same result',async()=>{
 const m=await createMember();let b=await preview();b=await verify(b,m.id);const item=itemFor(b,m.id);const responses=await Promise.all([1,2].map(()=>request(`/auth/feishu/prebindings/${b.id}/submit`,'POST',fullBody([item.id]))));expect(responses.every(r=>r.status===201&&r.json.data.committed)).toBe(true);expect(responses.some(r=>r.json.data.replayed)).toBe(true);expect((await db.query('SELECT count(*)::int n FROM external_identities WHERE user_id=$1',[m.id])).rows[0].n).toBe(1);
});
it('a conflict during the second insertion rolls back the first binding and its success audit',async()=>{
 const a=await createMember(),b=await createMember();let batch=await preview();batch=await verify(batch,a.id);batch=await verify(batch,b.id);
 const binder=app.get(FeishuAdmissionService),original=binder.bindInTransaction.bind(binder);let count=0;
 const spy=vi.spyOn(binder,'bindInTransaction').mockImplementation(async(...args:any[])=>{if(++count===2)throw new ConflictException({code:'FEISHU_BINDING_CONFLICT'});return original(...args);});
 try{const response=await request(`/auth/feishu/prebindings/${batch.id}/submit`,'POST',fullBody([itemFor(batch,a.id).id,itemFor(batch,b.id).id]));expect(response.status).toBe(409);expect(response.json.detail.items.map((r:any)=>r.status).sort()).toEqual(['FAILED','ROLLED_BACK']);
  expect((await db.query('SELECT 1 FROM external_identities WHERE user_id=ANY($1::uuid[])',[[a.id,b.id]])).rowCount).toBe(0);
  expect((await db.query("SELECT 1 FROM audit_events WHERE org_id=$1 AND action='auth.feishu.bind' AND reason LIKE $2",[org,'%'+batch.id+'%'])).rowCount).toBe(0);
 }finally{spy.mockRestore();}
});
it.skipIf(process.env.ADMISSION_BROWSER!=='1')('browser: new candidates are unchecked, administrator verifies explicitly and imports with per-record results',async()=>{
 const {createRequire}=await import('node:module');const {chromium}=createRequire(import.meta.url)(process.env.ADMISSION_PLAYWRIGHT!);
 const m=await createMember('隔离浏览器预绑定成员');const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const ctx=await browser.newContext({viewport:{width:1500,height:1000}});await ctx.addCookies([{name:'s360_session',value:adminCookie.split('=')[1],domain:'127.0.0.1',path:'/'}]);
  const page=await ctx.newPage();page.setDefaultTimeout(15000);
  await page.route('http://127.0.0.1:43773/api/v1/**',async(route:any)=>{const url=new URL(route.request().url());const response=await route.fetch({url:base+url.pathname.slice('/api/v1'.length)+url.search});await route.fulfill({response});});
  await page.goto('http://127.0.0.1:43773/user-management');const panel=page.locator('.prebinding-panel');
  await panel.getByRole('button',{name:'生成新的候选清单',exact:true}).click();const row=panel.locator('tbody tr').filter({hasText:m.id});
  const confirmation=row.getByRole('checkbox');await confirmation.waitFor();expect(await confirmation.isChecked()).toBe(false);
  const submit=panel.getByRole('button',{name:'提交已核实绑定',exact:true});expect(await submit.isEnabled()).toBe(false);
  await confirmation.check();await row.getByRole('textbox').fill('独立测试名册及本人核实，不按同名自动批准');await row.getByRole('button',{name:'保存核实',exact:true}).click();await row.getByText('核实人：',{exact:false}).waitFor();
  expect(await submit.isEnabled()).toBe(false);await panel.getByRole('checkbox',{name:'已在飞书后台核实本次提交成员的应用可用范围'}).check();await panel.getByRole('textbox',{name:'应用可用范围核查依据'}).fill('专用测试身份在测试应用授权范围内');await submit.click();
  await panel.getByRole('heading',{name:'批次已完成',exact:true}).waitFor();expect(await panel.locator('li').filter({hasText:'隔离浏览器预绑定成员：BOUND'}).count()).toBe(1);
  expect((await db.query('SELECT count(*)::int n FROM external_identities WHERE user_id=$1 AND approved',[m.id])).rows[0].n).toBe(1);
 }finally{await browser.close();}
},45000);
