import 'reflect-metadata';
import { describe,it,expect,vi } from 'vitest';
import { PolicyService } from '../src/authz/policy.service';
import { CapabilityGuard,CAPABILITY_RESOURCE } from '../src/authz/capability.guard';
import { RulesetsService } from '../src/cycles/rulesets.service';
import { AssignmentService } from '../src/cycles/assignment.service';
import { MaterialsService } from '../src/report/materials.service';
import { PublishService } from '../src/results/publish.service';
import { OrgController } from '../src/org/org.controller';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const actor={userId:'actor',orgId:'org',displayName:'user',sessionIdHash:'hash'};
const result=(rows:any[]=[])=>({rows,rowCount:rows.length});
function fixture(grants:any[]){
 const query=vi.fn(async(sql:string,p:any[])=>sql.includes('FROM effective_capability_grants')?result(grants):result([{id:p[0],cycle_id:p[0],dept_id:null}]));
 const db={query} as any;return {db,query,policy:new PolicyService(db)};
}
async function status(p:Promise<any>){try{await p;return 200;}catch(e:any){return e.getStatus?.()??500;}}
describe('Scope security without database connections',()=>{
 it('department grant is not organization authority',async()=>{const {policy}=fixture([{capability:'org.manage',scope_type:'DEPARTMENT',scope_id:a}]);expect(await policy.hasCapability('actor','org','org.manage')).toBe(false);expect(await policy.hasCapability('actor','org','org.manage',{scopeType:'DEPARTMENT',scopeId:a})).toBe(true);expect(await policy.hasCapability('actor','org','org.manage',{scopeType:'DEPARTMENT'})).toBe(false);});
 it('department A to B is 403; own A is allowed',async()=>{const {policy}=fixture([{capability:'progress.read',scope_type:'DEPARTMENT',scope_id:a}]);expect(await status(policy.assertResource(actor,'progress.read','cycle',a,b))).toBe(403);expect(await status(policy.assertResource(actor,'progress.read','cycle',a,a))).toBe(200);});
 it('cycle A to B is 403; own A is allowed',async()=>{const {policy}=fixture([{capability:'cycle.manage',scope_type:'CYCLE',scope_id:a}]);expect(await status(policy.assertResource(actor,'cycle.manage','cycle',b))).toBe(403);expect(await status(policy.assertResource(actor,'cycle.manage','cycle',a))).toBe(200);});
 it('cycle A raw grant cannot read B collection',async()=>{const {policy}=fixture([{capability:'calibration.read_raw',scope_type:'CYCLE',scope_id:a}]);expect(await status(policy.assertCollection(actor,'calibration.read_raw',b))).toBe(403);});
 it('result confirmation does not grant raw access',async()=>{const {policy}=fixture([{capability:'result.confirm',scope_type:'ORG'}]);expect(await status(policy.assertCollection(actor,'calibration.read_raw',a))).toBe(403);});
 it('foreign organization resource is hidden with 404',async()=>{const {policy,query}=fixture([]);query.mockResolvedValue(result());expect(await status(policy.assertResource(actor,'cycle.manage','cycle',a))).toBe(404);});
 it('local grant cannot create organization grant',async()=>{const {db,policy,query}=fixture([{capability:'org.manage',scope_type:'DEPARTMENT',scope_id:a}]);expect(await status(new OrgController(db,policy).createGrant(actor,{user_id:b,capability:'cycle.manage',scope_type:'ORG'}))).toBe(403);expect(query.mock.calls.some(([sql])=>sql.includes('INSERT'))).toBe(false);});
 it('grantor cannot delegate unheld capability',async()=>{const {db,policy}=fixture([{capability:'org.manage',scope_type:'ORG'}]);expect(await status(new OrgController(db,policy).createGrant(actor,{user_id:b,capability:'calibration.read_raw',scope_type:'ORG'}))).toBe(403);});
 it('foreign base ruleset rejected even with config',async()=>{const db={query:vi.fn(async()=>result())} as any;expect(await status(new RulesetsService(db).createRuleset(actor,{config:{},base_ruleset_id:b}))).toBe(404);expect(db.query).toHaveBeenCalledTimes(1);});
 it('foreign replacement rejected inside the locked transaction without writes',async()=>{const query=vi.fn(async(sql:string)=>{if(sql.includes('SELECT id,status FROM cycles'))return result([{id:a,status:'REVIEWING'}]);if(sql.includes('SELECT * FROM assignments'))return result([{id:'task',status:'ACTIVE',target_id:'target'}]);return result();});const release=vi.fn();const db={connect:vi.fn(async()=>({query,release}))} as any;expect(await status(new AssignmentService(db).replaceAssignment(actor,a,'task',{reviewer_id:'foreign'}))).toBe(404);expect(query.mock.calls.some(([sql])=>sql.includes('INSERT')||sql.startsWith('UPDATE'))).toBe(false);expect(query).toHaveBeenCalledWith('ROLLBACK');expect(release).toHaveBeenCalled();});
 it('other member material returns 404 and binds owner',async()=>{const db={query:vi.fn(async()=>result())} as any;expect(await status(new MaterialsService(db).preview(actor,a,b))).toBe(404);expect(db.query.mock.calls[0][1]).toEqual([b,'org',a,'actor']);});
 it('own result projection is always bound to session user',async()=>{const db={query:vi.fn(async()=>result())} as any;expect(await new PublishService(db).listMyResults(actor)).toEqual([]);expect(db.query.mock.calls[0][1]).toEqual(['org','actor']);});
 it('raw SQL predicate binds identity and exact resource scope',()=>{const {policy}=fixture([]);const p:unknown[]=[];const sql=policy.scopedSql(actor,'calibration.read_raw','r.cycle_id','p.dept_snapshot',p);expect(p).toEqual(['actor','org','calibration.read_raw']);for(const t of ['sg.org_id=$2','sg.revoked_at IS NULL','sg.scope_id=r.cycle_id','sg.scope_id=p.dept_snapshot'])expect(sql).toContain(t);});
 it('guard denies missing scope and allows exact cycle',async()=>{const {policy}=fixture([{capability:'cycle.manage',scope_type:'CYCLE',scope_id:a}]);let resource:any;const reflector={getAllAndOverride:(k:string)=>k===CAPABILITY_RESOURCE?resource:['cycle.manage']} as any;const ctx={getHandler:()=>null,getClass:()=>null,switchToHttp:()=>({getRequest:()=>({auth:actor,params:{id:a},query:{}})})} as any;const guard=new CapabilityGuard(reflector,policy);expect(await status(guard.canActivate(ctx))).toBe(403);resource={kind:'cycle',param:'id'};expect(await status(guard.canActivate(ctx))).toBe(200);});
});
