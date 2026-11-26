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
async function req(path:string,method='GET',body?:unknown,user=admin){const res=await fetch(base+path,{method,headers:{cookie:cookies.get(user)!,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json() as any};}
beforeAll(async()=>{
 db=new Pool({connectionString:process.env.DATABASE_URL});
 await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'P02隔离测试','Asia/Shanghai')",[org]);
 for(const [id,name] of [[admin,'管理员'],[head,'部门负责人'],[outsider,'普通成员'],...members.map((id,i)=>[id,'成员'+i])])await db.query('INSERT INTO users(id,org_id,display_name) VALUES($1,$2,$3)',[id,org,name]);
 for(let i=0;i<2;i++)await db.query('INSERT INTO departments(id,org_id,code,name) VALUES($1,$2,$3,$4)',[departments[i],org,'D'+i,'测试部门'+i]);
 await db.query("INSERT INTO rulesets(id,org_id,version,status,config_json,checksum) VALUES($1,$2,1,'FROZEN','{}','p02')",[rules,org]);
 for(const role of ['HEAD','MEMBER'])await db.query('INSERT INTO template_versions(id,org_id,ruleset_id,role_code,name) VALUES($1,$2,$3,$4,$4)',[randomUUID(),org,rules,role]);
 for(let i=0;i<members.length;i++){await db.query('INSERT INTO department_memberships(org_id,user_id,department_id,valid_from) VALUES($1,$2,$3,current_date)',[org,members[i],departments[Math.floor(i/6)]]);if(i%6===0)await db.query("INSERT INTO appointments(org_id,user_id,role,scope_dept_id,valid_from) VALUES($1,$2,'HEAD',$3,current_date)",[org,members[i],departments[Math.floor(i/6)]]);}
 await db.query("INSERT INTO appointments(org_id,user_id,role,valid_from) VALUES($1,$2,'SUPERVISOR',current_date)",[org,admin]);
 await db.query("INSERT INTO cycles(id,org_id,month,title,status,open_at,close_at,publish_at,ruleset_id,created_by) VALUES($1,$2,'2055-01-01','P02周期','DRAFT',now(),now()+interval '1 day',now()+interval '2 days',$3,$4)",[cycle,org,rules,admin]);
 for(let i=0;i<members.length;i++)await db.query("INSERT INTO cycle_participants(cycle_id,org_id,user_id,dept_snapshot,role_snapshot,eligibility) VALUES($1,$2,$3,$4,$5,'ELIGIBLE')",[cycle,org,members[i],departments[Math.floor(i/6)],i%6===0?'HEAD':'MEMBER']);
 for(const cap of ['management.access','assignment.manage','assignment.read','cycle.manage','progress.read'])await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type) VALUES($1,$2,$3,'ORG')",[org,admin,cap]);
 for(const cap of ['management.access','assignment.manage'])await db.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type,scope_id) VALUES($1,$2,$3,'DEPARTMENT',$4)",[org,head,cap,departments[0]]);
 const m=await Test.createTestingModule({imports:[AppModule]}).compile();app=m.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api/v1';for(const id of [admin,head,outsider])cookies.set(id,'s360_session='+await app.get(SessionService).createSession(id,org));
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

});

