import 'reflect-metadata';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {Test} from '@nestjs/testing';
import {CyclesController} from '../src/cycles/cycles.controller';
import {CyclesService} from '../src/cycles/cycles.service';
import {RulesetsService} from '../src/cycles/rulesets.service';
import {AssignmentService} from '../src/cycles/assignment.service';
import {DepartmentProgressService} from '../src/cycles/department-progress.service';
import {ResultsController} from '../src/results/results.controller';
import {ResultsService} from '../src/results/results.service';
import {PublishService} from '../src/results/publish.service';
import {PublishedDirectoryService} from '../src/results/published-directory.service';
import {SessionGuard} from '../src/auth/session.guard';
import {PolicyService} from '../src/authz/policy.service';
import {CapabilityGuard} from '../src/authz/capability.guard';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
let app:any,url:string,grants:any[]=[];
const actor={userId:'actor',orgId:'org',displayName:'user',sessionIdHash:'hash'};
const query=vi.fn(async(sql:string,p:any[])=>{
 if(sql.includes('FROM effective_capability_grants'))return {rows:grants,rowCount:grants.length};
 if(sql.includes('FROM cycles'))return {rows:[{id:p[0],cycle_id:p[0],dept_id:null}],rowCount:1};
 return {rows:[],rowCount:0};
});
const updates=vi.fn(async()=>({id:a}));
beforeAll(async()=>{
 const policy=new PolicyService({query} as any);
 const module=await Test.createTestingModule({controllers:[CyclesController,ResultsController],providers:[CapabilityGuard,
 {provide:PolicyService,useValue:policy},{provide:CyclesService,useValue:{updateCycle:updates}},
 {provide:RulesetsService,useValue:{}},{provide:AssignmentService,useValue:{}},{provide:DepartmentProgressService,useValue:{}},
 {provide:PublishedDirectoryService,useValue:{list:async()=>[]}},{provide:ResultsService,useValue:{listReviewScores:async()=>[]}},{provide:PublishService,useValue:new PublishService({query} as any)}]})
 .overrideGuard(SessionGuard).useValue({canActivate:(ctx:any)=>{ctx.switchToHttp().getRequest().auth=actor;return true;}}).compile();
 app=module.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');url=await app.getUrl();
});
afterAll(async()=>{await app?.close();});
describe('Real controller and guard HTTP pipeline with database doubles',()=>{
 it('cycle A grant PATCH cycle B -> 403 before service update',async()=>{grants=[{capability:'cycle.manage',scope_type:'CYCLE',scope_id:a}];updates.mockClear();const r=await fetch(url+'/api/v1/cycles/'+b,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'});expect(r.status).toBe(403);expect(updates).not.toHaveBeenCalled();});
 it('cycle A grant PATCH cycle A -> 200',async()=>{grants=[{capability:'cycle.manage',scope_type:'CYCLE',scope_id:a}];const r=await fetch(url+'/api/v1/cycles/'+a,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'});expect(r.status).toBe(200);expect(updates).toHaveBeenCalled();});
 it('result confirmer cannot read raw scores -> 403',async()=>{grants=[{capability:'result.confirm',scope_type:'ORG',scope_id:null}];const r=await fetch(url+'/api/v1/cycles/'+a+'/review-scores');expect(r.status).toBe(403);});
 it('authorized raw cycle A cannot read raw cycle B -> 403',async()=>{grants=[{capability:'calibration.read_raw',scope_type:'CYCLE',scope_id:a}];const r=await fetch(url+'/api/v1/cycles/'+b+'/review-scores');expect(r.status).toBe(403);});
 it('query user_id cannot change own-result owner -> 200 empty',async()=>{grants=[];query.mockClear();const r=await fetch(url+'/api/v1/me/results?user_id=other');expect(r.status).toBe(200);expect(await r.json()).toEqual({data:[]});expect(query.mock.calls[0][1]).toEqual(['org','actor']);});
});
