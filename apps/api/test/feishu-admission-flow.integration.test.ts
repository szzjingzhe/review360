import '../../../scripts/test-db-setup.cjs';
import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import {ConfigService} from '@nestjs/config';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {AppModule} from '../src/app.module';
import {FeishuService} from '../src/auth/feishu.service';
import {SessionService} from '../src/auth/session.service';
let db:Pool,app:any,base:string,adminCookie:string,memberCookie:string,localAdminCookie:string;
const org=randomUUID(),otherOrg=randomUUID(),dept=randomUUID(),guidance=randomUUID(),tenant='admission-'+randomUUID();
const ids={admin:randomUUID(),member:randomUUID(),head:randomUUID(),viewer:randomUUID(),disabled:randomUUID(),second:randomUUID(),localAdmin:randomUUID(),outsider:randomUUID()};
let provider={tenant_key:tenant,open_id:'ou_'+randomUUID().replaceAll('-',''),name:'同名也不能自动匹配'};
async function req(path:string,method='GET',body?:unknown,cookie?:string){const r=await fetch(base+path,{method,redirect:'manual',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});let json:any;try{json=await r.json();}catch{}return {status:r.status,json,cookies:r.headers.getSetCookie(),location:r.headers.get('location')};}
async function oauth(){const start=await req('/auth/feishu/start');expect(start.status).toBe(302);const state=new URL(start.location!).searchParams.get('state');const cookie=start.cookies.find(c=>c.startsWith('s360_feishu_state='))!.split(';')[0];return req('/auth/feishu/callback?code=isolated-test&state='+state,'GET',undefined,cookie);}
function freshExternal(){return 'ou_'+randomUUID().replaceAll('-','');}
beforeAll(async()=>{
 db=new Pool({connectionString:process.env.DATABASE_URL});
 for(const [id,name] of [[org,'隔离准入测试'],[otherOrg,'隔离其他组织']])await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,$2,'Asia/Shanghai')",[id,name]);
 for(const [key,id] of Object.entries(ids))await db.query('INSERT INTO users(id,org_id,display_name,status) VALUES($1,$2,$3,$4)',[id,key==='outsider'?otherOrg:org,'测试身份-'+key,key==='disabled'?'DISABLED':'ACTIVE']);
 for(const [id,code,name] of [[dept,'TEST','测试部'],[guidance,'GUIDANCE','指导组']])await db.query('INSERT INTO departments(id,org_id,code,name) VALUES($1,$2,$3,$4)',[id,org,code,name]);
 for(const key of ['member','head','viewer'] as const)await db.query('INSERT INTO department_memberships(org_id,user_id,department_id,valid_from) VALUES($1,$2,$3,current_date)',[org,ids[key],key==='viewer'?guidance:dept]);
 await db.query("INSERT INTO appointments(org_id,user_id,role,scope_dept_id,valid_from) VALUES($1,$2,'HEAD',$3,current_date)",[org,ids.head,dept]);
 for(const [key,cap,scope,scopeId] of [['admin','org.manage','ORG',null],['admin','workspace.oversight','ORG',null],['head','progress.read','DEPARTMENT',dept],['viewer','result.read_published','ORG',null],['localAdmin','org.manage','DEPARTMENT',dept]])await db.query('INSERT INTO capability_grants(org_id,user_id,capability,scope_type,scope_id) VALUES($1,$2,$3,$4,$5)',[org,ids[key as keyof typeof ids],cap,scope,scopeId]);
 const config=new ConfigService({...process.env,APP_ENV:'production',APP_ORIGIN:'https://review.test',FEISHU_REDIRECT_URI:'https://review.test/api/v1/auth/feishu/callback',ALLOW_INSECURE_HTTP_ORIGIN:'',FEISHU_TENANT_KEY:tenant,FEISHU_ORG_ID:org});
 const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(ConfigService).useValue(config).overrideProvider(FeishuService).useValue({enabled:()=>true,authorizeUrl:(state:string)=>'https://example.invalid/?state='+state,exchange:async()=>provider}).compile();
 app=module.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api/v1';
 const sessions=app.get(SessionService);adminCookie='s360_session='+await sessions.createSession(ids.admin,org);memberCookie='s360_session='+await sessions.createSession(ids.member,org);localAdminCookie='s360_session='+await sessions.createSession(ids.localAdmin,org);
});
afterAll(async()=>{if(app)await app.close();if(db){
 // Audit events are append-only. Keep this random synthetic fixture and its audit
 // history in the disposable test database; revoke only its test sessions.
 await db.query('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE org_id=$1',[org]);
 await db.end();}});

it('new in-tenant identity is automatically bound to a persistent result-only viewer, never an application',async()=>{
 const name=provider.name,external=provider.open_id;const r=await oauth();expect(r.location).toBe('/');const cookie=r.cookies.find(c=>/^s360_session=[^;]/.test(c))!.split(';')[0];const me=(await req('/me','GET',undefined,cookie)).json.data;expect(me.isResultViewer).toBe(true);expect(me.department).toBeNull();expect(me.appointments).toEqual([]);expect(me.capabilities.map((g:any)=>g.capability)).toEqual(['result.read_published']);
 expect((await req('/published-results','GET',undefined,cookie)).status).toBe(200);for(const path of ['/cycles','/organization','/organization/members','/me/results','/calibration-cases','/auth/feishu/bindings'])expect((await req(path,'GET',undefined,cookie)).status).toBe(403);expect((await req('/cycles','POST',{},cookie)).status).toBe(403);
 await Promise.all([oauth(),oauth()]);expect((await db.query('SELECT 1 FROM external_identities WHERE tenant_key=$1 AND external_id=$2',[tenant,external])).rowCount).toBe(1);expect((await db.query('SELECT 1 FROM users WHERE org_id=$1 AND display_name=$2',[org,name])).rowCount).toBe(1);expect((await db.query('SELECT 1 FROM feishu_admission_requests WHERE org_id=$1',[org])).rowCount).toBe(0);
});
it('an unbound existing member matches the unique exact OAuth name and preserves its original account',async()=>{
 provider={tenant_key:tenant,open_id:freshExternal(),name:'测试身份-second'};const r=await oauth();expect(r.location).toBe('/');const cookie=r.cookies.find(c=>/^s360_session=[^;]/.test(c))!.split(';')[0];const me=(await req('/me','GET',undefined,cookie)).json.data;expect(me.user.id).toBe(ids.second);expect(me.isResultViewer).toBe(false);expect(me.capabilities).toEqual([]);expect((await db.query('SELECT user_id FROM external_identities WHERE external_id=$1',[provider.open_id])).rows[0].user_id).toBe(ids.second);
 const original=provider;provider={...original,open_id:freshExternal()};expect((await oauth()).status).toBe(409);provider=original;
});
it('disabled exact-name candidates and ambiguous names are not converted into viewers',async()=>{
 provider={tenant_key:tenant,open_id:freshExternal(),name:'测试身份-disabled'};expect((await oauth()).status).toBe(401);
 for(let i=0;i<2;i++)await db.query("INSERT INTO users(id,org_id,display_name) VALUES($1,$2,'隔离重名')",[randomUUID(),org]);provider={tenant_key:tenant,open_id:freshExternal(),name:'隔离重名'};expect((await oauth()).status).toBe(409);expect((await db.query('SELECT 1 FROM external_identities WHERE external_id=$1',[provider.open_id])).rowCount).toBe(0);
});
it('removed application endpoints cannot inspect receipts, queue or approve applications',async()=>{
 for(const [path,method] of [['/auth/feishu/admission-status','GET'],['/auth/feishu/admissions','GET'],['/auth/feishu/admissions/'+randomUUID()+'/review','POST']])expect((await req(path,method,method==='POST'?{}:undefined,adminCookie)).status).toBe(404);
});
it('wrong tenant and invalid state remain denied and never generate applications',async()=>{
 const original=provider;provider={...original,tenant_key:'foreign'};expect((await oauth()).status).toBe(401);provider=original;expect((await req('/auth/feishu/callback?code=x&state=invalid')).status).toBe(401);expect((await db.query('SELECT 1 FROM feishu_admission_requests WHERE org_id=$1',[org])).rowCount).toBe(0);
});
it('prebound member logs in directly, retains department and permissions, and revocation invalidates the session',async()=>{
 provider={tenant_key:tenant,open_id:freshExternal(),name:'not-used-for-binding'};expect((await req('/auth/feishu/bindings','POST',{user_id:ids.member,external_id:provider.open_id,reason:'独立核实后预绑定'},adminCookie)).status).toBe(201);
 const response=await oauth();expect(response.location).toBe('/');const cookie=response.cookies.find(c=>/^s360_session=[^;]/.test(c))!.split(';')[0];const me=(await req('/me','GET',undefined,cookie)).json.data;expect(me.user.id).toBe(ids.member);expect(me.department.dept_id).toBe(dept);expect(me.capabilities).toEqual([]);
 const binding=(await db.query('SELECT id FROM external_identities WHERE user_id=$1',[ids.member])).rows[0];expect((await req('/auth/feishu/bindings/'+binding.id+'/revoke','POST',{},adminCookie)).status).toBe(200);expect((await req('/me','GET',undefined,cookie)).status).toBe(401);expect((await oauth()).location).toBe('/login?error=FEISHU_ACCOUNT_UNLINKED');
});
it('existing head, guidance and admin identities retain exact database access after direct OAuth',async()=>{
 for(const key of ['head','viewer','admin'] as const){provider={tenant_key:tenant,open_id:freshExternal(),name:'测试身份-'+key};if(key!=='head')await db.query("INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU',$2,$3,true)",[ids[key],tenant,provider.open_id]);const r=await oauth();expect(r.location).toBe('/');const cookie=r.cookies.find(c=>/^s360_session=[^;]/.test(c))!.split(';')[0];const me=(await req('/me','GET',undefined,cookie)).json.data;expect(me.user.id).toBe(ids[key]);if(key==='head')expect(me.capabilities).toContainEqual(expect.objectContaining({capability:'progress.read',scope_type:'DEPARTMENT',scope_id:dept}));if(key==='viewer'){expect(me.isGuidance).toBe(true);expect(me.capabilities.map((g:any)=>g.capability)).toEqual(['result.read_published']);}if(key==='admin')expect(me.capabilities.map((g:any)=>g.capability)).toContain('org.manage');}
});
it('disabled and foreign-organization identities cannot get sessions or generate applications',async()=>{
 for(const key of ['disabled','outsider'] as const){provider={tenant_key:tenant,open_id:freshExternal(),name:key};await db.query("INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU',$2,$3,true)",[ids[key],tenant,provider.open_id]);const r=await oauth();expect(r.status).toBe(401);expect(r.json.code).toBe('FEISHU_ACCOUNT_UNAVAILABLE');expect(r.cookies.some(c=>/^s360_session=[^;]/.test(c))).toBe(false);}
});
it.skipIf(process.env.ADMISSION_BROWSER!=='1')('browser: legacy application links show no approval flow; admin has prebinding and revoke only',async()=>{
 const {createRequire}=await import('node:module');const {chromium}=createRequire(import.meta.url)(process.env.ADMISSION_PLAYWRIGHT!);const browser=await chromium.launch({channel:'msedge',headless:true});
 try{const ctx=await browser.newContext();const page=await ctx.newPage();page.setDefaultTimeout(15000);let statusCalls=0;
 await page.route('http://127.0.0.1:43773/api/v1/**',async(route:any)=>{const u=new URL(route.request().url());if(u.pathname.includes('admission'))statusCalls++;const response=await route.fetch({url:base+u.pathname.slice('/api/v1'.length)+u.search});await route.fulfill({response});});
 await page.goto('http://127.0.0.1:43773/login?admission=1');await page.getByText('账号尚未关联，请联系管理员',{exact:true}).waitFor();expect(await page.getByText('刷新申请状态',{exact:true}).count()).toBe(0);expect(await page.getByText(/等待管理员核实/).count()).toBe(0);expect(statusCalls).toBe(0);
 provider={tenant_key:tenant,open_id:freshExternal(),name:'隔离仅结果访客'};const visitor=await oauth();const visitorCookie=visitor.cookies.find(c=>/^s360_session=[^;]/.test(c))!.split(';')[0];await ctx.addCookies([{name:'s360_session',value:visitorCookie.split('=')[1],domain:'127.0.0.1',path:'/'}]);await page.goto('http://127.0.0.1:43773/');await page.waitForURL('**/published-results');await page.getByRole('heading',{name:'已发布结果',exact:true}).waitFor();expect(await page.getByRole('link',{name:'我的自评',exact:true}).count()).toBe(0);expect(await page.getByRole('link',{name:'组织架构',exact:true}).count()).toBe(0);await page.goto('http://127.0.0.1:43773/cycles');await page.waitForURL('**/published-results');
 await ctx.addCookies([{name:'s360_session',value:adminCookie.split('=')[1],domain:'127.0.0.1',path:'/'}]);await page.goto('http://127.0.0.1:43773/user-management');await page.getByRole('heading',{name:'飞书账号批量预绑定',exact:true}).waitFor();await page.getByRole('heading',{name:'飞书身份绑定管理',exact:true}).waitFor();expect(await page.getByLabel('申请状态').count()).toBe(0);expect(await page.getByRole('button',{name:'确认批准绑定',exact:true}).count()).toBe(0);expect(statusCalls).toBe(0);
 }finally{await browser.close();}
},30000);
