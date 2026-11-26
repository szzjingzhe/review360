import '../../../scripts/test-db-setup.cjs';
import 'reflect-metadata';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Test } from '@nestjs/testing';
import { it,expect } from 'vitest';
import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/database/database.module';
import { SessionService } from '../src/auth/session.service';
const {applyOrganizationCorrection}=createRequire(import.meta.url)('../../../deploy/correct-guidance-organization.cjs');
it('approved correction preserves history, repairs tasks, merges identity, and enforces published-only HTTP access',async()=>{
 const db=new Pool({connectionString:process.env.DATABASE_URL}),c=await db.connect();let app:any;
 const ids={org:randomUUID(),canonical:randomUUID(),duplicate:randomUUID(),qin:randomUUID(),ma:randomUUID()},cycle=randomUUID(),run=randomUUID(),dept=randomUUID();
 try{
 await c.query('BEGIN');await c.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'隔离指导组测试','Asia/Shanghai')",[ids.org]);
 const people=[ids.canonical,ids.ma,...Array.from({length:7},()=>randomUUID())];
 for(const id of [...people,ids.duplicate,ids.qin])await c.query('INSERT INTO users(id,org_id,display_name) VALUES($1,$2,$3)',[id,ids.org,id===ids.canonical||id===ids.duplicate?'示例成员19':id===ids.qin?'示例成员50':id===ids.ma?'示例成员43':'隔离测试成员']);
 await c.query("INSERT INTO departments(id,org_id,code,name) VALUES($1,$2,'PRODUCT','产品部')",[dept,ids.org]);
 for(const id of people)await c.query('INSERT INTO department_memberships(org_id,user_id,department_id,valid_from) VALUES($1,$2,$3,current_date-1)',[ids.org,id,dept]);
 const external=randomUUID();await c.query("INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU','isolated',$2,true)",[ids.duplicate,external]);
 for(const id of [ids.qin,ids.duplicate])await c.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type) VALUES($1,$2,'calibration.read_raw','ORG')",[ids.org,id]);
 await c.query("INSERT INTO cycles(id,org_id,month,status,title) VALUES($1,$2,'2042-01-01','REVIEWING','1025测试')",[cycle,ids.org]);
 await c.query("INSERT INTO assignment_runs(id,cycle_id,org_id,version,seed,algorithm_version,input_hash,status) VALUES($1,$2,$3,1,1,'test','test','LOCKED')",[run,cycle,ids.org]);
 for(const id of people)await c.query("INSERT INTO cycle_participants(cycle_id,org_id,user_id,dept_snapshot,role_snapshot) VALUES($1,$2,$3,$4,'MEMBER')",[cycle,ids.org,id,dept]);
 for(let i=0;i<people.length;i++)for(const delta of [1,2,3,4]){
  const a=randomUUID(),target=people[(i+delta)%people.length];
  await c.query("INSERT INTO assignments(id,run_id,cycle_id,org_id,reviewer_id,target_id,source_type) VALUES($1,$2,$3,$4,$5,$6,'PEER')",[a,run,cycle,ids.org,people[i],target]);
  await c.query("INSERT INTO reviews(id,cycle_id,org_id,assignment_id,reviewer_id,target_id,kind) VALUES($1,$2,$3,$4,$5,$6,'PEER')",[randomUUID(),cycle,ids.org,a,people[i],target]);
 }
 const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(DATABASE_POOL).useValue({query:c.query.bind(c)}).compile();
 app=module.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');
 const sessions=app.get(SessionService),oldToken=await sessions.createSession(ids.duplicate,ids.org);
 const result=await applyOrganizationCorrection(c,ids);expect(result.identityBindingsMoved).toBe(1);expect(result.cycleChanges[0].cancelled).toBe(8);expect(result.cycleChanges[0].replacements).toHaveLength(4);
 expect((await c.query('SELECT count(*)::int AS n FROM assignments WHERE cycle_id=$1',[cycle])).rows[0].n).toBe(40);
 expect((await c.query("SELECT count(*)::int AS n FROM assignments WHERE cycle_id=$1 AND status='ACTIVE' AND (reviewer_id=$2 OR target_id=$2)",[cycle,ids.ma])).rows[0].n).toBe(0);
 expect((await c.query("SELECT count(*)::int AS n FROM reviews WHERE cycle_id=$1 AND status='WITHDRAWN'",[cycle])).rows[0].n).toBe(8);
 const degree=(await c.query("SELECT reviewer_id,count(*)::int AS n FROM assignments WHERE cycle_id=$1 AND status='ACTIVE' GROUP BY reviewer_id",[cycle])).rows;expect(degree).toHaveLength(8);expect(degree.every(r=>r.n>=4&&r.n<=5)).toBe(true);
 expect((await c.query('SELECT user_id,approved FROM external_identities WHERE external_id=$1',[external])).rows).toEqual([{user_id:ids.canonical,approved:true}]);
 expect(await sessions.resolveSession(oldToken)).toBeNull();
 expect((await c.query("SELECT status FROM users WHERE id=$1",[ids.duplicate])).rows[0].status).toBe('DISABLED');
 const base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api/v1';
 for(const id of [ids.qin,ids.ma]){
  const token=await sessions.createSession(id,ids.org),headers={cookie:'s360_session='+token};
  const me=await fetch(base+'/me',{headers});expect(me.status).toBe(200);const info=(await me.json()).data;expect(info.isGuidance).toBe(true);expect(info.department.dept_name).toBe('指导组');expect(info.capabilities.map((x:any)=>x.capability)).toEqual(['result.read_published']);
  for(const path of ['/cycles/'+cycle+'/assignments/me','/cycles/'+cycle+'/review-scores','/me/results','/cycles'])expect((await fetch(base+path,{headers})).status).toBe(403);
  expect((await fetch(base+'/cycles/'+cycle+'/self-review',{method:'POST',headers})).status).toBe(403);
  const published=await fetch(base+'/published-results',{headers});expect(published.status).toBe(200);expect((await published.json()).data).toEqual([]);
  const directory=await fetch(base+'/organization/members',{headers});const rows=(await directory.json()).data;expect(rows.filter((u:any)=>u.display_name==='示例成员19')).toHaveLength(1);expect(rows.filter((u:any)=>u.dept_name==='指导组')).toHaveLength(2);
  expect((await fetch(base+'/auth/logout',{method:'POST',headers})).status).toBe(200);expect((await fetch(base+'/me',{headers})).status).toBe(401);
 }
 // Published viewer returns only the latest explicit aggregate projection, even if a legacy payload contains sensitive fields.
 const build=randomUUID();await c.query("INSERT INTO result_builds(id,cycle_id,org_id,target_id,input_hash,formula_version,status) VALUES($1,$2,$3,$4,'viewer-test','v-test','PUBLISHED')",[build,cycle,ids.org,ids.canonical]);
 for(const version of [1,2])await c.query("INSERT INTO published_results(id,cycle_id,org_id,target_id,publication_version,result_build_id,payload_json) VALUES($1,$2,$3,$4,$5,$6,$7)",[randomUUID(),cycle,ids.org,ids.canonical,version,build,JSON.stringify({final_score:80+version,self_score:99,formula_version:'v-test',reviewer_id:'SHOULD_NEVER_LEAK',reasons:['SECRET']})]);
 const token=await sessions.createSession(ids.qin,ids.org);const response=await fetch(base+'/published-results',{headers:{cookie:'s360_session='+token}});expect(response.status).toBe(200);const published=(await response.json()).data;expect(published).toHaveLength(1);expect(published[0].publication_version).toBe(2);expect(published[0].final_score).toBe(82);expect(published[0].self_score).toBe(99);expect(JSON.stringify(published)).not.toMatch(/SHOULD_NEVER_LEAK|SECRET|reviewer_id|reasons/);
 if(process.env.GUIDANCE_BROWSER==='1'){
  const {chromium}=createRequire(import.meta.url)(process.env.GUIDANCE_PLAYWRIGHT!);
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'s360_session',value:token,domain:'127.0.0.1',path:'/'}]);const page=await context.newPage();page.setDefaultTimeout(8000);
   await page.route('http://127.0.0.1:43673/api/v1/**',async(route:any)=>{const url=new URL(route.request().url());const response=await route.fetch({url:base+url.pathname.slice('/api/v1'.length)+url.search});await route.fulfill({response});});
   await page.goto('http://127.0.0.1:43673/');await page.waitForURL('**/published-results');await page.getByRole('cell',{name:'82.00',exact:true}).waitFor();expect(await page.getByRole('link',{name:'待我评价',exact:true}).count()).toBe(0);
   await page.screenshot({path:'../../tmp/guidance-published-results.png',fullPage:true});
   await page.goto('http://127.0.0.1:43673/organization');await page.getByRole('heading',{name:'指导组',exact:true}).waitFor();expect(await page.getByText('示例成员19',{exact:true}).count()).toBe(1);expect(await page.getByText('示例成员46',{exact:true}).count()).toBeGreaterThan(0);await page.screenshot({path:'../../tmp/guidance-organization.png',fullPage:true});
   console.log('BROWSER_VERIFIED: published-only landing, score display, guidance grouping and one canonical Deng');
   await c.query("INSERT INTO appointments(org_id,user_id,role,scope_dept_id,valid_from) VALUES($1,$2,'HEAD',$3,current_date)",[ids.org,people[2],dept]);
   await c.query("UPDATE cycle_participants SET role_snapshot='HEAD' WHERE cycle_id=$1 AND user_id=$2",[cycle,people[2]]);
   for(const cap of ['workspace.oversight','progress.read','assignment.manage','result.read_published'])await c.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type,scope_id) VALUES($1,$2,$3,'DEPARTMENT',$4)",[ids.org,ids.canonical,cap,dept]);
   const managerToken=await sessions.createSession(ids.canonical,ids.org);await context.addCookies([{name:'s360_session',value:managerToken,domain:'127.0.0.1',path:'/'}]);
   await page.goto('http://127.0.0.1:43673/department');await page.getByText('正在加载部门进度…',{exact:true}).waitFor({state:'hidden'});
   expect(await page.getByRole('heading',{name:'人工指定评价关系'}).count()).toBe(0);
   await page.goto('http://127.0.0.1:43673/department/assignments');await page.getByRole('heading',{name:'人工指定评价关系'}).waitFor();
   await page.goto('http://127.0.0.1:43673/oversight');await page.getByRole('link',{name:'授权部门进度',exact:true}).first().waitFor();await page.getByRole('link',{name:'已发布结果',exact:true}).first().waitFor();
   await page.screenshot({path:'../../tmp/oversight-scoped-entries.png',fullPage:true});
   await page.goto('http://127.0.0.1:43673/organization');const productCard=page.locator('.dept-card').filter({has:page.getByRole('heading',{name:'产品部',exact:true})});await productCard.locator('.member-row').first().waitFor();expect(await productCard.locator('.member-row .chip').first().innerText()).toBe('部长');
   const guidanceCard=page.locator('.dept-card').filter({has:page.getByRole('heading',{name:'指导组',exact:true})});expect(await guidanceCard.locator('.member-row .chip-blue').count()).toBe(2);
   console.log('BROWSER_VERIFIED: assignment dedicated page, scoped oversight entries, head first and consistent guidance labels');
  }finally{await browser.close();}
 }
 }finally{if(app)await app.close();await c.query('ROLLBACK');c.release();await db.end();}
},30000);

