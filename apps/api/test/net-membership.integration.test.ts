import '../../../scripts/test-db-setup.cjs';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {it,expect} from 'vitest';
import {PublishedDirectoryService} from '../src/results/published-directory.service';
import {PolicyService} from '../src/authz/policy.service';
const {apply}=createRequire(import.meta.url)('../../../deploy/correct-net-membership.cjs');
it('department correction preserves membership history and grants only existing progress scopes for published results',async()=>{
 const db=new Pool({connectionString:process.env.DATABASE_URL}),c=await db.connect();
 const org=randomUUID(),user=randomUUID(),manager=randomUUID(),pd=randomUUID(),net=randomUUID();
 try{await c.query('BEGIN');await c.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'隔离部门纠正测试','Asia/Shanghai')",[org]);
 for(const [id,name] of [[user,'示例成员35'],[manager,'隔离部门管理者']])await c.query('INSERT INTO users(id,org_id,display_name) VALUES($1,$2,$3)',[id,org,name]);
 for(const [id,code,name] of [[pd,'PD','产品部'],[net,'NET','网监部']])await c.query('INSERT INTO departments(id,org_id,code,name) VALUES($1,$2,$3,$4)',[id,org,code,name]);
 await c.query('INSERT INTO department_memberships(org_id,user_id,department_id,valid_from) VALUES($1,$2,$3,current_date-1)',[org,user,pd]);
 await c.query("INSERT INTO capability_grants(org_id,user_id,capability,scope_type,scope_id) VALUES($1,$2,'progress.read','DEPARTMENT',$3)",[org,manager,pd]);
 await apply(c,org,user);await apply(c,org,user);
 expect((await c.query('SELECT department_id FROM department_memberships WHERE user_id=$1 AND valid_to IS NULL',[user])).rows).toEqual([{department_id:net}]);
 expect((await c.query('SELECT count(*)::int n FROM department_memberships WHERE user_id=$1',[user])).rows[0].n).toBe(2);
 const grants=(await c.query("SELECT capability,scope_type,scope_id FROM capability_grants WHERE user_id=$1 AND capability='result.read_published'",[manager])).rows;
 expect(grants).toEqual([{capability:'result.read_published',scope_type:'DEPARTMENT',scope_id:pd}]);
 const policy=new PolicyService({query:c.query.bind(c)} as any);
 expect(await policy.hasCapability(manager,org,'result.read_published')).toBe(false);
 expect(await policy.hasCapability(manager,org,'result.read_published',{scopeType:'DEPARTMENT',scopeId:net})).toBe(false);
 expect(await policy.hasCapability(manager,org,'result.read_published',{scopeType:'DEPARTMENT',scopeId:pd})).toBe(true);
 expect(await new PublishedDirectoryService({query:c.query.bind(c)} as any,policy).list({userId:manager,orgId:org,displayName:'test',sessionIdHash:'test'})).toEqual([]);
 }finally{await c.query('ROLLBACK');c.release();await db.end();}
});
