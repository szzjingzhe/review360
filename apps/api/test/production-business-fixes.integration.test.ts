import '../../../scripts/test-db-setup.cjs';
import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {AppModule} from '../src/app.module';
import {SessionService} from '../src/auth/session.service';
const org=randomUUID(),admin=randomUUID(),viewer=randomUUID(),depts=[randomUUID(),randomUUID()],people=Array.from({length:14},()=>randomUUID()),rules=randomUUID();
let db:Pool,app:any,base:string,cycle:string,otherCycle:string;const cookies=new Map<string,string>();const previous=process.env.REPORT_STORAGE_DIR;
async function req(path:string,method='GET',body?:any,user=admin,key?:string){const form=body instanceof FormData;const r=await fetch(base+path,{method,headers:{cookie:cookies.get(user)!,...(!form&&body!==undefined?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},body:body===undefined?undefined:form?body:JSON.stringify(body)});const j:any=await r.json();return {status:r.status,data:j.data,json:j};}
async function ok(path:string,method='GET',body?:any,user=admin,key?:string){const r=await req(path,method,body,user,key);expect(r.status,JSON.stringify(r.json)).toBeLessThan(300);return r.data;}
beforeAll(async()=>{
 db=new Pool({connectionString:process.env.DATABASE_URL});await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'完整链路隔离组织','Asia/Shanghai')",[org]);
 for(const [id,name] of [[admin,'隔离月报总负责人'],[viewer,'隔离结果监管'],...people.map((id,i)=>[id,'链路成员'+i])])await db.query('INSERT INTO users(id,org_id,display_name) VALUES($1,$2,$3)',[id,org,name]);
 for(let i=0;i<2;i++){await db.query('INSERT INTO departments(id,org_id,code,name) VALUES($1,$2,$3,$4)',[depts[i],org,'D'+i,'测试部门'+i]);for(const id of people.slice(i*7,i*7+7))await db.query('INSERT INTO department_memberships(org_id,user_id,department_id,valid_from) VALUES($1,$2,$3,current_date)',[org,id,depts[i]]);await db.query("INSERT INTO appointments(org_id,user_id,role,scope_dept_id,valid_from) VALUES($1,$2,'HEAD',$3,current_date)",[org,people[i*7],depts[i]]);}
 await db.query("INSERT INTO appointments(org_id,user_id,role,valid_from) VALUES($1,$2,'SUPERVISOR',current_date)",[org,admin]);
 for(const cap of ['cycle.manage','assignment.manage','calibration.resolve','calibration.read_raw','result.confirm','result.publish','result.read_published','progress.read','award.manage','feedback.manage','report.view'])await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type) VALUES($1,$2,$3,'ORG')",[org,admin,cap]);
 await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type) VALUES($1,$2,'result.read_published','ORG')",[org,viewer]);
 for(const cap of ['assignment.manage','progress.read','result.read_published'])await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type,scope_id) VALUES($1,$2,$3,'DEPARTMENT',$4)",[org,people[0],cap,depts[0]]);
 await db.query("INSERT INTO rulesets(id,org_id,version,status,config_json,checksum) VALUES($1,$2,1,'FROZEN','{}','isolated-core')",[rules,org]);
 for(const role of ['HEAD','MEMBER','SELF']){const tid=randomUUID();await db.query('INSERT INTO template_versions(id,org_id,ruleset_id,role_code,name) VALUES($1,$2,$3,$4,$4)',[tid,org,rules,role]);for(let i=0;i<4;i++)await db.query('INSERT INTO template_items(id,org_id,template_id,code,label,weight,position) VALUES($1,$2,$3,$4,$4,25,$5)',[randomUUID(),org,tid,'配置维度'+i,i]);}
 process.env.REPORT_STORAGE_DIR=await mkdtemp(join(tmpdir(),'360-core-'));
 const m=await Test.createTestingModule({imports:[AppModule]}).compile();app=m.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api/v1';for(const id of [admin,viewer,...people])cookies.set(id,'s360_session='+await app.get(SessionService).createSession(id,org));
});
afterAll(async()=>{if(app)await app.close();if(db){await db.query('UPDATE sessions SET revoked_at=now() WHERE org_id=$1',[org]);await db.end();}const {pool}=await import('../../worker/src/db');await pool.end();if(previous===undefined)delete process.env.REPORT_STORAGE_DIR;else process.env.REPORT_STORAGE_DIR=previous;});
let month=1;
async function opened(){const now=Date.now();const c=await ok('/cycles','POST',{month:`2071-${String(month++).padStart(2,'0')}`,title:'线上缺陷隔离回归',ruleset_id:rules,open_at:new Date(now-3600000).toISOString(),close_at:new Date(now+3600000).toISOString(),publish_at:new Date(now+7200000).toISOString()});const run=await ok(`/cycles/${c.id}/assignment/preview`,'POST',{});expect(run.feasible).toBe(true);await ok(`/cycles/${c.id}/submit`,'POST',{});await ok(`/cycles/${c.id}/open`,'POST',{run_id:run.id});return c.id;}
async function score(review:string,user:string,value=70,revision=false){const d=await ok('/reviews/'+review,'GET',undefined,user);return ok('/reviews/'+review+(revision?'/revision':'/submit'),'POST',{payload:{items:d.template.items.map((i:any)=>({itemId:i.id,score:value})),readConfirmed:true}},user,randomUUID());}
async function completed(){const c=await opened();for(const user of people){const self=await ok(`/cycles/${c}/self-review`,'POST',{},user);await score(self.reviewId,user,60);const tasks=await ok(`/cycles/${c}/assignments/me`,'GET',undefined,user);for(const task of tasks.peers)await score(task.review.id,user);}
await db.query("UPDATE cycles SET close_at=now()-interval '1 second' WHERE id=$1",[c]);await db.query("UPDATE cycle_phases SET planned_at=now()-interval '1 second' WHERE cycle_id=$1 AND phase='CLOSE'",[c]);const {executePhase}=await import('../../worker/src/phases/handlers');expect((await executePhase('CLOSE',c,new Date())).kind).toBe('EXECUTED');return c;}
async function publish(buildId:string){await ok('/result-builds/'+buildId+'/approve','POST',{decision:'APPROVED'});return ok('/result-builds/'+buildId+'/publish','POST',{});}

it('excluded roster does not block full publication; partial and published corrections preserve v1',async()=>{
 cycle=await completed();await db.query("INSERT INTO cycle_participants(cycle_id,org_id,user_id,dept_snapshot,role_snapshot,template_id,eligibility) SELECT cycle_id,org_id,$2,dept_snapshot,'MEMBER',template_id,'EXCLUDED' FROM cycle_participants WHERE cycle_id=$1 LIMIT 1",[cycle,viewer]);
 let builds=await ok(`/cycles/${cycle}/results/build`,'POST',{});await publish(builds.items[0].buildId);
 expect((await db.query('SELECT status FROM cycles WHERE id=$1',[cycle])).rows[0].status).toBe('PARTIALLY_PUBLISHED');
 expect.soft((await req(`/cycles/${cycle}/results/build`,'POST',{})).status).toBe(200);
 for(const b of builds.items.slice(1))await publish(b.buildId);
 expect.soft((await db.query('SELECT status FROM cycles WHERE id=$1',[cycle])).rows[0].status).toBe('PUBLISHED');
 const old=(await db.query('SELECT * FROM published_results WHERE cycle_id=$1 AND target_id=$2',[cycle,people[1]])).rows[0];
 const review=(await db.query("SELECT id,reviewer_id,current_revision_id FROM reviews WHERE cycle_id=$1 AND target_id=$2 AND kind='PEER' AND status='SUBMITTED' LIMIT 1",[cycle,people[1]])).rows[0];
 const caseId=randomUUID();await db.query("INSERT INTO calibration_cases(id,cycle_id,org_id,review_revision_id,reason_code) VALUES($1,$2,$3,$4,'TEST_CORRECTION')",[caseId,cycle,org,review.current_revision_id]);await ok('/calibration-cases/'+caseId+'/actions','POST',{action:'SUGGEST_REVISION',reason:'隔离授权原作者更正'});
 expect((await req('/reviews/'+review.id+'/materials','GET',undefined,review.reviewer_id)).status).toBe(200);
 await score(review.id,review.reviewer_id,75,true);
 builds=await ok(`/cycles/${cycle}/results/build`,'POST',{targetId:people[1]});expect(builds.items).toHaveLength(1);await publish(builds.items[0].buildId);
 const versions=(await db.query('SELECT * FROM published_results WHERE cycle_id=$1 AND target_id=$2 ORDER BY publication_version',[cycle,people[1]])).rows;expect(versions).toHaveLength(2);expect(versions[0].payload_json).toEqual(old.payload_json);expect(versions[1].publication_version).toBe(2);expect(versions[1].supersedes_id).toBe(old.id);expect(versions[1].payload_json.final_score).toBeGreaterThan(70);
 expect((await req(`/cycles/${cycle}/results/build`,'POST',{},people[1])).status).toBe(403);
},120000);

it('late replacement requires explicit future deadline and authorization; original/expired tasks remain closed',async()=>{
 const c=await opened();const old=(await db.query("SELECT a.id,r.id AS review_id,a.reviewer_id FROM assignments a JOIN reviews r ON r.assignment_id=a.id WHERE a.cycle_id=$1 LIMIT 1",[c])).rows[0];await db.query("UPDATE cycles SET status='CALIBRATING',close_at=now()-interval '1 minute' WHERE id=$1",[c]);
 expect((await req(`/cycles/${c}/assignments/${old.id}/replace`,'POST',{reason:'无期限'})).status).toBe(400);
 const body={reason:'隔离授权补评',due_at:new Date(Date.now()+3600000).toISOString()};expect((await req(`/cycles/${c}/assignments/${old.id}/replace`,'POST',body,people[1])).status).toBe(403);
 const replacement=await ok(`/cycles/${c}/assignments/${old.id}/replace`,'POST',body);const next=(await db.query('SELECT id FROM reviews WHERE assignment_id=$1',[replacement.id])).rows[0];
 const untouched=(await db.query("SELECT r.id,r.reviewer_id FROM reviews r JOIN assignments a ON a.id=r.assignment_id WHERE r.cycle_id=$1 AND a.status='ACTIVE' AND a.id<>$2 LIMIT 1",[c,replacement.id])).rows[0];const d=await ok('/reviews/'+untouched.id,'GET',undefined,untouched.reviewer_id);
 expect((await req('/reviews/'+untouched.id+'/submit','POST',{payload:{items:d.template.items.map((i:any)=>({itemId:i.id,score:70})),readConfirmed:true},due_at:body.due_at},untouched.reviewer_id)).json.code).toBe('REVIEW_PERIOD_CLOSED');
 await db.query("UPDATE assignments SET supplement_due_at=now()-interval '1 second' WHERE id=$1",[replacement.id]);const nd=await ok('/reviews/'+next.id,'GET',undefined,replacement.reviewer_id);expect((await req('/reviews/'+next.id+'/submit','POST',{payload:{items:nd.template.items.map((i:any)=>({itemId:i.id,score:70})),readConfirmed:true}},replacement.reviewer_id)).status).toBe(400);await db.query("UPDATE assignments SET supplement_due_at=now()+interval '1 hour' WHERE id=$1",[replacement.id]);
 await score(next.id,replacement.reviewer_id);expect((await db.query('SELECT status FROM reviews WHERE id=$1',[next.id])).rows[0].status).toBe('SUBMITTED');expect((await db.query("SELECT 1 FROM audit_events WHERE org_id=$1 AND action='assignment.replace' AND resource_id=$2",[org,replacement.id])).rowCount).toBe(1);
},30000);

it('award contract, latest-version statistics and department published history never expose raw reviews',async()=>{
 const rows=await ok(`/cycles/${cycle}/award-candidates`);expect(rows).toHaveLength(14);for(const r of rows){expect(r.userId).toBeTruthy();expect(r.displayName).toBeTruthy();expect(Number.isFinite(r.finalScore)).toBe(true);expect(r.cycleId).toBe(cycle);expect(r.month).toMatch(/^2071-/);}
 const report=await ok(`/cycles/${cycle}/monthly-report`);expect(report.org.participantCount).toBe(14);expect(report.org.publishedCount).toBe(14);
 const head=await ok('/published-results','GET',undefined,people[0]);const current=head.filter((r:any)=>r.cycle_id===cycle);expect(current).toHaveLength(7);expect(current.find((r:any)=>r.target_id===people[1]).publication_version).toBe(2);expect(current.every((r:any)=>r.cycle_status==='PUBLISHED'&&Number.isFinite(Number(r.final_score))&&!('reviewer_id' in r))).toBe(true);
 expect((await req(`/cycles/${cycle}/review-scores`,'GET',undefined,people[0])).status).toBe(403);expect((await ok('/me/results','GET',undefined,people[1])).every((r:any)=>r.payload_json&&!r.reviewer_id)).toBe(true);
 await ok('/awards','POST',{cycleId:cycle,targetId:people[1],decision:'NOMINATED',reason:'隔离核对发布版本'});expect((await db.query('SELECT result_version FROM award_decisions WHERE cycle_id=$1 AND target_id=$2',[cycle,people[1]])).rows[0].result_version).toBe(2);
});

it('closed appeal text is immutable and concurrent rereview cannot overwrite processing',async()=>{
 const pub=(await db.query('SELECT id FROM published_results WHERE cycle_id=$1 AND target_id=$2 ORDER BY publication_version DESC LIMIT 1',[cycle,people[1]])).rows[0];const r=await ok('/published-results/'+pub.id+'/feedback-requests','POST',{reason:'【申诉类型】其他问题\n【涉及范围】未指定\n\n原申诉理由'},people[1]);await ok('/feedback-requests/'+r.id+'/resolve','POST',{decision:'REJECTED',note:'原处理意见'});
 const duplicate=await req('/published-results/'+pub.id+'/feedback-requests','POST',{reason:'【申诉类型】其他问题\n【涉及范围】未指定\n\n尝试覆盖原文'},people[1]);expect(duplicate.status).toBe(409);const saved=(await db.query('SELECT reason,status FROM feedback_requests WHERE id=$1',[r.id])).rows[0];expect(saved.reason).toBe('【申诉类型】其他问题\n【涉及范围】未指定\n\n原申诉理由');expect(saved.status).toBe('REJECTED');
 const retry=await Promise.all([req('/feedback-requests/'+r.id+'/rereview','POST',{reason:'二次复核'},people[1]),req('/feedback-requests/'+r.id+'/rereview','POST',{reason:'并发重复复核'},people[1])]);expect(retry.map(r=>r.status).sort()).toEqual([200,409]);
});

it('notification failure is retried and provider acceptance is never marked delivered',async()=>{
 const {dispatchPendingNotifications}=await import('../../../packages/domain/src/notification');const id=randomUUID();await db.query("INSERT INTO notification_outbox(id,org_id,event_key,recipient_id,channel,payload_json) VALUES($1,$2,$3,$4,'FEISHU','{}')",[id,org,'isolated-retry-'+id,people[1]]);
 // Select this test message while all other isolated messages are temporarily deferred.
 await db.query("UPDATE notification_outbox SET next_retry_at=now()+interval '1 day' WHERE org_id=$1 AND id<>$2",[org,id]);
 let sends=0;const gateway={send:async(message:{id:string})=>{if(message.id!==id)return {ok:true,messageId:'other-test-message',accepted:true};sends++;return sends===1?{ok:false,error:'TEST_PROVIDER_UNAVAILABLE'}:{ok:true,messageId:'test-message-id',accepted:true};}};
 await dispatchPendingNotifications(db,gateway,new Date(),30000,1000);let row=(await db.query('SELECT * FROM notification_outbox WHERE id=$1',[id])).rows[0];expect(row.status).toBe('FAILED');expect(row.last_error).toBe('TEST_PROVIDER_UNAVAILABLE');
 await db.query('UPDATE notification_outbox SET next_retry_at=now()-interval \'1 second\' WHERE id=$1',[id]);await dispatchPendingNotifications(db,gateway,new Date(),30000,1000);row=(await db.query('SELECT * FROM notification_outbox WHERE id=$1',[id])).rows[0];expect(row.status).toBe('ACCEPTED');expect(row.provider_message_id).toBe('test-message-id');expect(row.attempts).toBe(2);expect(sends).toBe(2);
});

it('concurrent notification claims send once and transport exceptions persist a retryable error',async()=>{
 const {dispatchPendingNotifications}=await import('../../../packages/domain/src/notification');const id=randomUUID();await db.query("UPDATE notification_outbox SET next_retry_at=now()+interval '1 day' WHERE status IN ('PENDING','FAILED')");await db.query("INSERT INTO notification_outbox(id,org_id,event_key,recipient_id,channel,payload_json) VALUES($1,$2,$3,$4,'FEISHU','{}')",[id,org,'concurrent-'+id,people[1]]);
 let sends=0;const gateway={send:async()=>{sends++;await new Promise(r=>setTimeout(r,50));return {ok:true,accepted:true,messageId:'concurrent-test'};}};
 await Promise.all([dispatchPendingNotifications(db,gateway,new Date()),dispatchPendingNotifications(db,gateway,new Date())]);expect(sends).toBe(1);
 await db.query("UPDATE notification_outbox SET status='FAILED',next_retry_at=now()-interval '1 second' WHERE id=$1",[id]);await dispatchPendingNotifications(db,{send:async()=>{throw new Error('test timeout');}},new Date());const row=(await db.query('SELECT status,last_error FROM notification_outbox WHERE id=$1',[id])).rows[0];expect(row).toEqual({status:'FAILED',last_error:'NOTIFICATION_TRANSPORT_ERROR'});
});

it.skipIf(process.env.ADMISSION_BROWSER!=='1')('real browser: minister history uses latest final scores, awards have names, three scopes remain isolated',async()=>{
 const {createRequire}=await import('node:module');const {chromium}=createRequire(import.meta.url)(process.env.ADMISSION_PLAYWRIGHT!);const browser=await chromium.launch({channel:'msedge',headless:true});
 const calls:string[]=[],errors:string[]=[];
 try{
  for(const [user,path,title,count] of [[people[0],'/task-archive','任务归档',7],[admin,'/award','评优候选',14],[viewer,'/published-results','已发布结果',14]] as const){
   const ctx=await browser.newContext();await ctx.addCookies([{name:'s360_session',value:cookies.get(user)!.split('=')[1],domain:'127.0.0.1',path:'/'}]);const page=await ctx.newPage();page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message));
   await page.route('http://127.0.0.1:43773/api/v1/**',async(route:any)=>{const url=new URL(route.request().url());calls.push(url.pathname);const response=await route.fetch({url:base+url.pathname.slice('/api/v1'.length)+url.search});await route.fulfill({response});});
   await page.goto('http://127.0.0.1:43773'+path);await page.getByRole('heading',{name:title,exact:true}).first().waitFor();await expect.poll(()=>page.locator('tbody tr').count()).toBe(count);
   const text=await page.locator('tbody').textContent();expect(text).not.toContain('NaN');expect(text).not.toContain('undefined');expect(text).toContain('链路成员1');
   if(path==='/task-archive'){const latest=(await db.query("SELECT payload_json->>'final_score' AS score FROM published_results WHERE cycle_id=$1 AND target_id=$2 ORDER BY publication_version DESC LIMIT 1",[cycle,people[1]])).rows[0];const row=page.locator('tbody tr').filter({has:page.getByText('链路成员1',{exact:true})});expect(await row.locator('td').nth(1).textContent()).toBe(Number(latest.score).toFixed(2));expect(calls.some(p=>p.endsWith('/review-scores'))).toBe(false);}
   await page.reload();await expect.poll(()=>page.locator('tbody tr').count()).toBe(count);await ctx.close();
  }
  const ctx=await browser.newContext();await ctx.addCookies([{name:'s360_session',value:cookies.get(people[1])!.split('=')[1],domain:'127.0.0.1',path:'/'}]);const page=await ctx.newPage();await page.route('http://127.0.0.1:43773/api/v1/**',async(route:any)=>{const url=new URL(route.request().url());const response=await route.fetch({url:base+url.pathname.slice('/api/v1'.length)+url.search});await route.fulfill({response});});await page.goto('http://127.0.0.1:43773/my-results');await page.getByRole('heading',{name:'我的成长报告',exact:true}).waitFor();expect(await page.getByText('链路成员2',{exact:true}).count()).toBe(0);expect(errors).toEqual([]);
 }finally{await browser.close();}
},90000);
