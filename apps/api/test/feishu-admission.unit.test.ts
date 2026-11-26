import 'reflect-metadata';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {FeishuAdmissionService} from '../src/auth/feishu-admission.service';
import {AuthController} from '../src/auth/auth.controller';
import {SessionService} from '../src/auth/session.service';
const org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222';
const row=(rows:any[]=[])=>({rows,rowCount:rows.length});
function setup(identityRows:any[]=[{id:user,org_id:org}]){
 const query=vi.fn(async(sql:string)=>sql.includes('SELECT u.id,u.org_id FROM external_identities')?row(identityRows):row());
 const db={query,connect:vi.fn()} as any;const client={query,release:vi.fn()};db.connect.mockResolvedValue(client);
 const config={get:(k:string)=>({FEISHU_TENANT_KEY:'tenant-a',FEISHU_ORG_ID:org,APP_ENV:'production'} as any)[k]} as any;
 const sessions={createSession:vi.fn(async()=> 'never-log-this-token')} as any;
 return {db,client,config,sessions,service:new FeishuAdmissionService(db,config,sessions)};
}
afterEach(()=>vi.useRealTimers());
describe('Feishu admission without provider calls or database writes',()=>{
 it('HTTP exception keeps HttpOnly/SameSite and disables Secure only for the approved origin',()=>{
  const {service,config}=setup();const values={APP_ENV:'production',APP_ORIGIN:'http://81.70.191.136',FEISHU_REDIRECT_URI:'http://81.70.191.136/api/v1/auth/feishu/callback',ALLOW_INSECURE_HTTP_ORIGIN:'http://81.70.191.136'};
  config.get=(key:string)=>(values as any)[key];expect(service.cookieOptions()).toMatchObject({secure:false,httpOnly:true,sameSite:'lax',maxAge:43200000});
  values.ALLOW_INSECURE_HTTP_ORIGIN='http://other.example';expect(service.cookieOptions().secure).toBe(true);
 });
 it('state is unpredictable, browser-bound and single use',()=>{const {service}=setup();const state=service.issueState();expect(state.length).toBeGreaterThan(32);expect(()=>service.consumeState(state,'wrong')).toThrow();service.consumeState(state,state);expect(()=>service.consumeState(state,state)).toThrow();});
 it('expired state cannot be used',()=>{vi.useFakeTimers();const {service}=setup();const state=service.issueState();vi.advanceTimersByTime(600001);expect(()=>service.consumeState(state,state)).toThrow();});
 it('unissued matching cookie and state are rejected',()=>{expect(()=>setup().service.consumeState('attacker','attacker')).toThrow();});
 it('production cookies are Secure HttpOnly Lax with explicit lifetime',()=>{const {service}=setup();expect(service.cookieOptions()).toMatchObject({httpOnly:true,secure:true,sameSite:'lax',path:'/api/v1',maxAge:43200000});expect(service.cookieOptions(true).maxAge).toBe(600000);});
 it('missing organization mapping fails closed',()=>{const {db,sessions}=setup();const service=new FeishuAdmissionService(db,{get:()=>''} as any,sessions);expect(()=>service.issueState()).toThrow();expect(db.connect).not.toHaveBeenCalled();});
 it.each(['wrong-tenant',undefined])('tenant %s never opens a session',async tenant=>{const {service,sessions,db}=setup();await expect(service.login({tenant_key:tenant,open_id:'ou_user'})).rejects.toMatchObject({status:401});expect(sessions.createSession).not.toHaveBeenCalled();expect(db.connect).not.toHaveBeenCalled();});
 it('unknown, revoked, unapproved or disabled identity returns 401 without account creation',async()=>{const {service,sessions,client}=setup([]);await expect(service.login({tenant_key:'tenant-a',open_id:'ou_user'})).rejects.toMatchObject({status:401});expect(sessions.createSession).not.toHaveBeenCalled();expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO users')||sql.includes('INSERT INTO external_identities'))).toBe(false);const lookup=client.query.mock.calls.find(([sql])=>sql.includes('SELECT u.id,u.org_id'))![0];for(const text of ['e.approved=true',"u.status='ACTIVE'",'u.org_id=$3'])expect(lookup).toContain(text);});
 it('approved active mapped identity creates exactly one session and commits',async()=>{const {service,sessions,client}=setup();expect(await service.login({tenant_key:'tenant-a',open_id:'ou_user'})).toBe('never-log-this-token');expect(sessions.createSession).toHaveBeenCalledWith(user,org,undefined,client);expect(client.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(true);});
 it('internal account binding cannot be silently reassigned',async()=>{const {service,db,client}=setup();client.query.mockImplementation(async(sql:string)=>sql.includes('SELECT id FROM users')?row([{id:user}]):sql.includes('SELECT id,user_id')?row([{id:org,user_id:'another'}]):row());await expect(service.bind({userId:user,orgId:org} as any,{user_id:user,external_id:'ou_id',reason:'verified identity'})).rejects.toMatchObject({status:409});expect(db.query.mock.calls.some(([sql]:any)=>sql.includes('SET approved=true'))).toBe(false);});
 it('binding revocation also revokes sessions in the same transaction',async()=>{const {service,client}=setup();client.query.mockImplementation(async(sql:string)=>sql.includes('SELECT e.tenant_key')?row([{tenant_key:'tenant-a',external_id:'ou_id'}]):sql.includes('SELECT e.user_id')?row([{user_id:user}]):row());await service.revoke({userId:user,orgId:org} as any,user);expect(client.query.mock.calls.some(([sql])=>sql.includes('UPDATE sessions SET revoked_at'))).toBe(true);expect(client.query.mock.calls.some(([sql])=>sql.includes('auth.feishu.revoke'))).toBe(true);});
 it('production rejects demo login and demo users before querying database',async()=>{const {db,config,sessions,service}=setup();const controller=new AuthController(sessions,config,db,{} as any,{} as any,service);await expect(controller.demoLogin({user_id:user},{} as any,{} as any)).rejects.toMatchObject({status:403});await expect(controller.demoUsers()).rejects.toMatchObject({status:403});expect(db.query).not.toHaveBeenCalled();});
 it('logout revokes session and clears secure cookie',async()=>{const {db,config,service}=setup();const sessions={revokeSession:vi.fn(),writeAudit:vi.fn()} as any;const controller=new AuthController(sessions,config,db,{} as any,{} as any,service);const res={clearCookie:vi.fn()};await controller.logout({userId:user,orgId:org,sessionIdHash:'hash'} as any,{headers:{cookie:'s360_session=token'}} as any,res as any);expect(sessions.revokeSession).toHaveBeenCalledWith('token');expect(res.clearCookie).toHaveBeenCalledWith('s360_session',expect.objectContaining({secure:true,httpOnly:true}));});
 it('session service refuses inactive users and never stores plaintext token',async()=>{const db={query:vi.fn(async()=>row())} as any;await expect(new SessionService(db).createSession(user,org)).rejects.toMatchObject({status:401});const [sql,params]=db.query.mock.calls[0];expect(sql).toContain("u.status='ACTIVE'");expect(params[0]).toMatch(/^[0-9a-f]{64}$/);});
});
