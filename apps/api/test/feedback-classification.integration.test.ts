import '../../../scripts/test-db-setup.cjs';
import 'reflect-metadata';
import {Pool} from 'pg';
import {randomUUID as id} from 'node:crypto';
import {Test} from '@nestjs/testing';
import {it,expect} from 'vitest';
import {AppModule} from '../src/app.module';
import {DATABASE_POOL} from '../src/database/database.module';
import {SessionService} from '../src/auth/session.service';
import {APPEAL_SCOPES,encodeAppeal} from '@360/domain';
it('classified feedback HTTP: persistence, ownership, mapping, legacy reads and closed-record protection',async()=>{
 const db=new Pool({connectionString:process.env.DATABASE_URL}),c=await db.connect();let app:any;
 const org=id(),owner=id(),other=id(),admin=id(),foreignOrg=id(),foreign=id(),dept=id(),cycle=id(),build=id();
 try{
 await c.query('BEGIN');
 for(const o of [org,foreignOrg])await c.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'申诉分类隔离测试','Asia/Shanghai')",[o]);
 for(const [u,o] of [[owner,org],[other,org],[admin,org],[foreign,foreignOrg]])await c.query("INSERT INTO users(id,org_id,display_name) VALUES($1,$2,'隔离申诉成员')",[u,o]);
 await c.query("INSERT INTO departments(id,org_id,code,name) VALUES($1,$2,'DEMO','测试部门')",[dept,org]);
 await c.query("INSERT INTO cycles(id,org_id,month,title,status) VALUES($1,$2,'2041-01-01','隔离申诉周期','PUBLISHED')",[cycle,org]);
 await c.query("INSERT INTO cycle_participants(cycle_id,org_id,user_id,dept_snapshot,role_snapshot) VALUES($1,$2,$3,$4,'MEMBER')",[cycle,org,owner,dept]);
 await c.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type) VALUES($1,$2,'feedback.manage','ORG')",[org,admin]);
 await c.query("INSERT INTO result_builds(id,cycle_id,org_id,target_id,input_hash,formula_version,status) VALUES($1,$2,$3,$4,'classification','fixture','PUBLISHED')",[build,cycle,org,owner]);
 let version=0;async function publication(age='0 hours') {const pub=id();await c.query("INSERT INTO published_results(id,cycle_id,org_id,target_id,publication_version,result_build_id,payload_json,published_at) VALUES($1,$2,$3,$4,$5,$6,'{}',now()-$7::interval)",[pub,cycle,org,owner,++version,build,age]);return pub;}
 // All service transactions use savepoints; the entire fixture is rolled back at the end.
 const adapter={query:async(sql:string,values?:any[])=>c.query(sql==='BEGIN'?'SAVEPOINT feedback_action':sql==='COMMIT'?'RELEASE SAVEPOINT feedback_action':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT feedback_action':sql,values),release:()=>{}};
 const pool={query:c.query.bind(c),connect:async()=>adapter};
 const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(DATABASE_POOL).useValue(pool).compile();app=module.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');
 const sessions=app.get(SessionService),cookies=new Map<string,string>();for(const [u,o] of [[owner,org],[other,org],[admin,org],[foreign,foreignOrg]])cookies.set(u,'s360_session='+await sessions.createSession(u,o));
 const base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api/v1';async function req(path:string,body?:unknown,user=owner){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookies.get(user)??''},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};}
 const valid=encodeAppeal('评价流程问题',['评价提交'],'事实依据');
 const pub=await publication();for(const reason of [encodeAppeal('评价结果异议',['评价任务'],'事实'),'未分类',encodeAppeal('评价数据问题',[],'事实'),encodeAppeal('其他问题',[],' '.repeat(20)),encodeAppeal('其他问题',[],'中'.repeat(501))])expect((await req('/published-results/'+pub+'/feedback-requests',{reason})).status).toBe(400);
 expect((await req('/published-results/'+pub+'/feedback-requests',{reason:valid},other)).status).toBe(403);
 expect((await req('/published-results/'+pub+'/feedback-requests',{reason:valid},foreign)).status).toBe(404);
 expect((await req('/published-results/'+await publication('30 days')+'/feedback-requests',{reason:valid})).status).toBe(400);
 for(const [type,scopes] of Object.entries(APPEAL_SCOPES))for(const scope of scopes.length?scopes:['']){
  const p=await publication(),reason=encodeAppeal(type,scope?[scope]:[],'事实\n补充说明');const created=await req('/published-results/'+p+'/feedback-requests',{reason});expect(created.status).toBe(201);
  const row=(await c.query('SELECT reason,applicant_id,status FROM feedback_requests WHERE id=$1',[created.body.data.id])).rows[0];expect(row).toMatchObject({reason,applicant_id:owner,status:'PENDING'});
  expect((await req('/published-results/'+p+'/feedback-requests',{reason})).status).toBe(409);
 }
 const legacy=id();await c.query("INSERT INTO feedback_requests(id,publication_id,org_id,applicant_id,reason,status) VALUES($1,$2,$3,$4,'历史未分类原文','PENDING')",[legacy,pub,org,owner]);
 const mine=await req('/feedback-requests/mine');expect(mine.status).toBe(200);expect(mine.body.data.find((x:any)=>x.id===legacy).reason).toBe('历史未分类原文');expect(JSON.stringify(mine.body)).not.toMatch(/reviewer_id|dimension_json|final_score/);
 expect((await req('/feedback-requests/mine',undefined,other)).body.data).toHaveLength(0);
 expect((await req('/feedback-requests/'+legacy+'/context',undefined,other)).status).toBe(403);
 expect((await req('/feedback-requests/'+legacy+'/resolve',{decision:'APPROVED',note:'核查说明'},other)).status).toBe(403);
 expect((await req('/feedback-requests/'+legacy+'/resolve',{decision:'APPROVED',note:'核查说明'},admin)).status).toBe(201);
 expect((await req('/feedback-requests/'+legacy+'/resolve',{decision:'REJECTED',note:'尝试覆盖'},admin)).status).toBe(409);
 expect((await c.query('SELECT reason,status FROM feedback_requests WHERE id=$1',[legacy])).rows[0]).toEqual({reason:'历史未分类原文',status:'DONE'});
 expect((await req('/feedback-requests',undefined,admin)).body.data.length).toBeGreaterThan(1);
 }finally{if(app)await app.close();await c.query('ROLLBACK');c.release();await db.end();}
},60000);
