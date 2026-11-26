import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { Pool } from 'pg';
import { encryptFeishuSecret } from '@360/domain';
import { CapabilityGuard, RequireCapabilities } from '../authz/capability.guard';
import { CurrentUser, type AuthContext } from './current-user.decorator';
import { FeishuAdmissionService } from './feishu-admission.service';
import { FeishuService } from './feishu.service';
import { SessionGuard } from './session.guard';
import { SESSION_COOKIE, SessionService } from './session.service';

@Controller()
export class OpenSetupController {
  constructor(
    @Inject('DATABASE_POOL') private readonly db: Pool,
    private readonly config: ConfigService,
    private readonly feishu: FeishuService,
    private readonly sessions: SessionService,
    private readonly admission: FeishuAdmissionService,
  ) {}

  @Get('auth/setup')
  async setupStatus() {
    const pending = await this.db.query('SELECT 1 FROM installation_setup WHERE consumed_at IS NULL');
    return { data: { available: this.setupToken().length >= 32 && !!pending.rowCount } };
  }

  private setupToken() {
    return this.config.get<string>('INITIAL_SETUP_TOKEN')?.trim() ?? '';
  }

  @Post('auth/setup')
  async setup(@Body() body: {token?: unknown}, @Req() req: Request, @Res({passthrough: true}) res: Response) {
    const expected = this.setupToken();
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (expected.length < 32 || typeof body?.token !== 'string' || !timingSafeEqual(hash(expected), hash(body.token))) {
      throw new ForbiddenException({code: 'SETUP_TOKEN_INVALID'});
    }
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const setup = (await client.query('UPDATE installation_setup SET consumed_at=now() WHERE consumed_at IS NULL RETURNING org_id,user_id')).rows;
      if (setup.length !== 1) throw new ConflictException({code: 'SETUP_ALREADY_USED'});
      const session = await this.sessions.createSession(setup[0].user_id, setup[0].org_id, req.headers['user-agent'], client);
      await client.query('COMMIT');
      res.cookie(SESSION_COOKIE, session, this.admission.cookieOptions());
      return {data: {ok: true}};
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Get('integrations/feishu/settings')
  @UseGuards(SessionGuard, CapabilityGuard)
  @RequireCapabilities('org.manage')
  settings(@CurrentUser() actor: AuthContext) {
    const matches = this.config.get('FEISHU_ORG_ID') === actor.orgId;
    return {data: {appId: matches ? this.config.get('FEISHU_APP_ID') : '', tenantKey: matches ? this.config.get('FEISHU_TENANT_KEY') : '',
      redirectUri: new URL('/api/v1/auth/feishu/callback', this.config.getOrThrow('APP_ORIGIN')).href}};
  }

  @Post('integrations/feishu/settings')
  @UseGuards(SessionGuard, CapabilityGuard)
  @RequireCapabilities('org.manage')
  async configure(@CurrentUser() actor: AuthContext, @Body() body: {appId?: unknown; secret?: unknown; tenantKey?: unknown}) {
    const {appId, secret, tenantKey} = body ?? {};
    if (typeof appId !== 'string' || !/^cli_[a-zA-Z0-9]{6,64}$/.test(appId) ||
        typeof secret !== 'string' || !secret.trim() || secret.length > 256 ||
        typeof tenantKey !== 'string' || !/^[a-zA-Z0-9_-]{4,128}$/.test(tenantKey)) {
      throw new BadRequestException({code: 'INVALID_FEISHU_SETTINGS'});
    }
    const master = this.config.getOrThrow<string>('SESSION_SECRET');
    if (master.length < 32 || /change[-_ ]?me/i.test(master)) throw new BadRequestException({code: 'SET_STRONG_SESSION_SECRET'});
    const redirectUri = new URL('/api/v1/auth/feishu/callback', this.config.getOrThrow('APP_ORIGIN'));
    if (this.config.get('APP_ENV') === 'production' && redirectUri.protocol !== 'https:') {
      throw new BadRequestException({code: 'FEISHU_HTTPS_REQUIRED'});
    }
    const currentApp = this.config.get('FEISHU_APP_ID');
    if (currentApp && (currentApp !== appId || this.config.get('FEISHU_TENANT_KEY') !== tenantKey ||
      this.config.get('FEISHU_ORG_ID') !== actor.orgId)) throw new ConflictException({code: 'FEISHU_MAPPING_ALREADY_SET'});
    const connection = {appId, secret, tenantKey};
    const directory = await this.feishu.readDirectory(actor.orgId, connection);
    const saved = await this.db.query(`INSERT INTO feishu_connections(org_id,app_id,tenant_key,encrypted_secret) VALUES($1,$2,$3,$4)
      ON CONFLICT(org_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret
      WHERE feishu_connections.app_id=EXCLUDED.app_id AND feishu_connections.tenant_key=EXCLUDED.tenant_key`,
      [actor.orgId, appId, tenantKey, encryptFeishuSecret(secret, master, actor.orgId)]);
    if (!saved.rowCount) throw new ConflictException({code: 'FEISHU_MAPPING_ALREADY_SET'});
    await this.feishu.refreshConnection();
    return {data: {visibleMembers: directory.users.length}};
  }

  private async roster(actor: AuthContext) {
    const directory = await this.feishu.readDirectory(actor.orgId);
    const members = (await this.db.query(`SELECT u.display_name, u.status, u.result_view_only, e.external_id, e.approved
      FROM users u LEFT JOIN external_identities e ON e.user_id=u.id AND e.provider='FEISHU' AND e.tenant_key=$2 WHERE u.org_id=$1`,
      [actor.orgId, directory.tenantKey])).rows;
    const mapped = new Map(members.filter(row => row.external_id).map(row => [row.external_id, row]));
    const names = new Set(members.map(row => row.display_name));
    return {...directory, users: directory.users.filter(user => user.active && user.name.trim()).map(user => {
      const member = mapped.get(user.openId);
      const status = member ? (member.approved && member.status === 'ACTIVE' && !member.result_view_only ? 'existing' : 'conflict') : names.has(user.name) ? 'conflict' : 'new';
      return {...user, status};
    })};
  }

  @Get('integrations/feishu/import')
  @UseGuards(SessionGuard, CapabilityGuard)
  @RequireCapabilities('org.manage')
  async preview(@CurrentUser() actor: AuthContext) {
    const directory = await this.roster(actor);
    return {data: directory.users.map(({openId, name, departmentNames, status}) => ({openId, name, departmentNames, status}))};
  }

  @Post('integrations/feishu/import')
  @UseGuards(SessionGuard, CapabilityGuard)
  @RequireCapabilities('org.manage')
  async apply(@CurrentUser() actor: AuthContext, @Body() body: {ids?: unknown}) {
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(id))) {
      throw new BadRequestException({code: 'INVALID_IMPORT_SELECTION'});
    }
    const requested = new Set<string>(ids);
    const directory = await this.roster(actor);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [actor.orgId]);
      let created = 0, updated = 0;
      for (const member of directory.users) {
        if (!requested.has(member.openId) || member.status === 'conflict') continue;
        const identity = (await client.query(`SELECT u.id,u.org_id,u.status,u.result_view_only,e.approved FROM external_identities e
          JOIN users u ON u.id=e.user_id WHERE e.provider='FEISHU' AND e.tenant_key=$1 AND e.external_id=$2 FOR UPDATE OF e,u`,
          [directory.tenantKey, member.openId])).rows[0];
        let userId: string;
        if (identity) {
          if (identity.org_id !== actor.orgId || identity.status !== 'ACTIVE' || !identity.approved || identity.result_view_only) continue;
          userId = identity.id;
          const result = await client.query('UPDATE users SET display_name=$2,row_version=row_version+1,updated_at=now() WHERE id=$1 AND display_name<>$2', [userId, member.name]);
          updated += result.rowCount ?? 0;
          continue;
        }
        if (member.status === 'existing') continue;
        if ((await client.query('SELECT 1 FROM users WHERE org_id=$1 AND display_name=$2', [actor.orgId, member.name])).rowCount) continue;
        userId = (await client.query('INSERT INTO users(id,org_id,display_name) VALUES(gen_random_uuid(),$1,$2) RETURNING id', [actor.orgId, member.name])).rows[0].id;
        await client.query("INSERT INTO external_identities(user_id,provider,tenant_key,external_id,approved) VALUES($1,'FEISHU',$2,$3,true)",
          [userId, directory.tenantKey, member.openId]);
        const department = member.departments[0];
        if (department) {
          const dept = (await client.query(`INSERT INTO departments(id,org_id,code,name) VALUES(gen_random_uuid(),$1,$2,$3)
            ON CONFLICT(org_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
            [actor.orgId, 'feishu:'+department.id, department.name])).rows[0];
          await client.query('INSERT INTO department_memberships(org_id,user_id,department_id,valid_from) VALUES($1,$2,$3,current_date)',
            [actor.orgId, userId, dept.id]);
        }
        created++;
      }
      const skipped = requested.size - created - updated;
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason)
        VALUES($1,$2,'FEISHU_ROSTER_IMPORT','organization',$1::uuid::text,$3)`, [actor.orgId, actor.userId, JSON.stringify({created,updated,skipped})]);
      await client.query('COMMIT');
      return {data: {created, updated, skipped}};
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
