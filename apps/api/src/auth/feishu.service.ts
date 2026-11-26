import { randomBytes } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { readFeishuConnection, type FeishuConnection } from '@360/domain';

type Json = Record<string, any>;

@Injectable()
export class FeishuService {
  constructor(private readonly config: ConfigService, @Inject('DATABASE_POOL') private readonly db: Pool) {}

  async onModuleInit() {
    if (process.env.APP_ENV !== 'test') await this.refreshConnection();
  }

  async refreshConnection() {
    const row = (await this.db.query('SELECT org_id FROM feishu_connections LIMIT 1')).rows[0];
    if (!row) return;
    const connection = await readFeishuConnection(this.db, row.org_id, this.config.getOrThrow('SESSION_SECRET'));
    if (!connection) return;
    this.config.set('FEISHU_APP_ID', connection.appId);
    this.config.set('FEISHU_APP_SECRET', connection.secret);
    this.config.set('FEISHU_TENANT_KEY', connection.tenantKey);
    this.config.set('FEISHU_ORG_ID', row.org_id);
    this.config.set('FEISHU_REDIRECT_URI', new URL('/api/v1/auth/feishu/callback', this.config.getOrThrow('APP_ORIGIN')).href);
  }

  enabled() { return !!(this.config.get<string>('FEISHU_APP_ID') && this.config.get<string>('FEISHU_APP_SECRET') && this.config.get<string>('FEISHU_REDIRECT_URI') && this.config.get<string>('FEISHU_TENANT_KEY') && this.config.get<string>('FEISHU_ORG_ID')); }
  state() { return randomBytes(24).toString('base64url'); }
  authorizeUrl(state: string) {
    const q = new URLSearchParams({ app_id: this.config.get<string>('FEISHU_APP_ID')!, redirect_uri: this.config.get<string>('FEISHU_REDIRECT_URI')!, state });
    return `https://open.feishu.cn/open-apis/authen/v1/authorize?${q}`;
  }
  private async post(path: string, body: Json, token?: string): Promise<Json> {
    const r = await fetch(`https://open.feishu.cn/open-apis${path}`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const j = await r.json() as Json;
    if (!r.ok || j.code) throw new ServiceUnavailableException({ code: 'FEISHU_API_ERROR', detail: j.msg ?? `HTTP_${r.status}` });
    return j;
  }
  private async get(path: string, token: string): Promise<Json> {
    const r = await fetch(`https://open.feishu.cn/open-apis${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json() as Json;
    if (!r.ok || j.code) throw new ServiceUnavailableException({ code: 'FEISHU_API_ERROR', detail: j.msg ?? `HTTP_${r.status}` });
    return j;
  }
  private async list(path: string, token: string): Promise<Json[]> {
    const out: Json[] = []; let page = '';
    do {
      const sep = path.includes('?') ? '&' : '?';
      const j = await this.get(`${path}${sep}page_size=50${page ? `&page_token=${encodeURIComponent(page)}` : ''}`, token);
      out.push(...(j.data?.items ?? [])); page = j.data?.page_token ?? ''; if (!j.data?.has_more) page = '';
    } while (page);
    return out;
  }
  async exchange(code: string) {
    const app = await this.post('/auth/v3/app_access_token/internal', { app_id: this.config.get('FEISHU_APP_ID'), app_secret: this.config.get('FEISHU_APP_SECRET') });
    const appToken = String(app.app_access_token ?? app.data?.app_access_token ?? '');
    if (!appToken) throw new ServiceUnavailableException({ code: 'FEISHU_APP_TOKEN_MISSING' });
    const j = await this.post('/authen/v1/access_token', { grant_type: 'authorization_code', code }, appToken);
    const d = j.data ?? j;
    const info = await this.get('/authen/v1/user_info', d.access_token);
    return { ...d, ...(info.data ?? info) };
  }
  async tenantToken(connection?: FeishuConnection) {
    const j = await this.post('/auth/v3/tenant_access_token/internal', { app_id: connection?.appId ?? this.config.get('FEISHU_APP_ID'), app_secret: connection?.secret ?? this.config.get('FEISHU_APP_SECRET') });
    return (j.tenant_access_token ?? j.data?.tenant_access_token) as string;
  }
  /** Read-only directory projection for identity verification. Never calls sync or writes membership data. */
  async readDirectory(orgId:string, connection?: FeishuConnection) {
    const tenantKey=connection?.tenantKey ?? this.config.get<string>('FEISHU_TENANT_KEY'),appId=connection?.appId ?? this.config.get<string>('FEISHU_APP_ID');
    if((!connection && this.config.get('FEISHU_ORG_ID')!==orgId)||!tenantKey||!appId)throw new ServiceUnavailableException({code:'FEISHU_MAPPING_NOT_CONFIGURED'});
    const token=await this.tenantToken(connection);
    const read=async(path:string)=>{
      const response=await fetch('https://open.feishu.cn/open-apis'+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
      const value=await response.json() as Json;
      if(!response.ok||value.code)throw new ServiceUnavailableException({code:'FEISHU_DIRECTORY_UNAVAILABLE',providerCode:value.code??response.status});
      return value;
    };
    const list=async(path:string)=>{const out:Json[]=[];let page='';const seen=new Set<string>();do{
      const data=(await read(path+'&page_size=50'+(page?'&page_token='+encodeURIComponent(page):''))).data??{};
      out.push(...(data.items??[]));if(out.length>10000)throw new ServiceUnavailableException({code:'FEISHU_DIRECTORY_TOO_LARGE'});
      page=data.has_more?data.page_token:'';
      if(data.has_more&&(!page||seen.has(page)))throw new ServiceUnavailableException({code:'FEISHU_DIRECTORY_INCOMPLETE'});
      seen.add(page);
    }while(page);return out;};
    const queue=['0'],visited=new Set<string>(),departments=new Map<string,string>(),people=new Map<string,Json>();
    while(queue.length){const parent=queue.shift()!;if(visited.has(parent))continue;visited.add(parent);
      if(visited.size>1000)throw new ServiceUnavailableException({code:'FEISHU_DIRECTORY_TOO_LARGE'});
      for(const dept of await list('/contact/v3/departments/'+encodeURIComponent(parent)+'/children?department_id_type=open_department_id')){
        if(!dept.open_department_id)throw new ServiceUnavailableException({code:'FEISHU_DIRECTORY_INCOMPLETE'});
        departments.set(dept.open_department_id,String(dept.name??''));queue.push(dept.open_department_id);
      }
      for(const member of await list('/contact/v3/users/find_by_department?department_id='+encodeURIComponent(parent)+'&department_id_type=open_department_id&user_id_type=open_id')){
        if(!/^ou_[A-Za-z0-9_-]{1,128}$/.test(member.open_id??''))throw new ServiceUnavailableException({code:'FEISHU_DIRECTORY_INCOMPLETE'});
        people.set(member.open_id,member);
      }
    }
    // Contact readability does NOT prove app availability. No scope changes are requested.
    let visibility:{state:string;providerCode?:number}={state:'ADMIN_CONFIRMATION_REQUIRED'};
    try{await read('/application/v2/app/visibility?app_id='+encodeURIComponent(appId)+'&user_page_size=1000');visibility={state:'ADMIN_CONFIRMATION_REQUIRED',providerCode:0};}
    catch(error){visibility={state:'ADMIN_CONFIRMATION_REQUIRED',providerCode:(error as ServiceUnavailableException).getResponse instanceof Function?((error as ServiceUnavailableException).getResponse() as Json).providerCode:undefined};}
    return {tenantKey,appId,visibility,users:[...people.values()].map(member=>({
      openId:member.open_id as string,userId:typeof member.user_id==='string'?member.user_id:null,name:String(member.name??''),
      departmentNames:(member.department_ids??[]).map((id:string)=>departments.get(id)??id),
      departments:(member.department_ids??[]).filter((id:string)=>departments.get(id)).map((id:string)=>({id,name:departments.get(id)!})),
      active:!!member.status&&!member.status.is_resigned&&!member.status.is_frozen&&!member.status.is_deleted&&member.status.is_activated!==false,
    }))};
  }

  async sync(orgId: string) {
    if(this.config.get('FEISHU_ORG_ID')!==orgId||!this.config.get('FEISHU_TENANT_KEY'))throw new ServiceUnavailableException({code:'FEISHU_MAPPING_NOT_CONFIGURED'});
    const token = await this.tenantToken();
    // Feishu returns only direct children for a parent department. Walk the
    // complete tree so members in nested departments are not missed.
    const departments: Json[] = [];
    const pending = ['0'];
    while (pending.length) {
      const parent = pending.shift()!;
      const children = (await this.list(`/contact/v3/departments?parent_department_id=${encodeURIComponent(parent)}`, token))
        .filter((x: Json) => x.status?.is_deleted !== true);
      for (const d of children) {
        departments.push(d);
        const code = String(d.open_department_id ?? d.department_id ?? '');
        if (code) pending.push(code);
      }
    }
    const deptIds = new Map<string, string>();
    for (const d of departments) {
      const code = String(d.department_id ?? d.open_department_id);
      const row = (await this.db.query(`INSERT INTO departments (id, org_id, code, name) VALUES (gen_random_uuid(), $1, $2, $3) ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [orgId, code, d.name])).rows[0];
      deptIds.set(code, row.id);
    }
    // Collect members from every department. A member can appear in more
    // than one department; deduplicate by the Feishu external identifier.
    const usersByExternalId = new Map<string, Json>();
    for (const d of departments) {
      const code = String(d.open_department_id ?? d.department_id ?? '');
      if (!code) continue;
      const members = (await this.list(`/contact/v3/users?department_id=${encodeURIComponent(code)}`, token))
        .filter((x: Json) => x.status?.is_deleted !== true);
      for (const member of members) {
        const externalId = String(member.open_id ?? member.union_id ?? member.user_id ?? '');
        if (externalId) usersByExternalId.set(externalId, { ...member, __department_code: code });
      }
    }
    const users = [...usersByExternalId.values()];
    let synced = 0;
    const tenant = this.config.get('FEISHU_TENANT_KEY') || 'default';
    for (const member of users) {
      const externalId = String(member.open_id ?? member.union_id ?? member.user_id ?? ''); if (!externalId) continue;
      const name = String(member.name ?? member.en_name ?? '飞书用户');
      const row=(await this.db.query(`SELECT u.id,u.org_id FROM external_identities e JOIN users u ON u.id=e.user_id
        WHERE e.provider='FEISHU' AND e.tenant_key=$1 AND e.external_id=$2 AND e.approved=true AND u.org_id=$3 AND u.status='ACTIVE'`,[tenant,externalId,orgId])).rows[0];
      if(!row)continue; // Synchronization never grants admission or reactivates a disabled account.
      await this.db.query("UPDATE users SET display_name=$2,updated_at=now() WHERE id=$1 AND org_id=$3 AND status='ACTIVE'",[row.id,name,orgId]);
      const deptCode = String(member.department_ids?.[0] ?? member.open_department_id ?? member.department_id ?? ''); const deptId = deptIds.get(deptCode);
      if (deptId) {
        await this.db.query(`UPDATE department_memberships SET valid_to=current_date WHERE user_id=$1 AND valid_to IS NULL AND department_id <> $2`, [row.id, deptId]);
        await this.db.query(`INSERT INTO department_memberships (org_id,user_id,department_id,valid_from) VALUES ($1,$2,$3,current_date) ON CONFLICT DO NOTHING`, [orgId, row.id, deptId]);
      }
      synced++;
    }
    return { departments: departments.length, users: synced };
  }
}
