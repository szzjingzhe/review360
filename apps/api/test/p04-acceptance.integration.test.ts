import '../../../scripts/test-db-setup.cjs';
import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {AppModule} from '../src/app.module';
import {SessionService} from '../src/auth/session.service';
const org=randomUUID(),admin=randomUUID(),head=randomUUID(),outsider=randomUUID(),departments=[randomUUID(),randomUUID()],members=Array.from({length:12},()=>randomUUID()),rules=randomUUID(),cycle=randomUUID();
let db:Pool,app:any,base:string;const cookies=new Map<string,string>();
async function req(path:string,method='GET',body?:unknown,user=admin){const form=body instanceof FormData;const res=await fetch(base+path,{method,headers:{cookie:cookies.get(user)!,...(body===undefined||form?{}:{'content-type':'application/json'})},body:body===undefined?undefined:form?body:JSON.stringify(body)});return {status:res.status,body:await res.json() as any};}
beforeAll(async()=>{
 const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');process.env.REPORT_STORAGE_DIR=await mkdtemp(join(tmpdir(),'review360-p04-'));
 db=new Pool({connectionString:process.env.DATABASE_URL});
 await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'P02隔离测试','Asia/Shanghai')",[org]);
 for(const [id,name] of [[admin,'管理员'],[head,'部门负责人'],[outsider,'普通成员'],...members.map((id,i)=>[id,'成员'+i])])await db.query('INSERT INTO users(id,org_id,display_name) VALUES($1,$2,$3)',[id,org,name]);
 for(let i=0;i<2;i++)await db.query('INSERT INTO departments(id,org_id,code,name) VALUES($1,$2,$3,$4)',[departments[i],org,'D'+i,'测试部门'+i]);
 await db.query("INSERT INTO rulesets(id,org_id,version,status,config_json,checksum) VALUES($1,$2,1,'FROZEN','{}','p02')",[rules,org]);
 for(const role of ['HEAD','MEMBER','SELF']){const template=randomUUID();await db.query('INSERT INTO template_versions(id,org_id,ruleset_id,role_code,name) VALUES($1,$2,$3,$4,$4)',[template,org,rules,role]);for(let i=0;i<4;i++)await db.query('INSERT INTO template_items(id,org_id,template_id,code,label,weight,position) VALUES($1,$2,$3,$4,$4,25,$5)',[randomUUID(),org,template,'维度'+i,i]);}
 for(let i=0;i<members.length;i++){await db.query('INSERT INTO department_memberships(org_id,user_id,department_id,valid_from) VALUES($1,$2,$3,current_date)',[org,members[i],departments[Math.floor(i/6)]]);if(i%6===0)await db.query("INSERT INTO appointments(org_id,user_id,role,scope_dept_id,valid_from) VALUES($1,$2,'HEAD',$3,current_date)",[org,members[i],departments[Math.floor(i/6)]]);}
 await db.query("INSERT INTO appointments(org_id,user_id,role,valid_from) VALUES($1,$2,'SUPERVISOR',current_date)",[org,admin]);
 await db.query("INSERT INTO cycles(id,org_id,month,title,status,open_at,close_at,publish_at,ruleset_id,created_by) VALUES($1,$2,'2055-01-01','P02周期','DRAFT',now(),now()+interval '1 day',now()+interval '2 days',$3,$4)",[cycle,org,rules,admin]);
 for(let i=0;i<members.length;i++)await db.query("INSERT INTO cycle_participants(cycle_id,org_id,user_id,dept_snapshot,role_snapshot,eligibility) VALUES($1,$2,$3,$4,$5,'ELIGIBLE')",[cycle,org,members[i],departments[Math.floor(i/6)],i%6===0?'HEAD':'MEMBER']);
 for(const cap of ['management.access','assignment.manage','assignment.read','cycle.manage','progress.read'])await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type) VALUES($1,$2,$3,'ORG')",[org,admin,cap]);
 for(const cap of ['management.access','assignment.manage'])await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type,scope_id) VALUES($1,$2,$3,'DEPARTMENT',$4)",[org,head,cap,departments[0]]);
 const m=await Test.createTestingModule({imports:[AppModule]}).compile();app=m.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api/v1';for(const id of [admin,head,outsider,...members])cookies.set(id,'s360_session='+await app.get(SessionService).createSession(id,org));
},30000);
afterAll(async()=>{if(app)await app.close();if(db)await db.end();});
describe('草稿评价分配',()=>{
 it('按授权列出草稿和名单，部门负责人不能跨范围指定',async()=>{
  const list=await req('/management/assignment-cycles','GET',undefined,head);expect(list.status).toBe(200);expect(list.body.data.some((c:any)=>c.id===cycle)).toBe(true);
  const manual=await req(`/cycles/${cycle}/assignment/manual`,'GET',undefined,head);expect(manual.status).toBe(200);expect(manual.body.data.participants).toHaveLength(6);
  expect((await req(`/cycles/${cycle}/assignment/manual`,'POST',{reviewer_id:members[1],target_id:members[7],reason:'跨部门'},head)).status).toBe(403);
  expect((await req(`/cycles/${cycle}/assignment/preview`,'POST',{},head)).status).toBe(403);
  expect((await req(`/cycles/${cycle}/assignment/manual`,'GET',undefined,outsider)).status).toBe(403);
 });
 it('保留人工关系，预览确认保存后不创建正式任务',async()=>{
  const edge={reviewer_id:members[1],target_id:members[2],reason:'业务协作'};
  expect((await req(`/cycles/${cycle}/assignment/manual`,'POST',edge,head)).status).toBe(200);
  expect((await req(`/cycles/${cycle}/assignment/manual`,'POST',edge,head)).status).toBeGreaterThanOrEqual(400);
  const p=await req(`/cycles/${cycle}/assignment/preview`,'POST',{});expect(p.status).toBe(200);expect(p.body.data.feasible,JSON.stringify(p.body.data.shortfalls)).toBe(true);
  expect(p.body.data.edges.some((e:any)=>e.reviewerId===members[1]&&e.targetId===members[2]&&e.sourceType==='MANUAL')).toBe(true);
  expect((await req(`/cycles/${cycle}/assignment/confirm-preview`,'POST',{run_id:p.body.data.id})).status).toBe(200);
  const saved=await req(`/cycles/${cycle}/assignment/confirmed-preview`);expect(saved.status).toBe(200);expect(saved.body.data.id).toBe(p.body.data.id);
  expect((await db.query('SELECT count(*)::int n FROM assignments WHERE cycle_id=$1',[cycle])).rows[0].n).toBe(0);
  expect((await req(`/cycles/${cycle}/assignment/confirm-preview`,'POST',{run_id:p.body.data.id},outsider)).status).toBe(403);
  expect((await req(`/cycles/${cycle}/assignment/manual`,'DELETE',edge,head)).status).toBe(200);
  expect((await req(`/cycles/${cycle}/assignment/confirmed-preview`)).body.data).toBeNull();
  expect((await req(`/cycles/${cycle}/assignment/confirm-preview`,'POST',{run_id:p.body.data.id})).status).toBeGreaterThanOrEqual(400);
 });
 it.skipIf(process.env.P02_BROWSER!=='1')('浏览器使用真实接口预览并保存方案',async()=>{
  const {createRequire}=await import('node:module');const {chromium}=createRequire(import.meta.url)('C:/Users/29838/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const browser=await chromium.launch({headless:true,executablePath:'C:/Users/29838/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'});
  try{const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'s360_session',value:cookies.get(admin)!.split('=')[1],domain:'127.0.0.1',path:'/'}]);const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
   await page.route('http://127.0.0.1:5401/api/v1/**',async(route:any)=>{const u=new URL(route.request().url());const response=await route.fetch({url:base+u.pathname.slice('/api/v1'.length)+u.search});await route.fulfill({response});});
   await page.goto('http://127.0.0.1:5401/personal');await page.getByText('进入管理端',{exact:true}).first().click();await page.getByRole('link',{name:'月评管理',exact:true}).click();await page.getByRole('link',{name:'评价分配',exact:true}).click();await page.getByRole('heading',{name:'评价关系管理'}).waitFor();
   await expect.poll(()=>page.getByText('本周期 12 名参评成员',{exact:false}).count()).toBe(1);
   const panel=page.locator('section.card').filter({has:page.getByRole('heading',{name:'人工指定评价关系（选填）'})});
   await panel.locator('select').nth(0).selectOption({label:'测试部门0'});await panel.locator('select').nth(1).selectOption(members[1]);
   await panel.locator('select').nth(2).selectOption({label:'测试部门0'});await panel.locator('select').nth(3).selectOption(members[2]);
   await panel.getByPlaceholder('请输入指定原因').fill('页面验收');await panel.getByRole('button',{name:'保存指定关系'}).click();await panel.getByText('页面验收',{exact:true}).waitFor();
   await page.getByRole('button',{name:'预览系统分配'}).click();await page.getByRole('heading',{name:'系统分配预览'}).waitFor();await expect.poll(()=>page.locator('.preview-list tbody tr').filter({hasText:'成员1'}).filter({hasText:'成员2'}).filter({hasText:'人工指定'}).count()).toBe(1);
   await page.getByRole('button',{name:'确认并保存方案'}).click();await page.getByText('方案已保存，发起月评时使用。').waitFor();
   await page.getByRole('link',{name:'管理工作台',exact:true}).click();await page.getByRole('link',{name:'月评管理',exact:true}).click();await page.getByRole('link',{name:'评价分配',exact:true}).click();await page.getByText('方案已保存，发起月评时使用。').waitFor();expect(errors).toEqual([]);await context.close();
   const headContext=await browser.newContext();await headContext.addCookies([{name:'s360_session',value:cookies.get(head)!.split('=')[1],domain:'127.0.0.1',path:'/'}]);const headPage=await headContext.newPage();
   await headPage.route('http://127.0.0.1:5401/api/v1/**',async(route:any)=>{const u=new URL(route.request().url());const response=await route.fetch({url:base+u.pathname.slice('/api/v1'.length)+u.search});await route.fulfill({response});});
   await headPage.goto('http://127.0.0.1:5401/personal');await headPage.getByText('进入管理端',{exact:true}).first().click();await headPage.getByRole('link',{name:'月评管理',exact:true}).click();await headPage.getByRole('heading',{name:'评价关系管理'}).waitFor();
   await expect.poll(()=>headPage.getByText('本周期 6 名参评成员',{exact:false}).count()).toBe(1);expect(await headPage.getByText('成员7',{exact:true}).count()).toBe(0);await headContext.close();
  }finally{await browser.close();}
 },60000);

 it.skipIf(process.env.P02_BROWSER!=='1')('创建草稿到保存方案并启动月评的页面全流程',async()=>{
  const {createRequire}=await import('node:module');const {chromium}=createRequire(import.meta.url)('C:/Users/29838/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const browser=await chromium.launch({headless:true,executablePath:'C:/Users/29838/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'});
  try{const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'s360_session',value:cookies.get(admin)!.split('=')[1],domain:'127.0.0.1',path:'/'}]);const page=await context.newPage();page.setDefaultTimeout(15000);
   await page.route('http://127.0.0.1:5401/api/v1/**',async(route:any)=>{const u=new URL(route.request().url());const response=await route.fetch({url:base+u.pathname.slice('/api/v1'.length)+u.search});await route.fulfill({response});});
   await page.goto('http://127.0.0.1:5401/personal');await page.getByText('进入管理端',{exact:true}).first().click();await page.getByRole('link',{name:'月评管理',exact:true}).click();
   await page.getByRole('button',{name:'＋ 创建月评周期'}).click();const dlg=page.locator('dialog').filter({has:page.getByRole('heading',{name:'创建月评周期'})});
   await dlg.locator('input[type=month]').fill('2056-01');
   const local=(delta:number)=>{const d=new Date(Date.now()+delta);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
   for(const [i,delta] of [-3600000,86400000,172800000].entries())await dlg.locator('input[type=datetime-local]').nth(i).fill(local(delta));
   await dlg.locator('select').selectOption(rules);await dlg.getByRole('button',{name:'创建周期',exact:true}).click();
   await page.waitForURL(/management\/monthly\/relations\?cycleId=/);await page.getByText('周期草稿已创建',{exact:false}).waitFor();await expect.poll(()=>page.getByText('本周期 12 名参评成员',{exact:false}).count()).toBe(1);
   const created=new URL(page.url()).searchParams.get('cycleId')!;expect(created).toBeTruthy();
   const panel=page.locator('section.card').filter({has:page.getByRole('heading',{name:'人工指定评价关系（选填）'})});
   await panel.locator('select').nth(0).selectOption({label:'测试部门0'});await panel.locator('select').nth(1).selectOption(members[1]);await panel.locator('select').nth(2).selectOption({label:'测试部门0'});await panel.locator('select').nth(3).selectOption(members[2]);
   await panel.getByPlaceholder('请输入指定原因').fill('P03测试');await panel.getByRole('button',{name:'保存指定关系'}).click();await panel.getByText('P03测试',{exact:true}).waitFor();
   await page.getByRole('button',{name:'预览系统分配'}).click();await page.getByRole('button',{name:'确认并保存方案'}).click();await page.getByRole('link',{name:'返回周期管理并启动 →'}).waitFor();await page.reload();await page.getByRole('link',{name:'返回周期管理并启动 →'}).waitFor();expect(new URL(page.url()).searchParams.get('cycleId')).toBe(created);await page.getByRole('link',{name:'返回周期管理并启动 →'}).click();
   await page.getByText('分配方案已保存且仍有效',{exact:false}).waitFor();await page.getByRole('button',{name:'发布月评',exact:true}).click();await page.getByText('评价关系预检通过',{exact:false}).waitFor();await page.getByRole('button',{name:'确认发布',exact:true}).click();
   await expect.poll(async()=>(await db.query('SELECT status FROM cycles WHERE id=$1',[created])).rows[0].status).toBe('REVIEWING');const taskCount=(await db.query("SELECT count(*)::int n FROM assignments WHERE cycle_id=$1 AND status='ACTIVE'",[created])).rows[0].n;expect(taskCount).toBeGreaterThan(0);expect((await req(`/cycles/${created}/open`,'POST',{run_id:randomUUID()})).status).toBeGreaterThanOrEqual(400);expect((await db.query("SELECT count(*)::int n FROM assignments WHERE cycle_id=$1 AND status='ACTIVE'",[created])).rows[0].n).toBe(taskCount);
   await context.close();
  }finally{await browser.close();}
 },60000);

 it('不满足分配人数时给出成员缺口且不能保存',async()=>{
  const now=Date.now();const created=await req('/cycles','POST',{month:'2057-03',title:'P04不足人数',ruleset_id:rules,open_at:new Date(now).toISOString(),close_at:new Date(now+3600000).toISOString(),publish_at:new Date(now+7200000).toISOString()});expect(created.status).toBe(201);const id=created.body.data.id;
  await db.query("UPDATE cycle_participants SET eligibility='EXCLUDED' WHERE cycle_id=$1 AND user_id<>$2",[id,members[0]]);
  const result=await req(`/cycles/${id}/assignment/preview`,'POST',{});expect(result.status).toBe(200);expect(result.body.data.feasible).toBe(false);expect(result.body.data.shortfalls.length).toBeGreaterThan(0);expect(result.body.data.shortfalls[0].missing).toBeGreaterThan(0);expect(result.body.data.shortfalls[0].targetName).toBeTruthy();
  expect((await req(`/cycles/${id}/assignment/confirm-preview`,'POST',{run_id:result.body.data.id})).status).toBeGreaterThanOrEqual(400);
 });
 it('真实 Worker 等待计划时间后自动开期，成员看到自己的材料、自评及任务',async()=>{
  const now=Date.now(),created=await req('/cycles','POST',{month:'2057-04',title:'P04定时开期',ruleset_id:rules,open_at:new Date(now+12000).toISOString(),close_at:new Date(now+120000).toISOString(),publish_at:new Date(now+180000).toISOString()});expect(created.status).toBe(201);const id=created.body.data.id;
  const snapshot=(await db.query('SELECT ruleset_id,status FROM cycles WHERE id=$1',[id])).rows[0];expect(snapshot.ruleset_id).toBe(rules);expect(snapshot.status).toBe('DRAFT');expect((await db.query("SELECT count(*)::int n FROM cycle_participants WHERE cycle_id=$1 AND eligibility='ELIGIBLE'",[id])).rows[0].n).toBe(12);
  const p=await req(`/cycles/${id}/assignment/preview`,'POST',{});expect(p.status).toBe(200);expect(p.body.data.feasible).toBe(true);expect((await req(`/cycles/${id}/assignment/confirm-preview`,'POST',{run_id:p.body.data.id})).status).toBe(200);expect((await req(`/cycles/${id}/submit`,'POST',{})).status).toBe(200);
  const scheduled=await req(`/cycles/${id}/open`,'POST',{run_id:p.body.data.id});expect(scheduled.status).toBe(200);expect(scheduled.body.data.status).toBe('PENDING_OPEN');expect(scheduled.body.data.scheduled).toBe(true);
  const {spawn}=await import('node:child_process');const {resolve}=await import('node:path');let logs='';const worker=spawn(process.execPath,['dist/main.js'],{cwd:resolve(process.cwd(),'../worker'),env:{...process.env,WORKER_POLL_MS:'500',WORKER_INSTANCE_ID:'p04-isolated'},windowsHide:true,stdio:['ignore','pipe','pipe']});worker.stdout.on('data',d=>logs+=d.toString());worker.stderr.on('data',d=>logs+=d.toString());
  try{
   await new Promise(resolve=>setTimeout(resolve,2000));const early=(await db.query('SELECT status,now()<open_at AS before_open FROM cycles WHERE id=$1',[id])).rows[0];expect(early.before_open).toBe(true);expect(early.status).toBe('PENDING_OPEN');expect((await db.query('SELECT count(*)::int n FROM assignments WHERE cycle_id=$1',[id])).rows[0].n).toBe(0);
   await expect.poll(async()=>(await db.query('SELECT status FROM cycles WHERE id=$1',[id])).rows[0].status,{timeout:30000,interval:500,message:'定时 Worker 未按预期启动：'+logs}).toBe('REVIEWING');
   const phase=(await db.query("SELECT cp.actual_at,c.open_at FROM cycle_phases cp JOIN cycles c ON c.id=cp.cycle_id WHERE cp.cycle_id=$1 AND cp.phase='OPEN'",[id])).rows[0];expect(new Date(phase.actual_at).getTime()).toBeGreaterThanOrEqual(new Date(phase.open_at).getTime());
   const count=(await db.query("SELECT count(*)::int n FROM assignments WHERE cycle_id=$1 AND status='ACTIVE'",[id])).rows[0].n;expect(count).toBeGreaterThan(0);expect((await req(`/cycles/${id}/open`,'POST',{run_id:p.body.data.id})).status).toBeGreaterThanOrEqual(400);expect((await db.query('SELECT count(*)::int n FROM assignments WHERE cycle_id=$1',[id])).rows[0].n).toBe(count);
   const person=members[1],tasks=await req(`/cycles/${id}/assignments/me`,'GET',undefined,person);expect(tasks.status).toBe(200);expect(tasks.body.data.peers.length).toBeGreaterThan(0);expect(tasks.body.data.peers.every((e:any)=>e.target.id!==person)).toBe(true);
   const self=await req(`/cycles/${id}/self-review`,'POST',{},person);expect(self.status).toBe(201);expect((await req(`/reviews/${self.body.data.reviewId}`,'GET',undefined,person)).status).toBe(200);
   const form=new FormData();form.append('files',new Blob(['%PDF-1.4\n%%EOF'],{type:'application/pdf'}),'验收月报.pdf');form.append('metadata',JSON.stringify([{name:'P04月报',type:'MONTHLY_REPORT'}]));form.append('requestId',randomUUID());
   const upload=await req(`/cycles/${id}/monthly-report/materials`,'POST',form,person);expect(upload.status,JSON.stringify(upload.body)).toBe(201);
   const materials=await req(`/cycles/${id}/monthly-report/materials`,'GET',undefined,person);expect(materials.status).toBe(200);expect(materials.body.data.materials.some((m:any)=>m.name==='P04月报')).toBe(true);
   const otherMaterials=await req(`/cycles/${id}/monthly-report/materials`,'GET',undefined,members[2]);expect(otherMaterials.status).toBe(200);expect(otherMaterials.body.data.materials).toHaveLength(0);
   expect((await req(`/cycles/${id}/assignment/manual`,'POST',{reviewer_id:members[1],target_id:members[2],reason:'无权'},outsider)).status).toBe(403);
   expect((await req(`/cycles/${id}/pause`,'POST',{reason:'测试暂停'},outsider)).status).toBe(403);
   expect((await req(`/cycles/${id}/pause`,'POST',{reason:'测试暂停'})).status).toBe(200);
   expect((await req(`/cycles/${id}/pause`,'POST',{reason:'重复暂停'})).status).toBeGreaterThanOrEqual(400);
   const blocked=new FormData();blocked.append('files',new Blob(['%PDF-1.4\n%%EOF'],{type:'application/pdf'}),'暂停.pdf');blocked.append('metadata',JSON.stringify([{name:'暂停材料',type:'MONTHLY_REPORT'}]));blocked.append('requestId',randomUUID());
   expect((await req(`/cycles/${id}/monthly-report/materials`,'POST',blocked,person)).status).toBeGreaterThanOrEqual(400);
   expect((await req(`/cycles/${id}/self-review`,'POST',{},members[2])).status).toBeGreaterThanOrEqual(400);
   expect((await req(`/cycles/${id}/resume`,'POST',{reason:'恢复测试'})).status).toBe(200);
   expect((await req(`/cycles/${id}/resume`,'POST',{reason:'重复恢复'})).status).toBeGreaterThanOrEqual(400);
   expect((await req(`/cycles/${id}/cancel`,'POST',{reason:'紧急撤销测试'})).status).toBe(200);
   expect((await req(`/cycles/${id}/cancel`,'POST',{reason:'重复撤销'})).status).toBeGreaterThanOrEqual(400);
   expect((await db.query('SELECT count(*)::int n FROM monthly_reports WHERE cycle_id=$1',[id])).rows[0].n).toBe(1);
   expect((await db.query('SELECT count(*)::int n FROM reviews WHERE cycle_id=$1',[id])).rows[0].n).toBeGreaterThan(0);
   expect((await db.query("SELECT count(*)::int n FROM cycle_state_log WHERE cycle_id=$1 AND to_status IN ('PAUSED','REVIEWING','CANCELLED') AND actor_id=$2 AND reason IS NOT NULL",[id,admin])).rows[0].n).toBeGreaterThanOrEqual(3);
  }finally{worker.kill();}
 },45000);

 it('刷新参评名单使已保存方案失效',async()=>{
  const now=Date.now();const created=await req('/cycles','POST',{month:'2057-05',title:'P04名单刷新',ruleset_id:rules,open_at:new Date(now).toISOString(),close_at:new Date(now+3600000).toISOString(),publish_at:new Date(now+7200000).toISOString()});expect(created.status).toBe(201);const id=created.body.data.id;
  const p=await req(`/cycles/${id}/assignment/preview`,'POST',{});expect(p.body.data.feasible).toBe(true);expect((await req(`/cycles/${id}/assignment/confirm-preview`,'POST',{run_id:p.body.data.id})).status).toBe(200);
  expect((await req(`/cycles/${id}/participants/refresh`,'POST',{})).status).toBe(200);const saved=await req(`/cycles/${id}/assignment/confirmed-preview`);expect(saved.status).toBe(200);expect(saved.body.data).toBeNull();
 });

});


describe('P1-2 归档预检',()=>{
 it('仅全部发布且无待处理事项时归档，保留历史并拒绝重复和越权操作',async()=>{
  const id=randomUUID(),build=randomUUID(),publication=randomUUID();
  await db.query("INSERT INTO cycles(id,org_id,month,title,status,open_at,close_at,publish_at,ruleset_id,created_by) VALUES($1,$2,'2058-01-01','归档测试','PUBLISHED',now()-interval '3 days',now()-interval '2 days',now()-interval '1 day',$3,$4)",[id,org,rules,admin]);
  await db.query("INSERT INTO cycle_participants(cycle_id,org_id,user_id,dept_snapshot,role_snapshot,eligibility) VALUES($1,$2,$3,$4,'MEMBER','ELIGIBLE')",[id,org,members[1],departments[0]]);
  expect((await req(`/cycles/${id}/archive-preflight`,'GET',undefined,outsider)).status).toBe(403);
  let check=await req(`/cycles/${id}/archive-preflight`);expect(check.status).toBe(200);expect(check.body.data.eligible).toBe(false);
  expect((await req(`/cycles/${id}/archive`,'POST',{})).status).toBeGreaterThanOrEqual(400);
  await db.query("INSERT INTO result_builds(id,cycle_id,org_id,target_id,input_hash,formula_version,status) VALUES($1,$2,$3,$4,'test','v1','PUBLISHED')",[build,id,org,members[1]]);
  await db.query("INSERT INTO published_results(id,cycle_id,org_id,target_id,publication_version,result_build_id,payload_json) VALUES($1,$2,$3,$4,1,$5,'{}')",[publication,id,org,members[1],build]);
  const feedback=randomUUID();await db.query("INSERT INTO feedback_requests(id,publication_id,org_id,applicant_id,reason,status) VALUES($1,$2,$3,$4,'测试','PENDING')",[feedback,publication,org,members[1]]);
  check=await req(`/cycles/${id}/archive-preflight`);expect(check.body.data.eligible).toBe(false);expect(check.body.data.checks.find((x:any)=>x.key==='appeals').ok).toBe(false);
  await db.query("UPDATE feedback_requests SET status='DONE' WHERE id=$1",[feedback]);
  check=await req(`/cycles/${id}/archive-preflight`);expect(check.body.data.eligible,JSON.stringify(check.body)).toBe(true);
  expect((await req(`/cycles/${id}/archive`,'POST',{})).status).toBe(201);
  expect((await req(`/cycles/${id}/archive`,'POST',{})).status).toBeGreaterThanOrEqual(400);
  expect((await db.query('SELECT status FROM cycles WHERE id=$1',[id])).rows[0].status).toBe('ARCHIVED');
  expect((await db.query('SELECT count(*)::int n FROM published_results WHERE cycle_id=$1',[id])).rows[0].n).toBe(1);
  expect((await db.query("SELECT count(*)::int n FROM cycle_state_log WHERE cycle_id=$1 AND to_status='ARCHIVED'",[id])).rows[0].n).toBe(1);
  const rereview=await req(`/feedback-requests/${feedback}/rereview`,'POST',{reason:'归档后尝试申请复核'},members[1]);
  expect(rereview.status).toBe(409);
  expect(rereview.body.code).toBe('CYCLE_READ_ONLY');
  expect((await req(`/management/cycle-detail?cycleId=${id}`)).status).toBe(200);
  await db.query("UPDATE cycles SET status='CANCELLED' WHERE id=$1",[cycle]);
  expect((await req(`/cycles/${cycle}/archive-preflight`)).body.data.eligible).toBe(false);
  expect((await req(`/cycles/${cycle}/archive`,'POST',{})).status).toBeGreaterThanOrEqual(400);
 });
});

