import '../../../scripts/test-db-setup.cjs';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { createHash,randomUUID } from 'node:crypto';
import { beforeAll,afterAll,it,expect } from 'vitest';
import { AppModule } from '../src/app.module';
import { FeishuService } from '../src/auth/feishu.service';

// Provider exchange is stubbed; controller, admission, sessions, audit and PostgreSQL are real.
let app:any,db:Pool,base:string,user:any,identityId:string;
const tenant='isolated-'+randomUUID(),external='ou_'+randomUUID().replaceAll('-','');
const sessions:string[]=[];
beforeAll(async()=>{
  db=new Pool({connectionString:process.env.DATABASE_URL});
  user={id:randomUUID(),org_id:randomUUID()};
  await db.query("INSERT INTO organizations(id,name,timezone) VALUES($1,'隔离登录回归组织','Asia/Shanghai')",[user.org_id]);
  await db.query("INSERT INTO users(id,org_id,display_name,status) VALUES($1,$2,'隔离登录测试身份','ACTIVE')",[user.id,user.org_id]);
  identityId=randomUUID();
  await db.query("INSERT INTO external_identities(id,user_id,provider,tenant_key,external_id,approved) VALUES($1,$2,'FEISHU',$3,$4,true)",[identityId,user.id,tenant,external]);
  const values={...process.env,APP_ENV:'production',APP_ORIGIN:'http://81.70.191.136',ALLOW_INSECURE_HTTP_ORIGIN:'http://81.70.191.136',FEISHU_REDIRECT_URI:'http://81.70.191.136/api/v1/auth/feishu/callback',FEISHU_ORG_ID:user.org_id,FEISHU_TENANT_KEY:tenant};
  const module=await Test.createTestingModule({imports:[AppModule]})
    .overrideProvider(ConfigService).useValue(new ConfigService(values))
    .overrideProvider(FeishuService).useValue({enabled:()=>true,authorizeUrl:(state:string)=>'https://example.invalid/auth?state='+state,exchange:async()=>({tenant_key:tenant,open_id:external})}).compile();
  app=module.createNestApplication();app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');
  base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api/v1';
});
afterAll(async()=>{
  if(app)await app.close();
  if(db){if(sessions.length)await db.query('DELETE FROM sessions WHERE id_hash=ANY($1::text[])',[sessions]);if(identityId)await db.query('DELETE FROM external_identities WHERE id=$1',[identityId]);await db.end();}
});
async function callback(){
  const start=await fetch(base+'/auth/feishu/start',{redirect:'manual'});expect(start.status).toBe(302);
  const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cookie=start.headers.getSetCookie().find(c=>c.startsWith('s360_feishu_state='))!.split(';')[0];
  return fetch(base+'/auth/feishu/callback?code=isolated-provider-code&state='+encodeURIComponent(state),{redirect:'manual',headers:{cookie}});
}
it('approved callback commits the session and UUID/text audit, authenticates /me, and logout revokes it',async()=>{
  const response=await callback();expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('/');
  const session=response.headers.getSetCookie().find(c=>/^s360_session=[^;]/.test(c))!;
  expect(session).toContain('HttpOnly');expect(session).toContain('SameSite=Lax');expect(session).not.toContain('; Secure');
  const cookie=session.split(';')[0],token=cookie.slice('s360_session='.length),hash=createHash('sha256').update(token).digest('hex');sessions.push(hash);
  const stored=(await db.query('SELECT user_id FROM sessions WHERE id_hash=$1',[hash])).rows;expect(stored).toEqual([{user_id:user.id}]);
  const audit=(await db.query("SELECT actor_id,resource_id FROM audit_events WHERE org_id=$1 AND actor_id=$2 AND action='auth.feishu.login' ORDER BY id DESC LIMIT 1",[user.org_id,user.id])).rows;
  expect(audit).toEqual([{actor_id:user.id,resource_id:user.id}]);
  const me=await fetch(base+'/me',{headers:{cookie}});expect(me.status).toBe(200);expect((await me.json()).data.user.id).toBe(user.id);
  expect((await fetch(base+'/auth/logout',{method:'POST',headers:{cookie}})).status).toBe(200);
  expect((await fetch(base+'/me',{headers:{cookie}})).status).toBe(401);
});
it('revoked identities remain denied rather than being recreated or silently approved',async()=>{
  await db.query('UPDATE external_identities SET approved=false WHERE id=$1',[identityId]);
  const response=await callback();expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('/login?error=FEISHU_ACCOUNT_UNLINKED');
  expect((await db.query('SELECT 1 FROM feishu_admission_requests WHERE tenant_key=$1 AND external_id=$2',[tenant,external])).rowCount).toBe(0);
  expect(response.headers.getSetCookie().some(c=>/^s360_session=[^;]/.test(c))).toBe(false);
});
