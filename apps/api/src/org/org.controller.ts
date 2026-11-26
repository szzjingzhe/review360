import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Pool } from 'pg';
import { SessionGuard, AuthedRequest } from '../auth/session.guard';
import { CurrentUser, AuthContext } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapabilities, CapabilityResource } from '../authz/capability.guard';
import { isCapability, ScopeType } from '../authz/capabilities';
import { PolicyService } from '../authz/policy.service';

/**
 * 组织架构（PRD 3.1）：全系统同一数据源；部长单独标注，其余姓名各出现一次。
 * 任何已登录成员可读（组织架构页属于个人端）。
 */
@UseGuards(SessionGuard)
@Controller()
export class OrgController {
  constructor(
    @Inject('DATABASE_POOL') private readonly db: Pool,
    private readonly policy: PolicyService,
  ) {}

  /** Authenticated directory projection; contains no grants, external identities or sessions. */
  @Get('organization/members')
  async organizationMembers(@CurrentUser() user:AuthContext) {
    const {rows}=await this.db.query(`SELECT u.id,u.org_id,u.display_name,d.id AS dept_id,d.name AS dept_name,
      coalesce(a.roles,ARRAY[]::text[]) AS roles
      FROM users u
      LEFT JOIN LATERAL(SELECT m.department_id FROM department_memberships m WHERE m.user_id=u.id AND m.org_id=u.org_id
        AND m.valid_from<=current_date AND (m.valid_to IS NULL OR m.valid_to>current_date) ORDER BY m.valid_from DESC LIMIT 1) m ON true
      LEFT JOIN departments d ON d.id=m.department_id AND d.org_id=u.org_id
      LEFT JOIN LATERAL(SELECT array_agg(DISTINCT p.role) AS roles FROM appointments p WHERE p.user_id=u.id AND p.org_id=u.org_id
        AND p.valid_from<=current_date AND (p.valid_to IS NULL OR p.valid_to>=current_date)) a ON true
      WHERE u.org_id=$1 AND u.status='ACTIVE' AND u.result_view_only=false ORDER BY d.sort_order NULLS LAST,u.display_name,u.id`,[user.orgId]);
    return {data:rows};
  }

  @Get('organization')
  async organization(@CurrentUser() user: AuthContext) {
    const { rows: orgRows } = await this.db.query(
      `SELECT id, name, timezone FROM organizations WHERE id = $1`,
      [user.orgId],
    );
    const org = orgRows[0];
    if (!org) throw new NotFoundException();

    const { rows: deptRows } = await this.db.query(
      `SELECT id, code, name, sort_order FROM departments
       WHERE org_id = $1 ORDER BY sort_order`,
      [user.orgId],
    );

    const { rows: memberRows } = await this.db.query(
      `SELECT m.department_id, u.id AS user_id, u.display_name
       FROM department_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 AND m.valid_to IS NULL AND u.status = 'ACTIVE'
       ORDER BY u.id`,
      [user.orgId],
    );

    const { rows: headRows } = await this.db.query<{ user_id: string; scope_dept_id: string }>(
      `SELECT user_id, scope_dept_id FROM appointments
       WHERE org_id = $1 AND role = 'HEAD' AND valid_to IS NULL`,
      [user.orgId],
    );
    const headByDept = new Map(headRows.map((h) => [h.scope_dept_id, h.user_id]));

    const departments = deptRows.map((d) => {
      const members = memberRows.filter((m) => m.department_id === d.id);
      const headId = headByDept.get(d.id) ?? null;
      return {
        id: d.id,
        code: d.code,
        name: d.name,
        head_user_id: headId,
        head_name: members.find((m) => m.user_id === headId)?.display_name ?? null,
        member_count: members.length,
        members: members
          .filter((m) => m.user_id !== headId)
          .map((m) => ({ user_id: m.user_id, display_name: m.display_name })),
      };
    });

    return { data: { org, departments } };
  }

  /** 授权管理（org.manage）：列出本组织全部能力授权 */
  @Get('capability-grants')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('org.manage')
  @CapabilityResource('collection')
  async listGrants(@CurrentUser() user: AuthContext) {
    const grants=await this.policy.listCapabilities(user.userId,user.orgId);
    const authority=grants.filter(g=>g.capability==='org.manage');
    const { rows } = await this.db.query(
      `SELECT g.id, g.user_id, u.display_name, g.capability, g.scope_type::text AS scope_type,
              g.scope_id, g.reason, g.valid_from, g.valid_to, g.revoked_at
       FROM capability_grants g
       JOIN users u ON u.id = g.user_id
       WHERE g.org_id = $1
       ORDER BY g.created_at DESC`,
      [user.orgId],
    );
    return { data: rows.filter(r=>authority.some(g=>g.scope_type==='ORG'||g.scope_type===r.scope_type&&g.scope_id===r.scope_id)) };
  }

  /** 管理端/监管端用户账号台账（仅授权管理或部门进度管理员可见）。 */
  @Get('user-management')
  @UseGuards(CapabilityGuard)
  async userManagement(@CurrentUser() user: AuthContext) {
    const params:unknown[]=[user.orgId];
    const boundary=this.policy.scopedSql(user,'org.manage',null,'dm.department_id',params);
    const progress=this.policy.scopedSql(user,'progress.read',null,'dm.department_id',params);
    if (!await this.policy.hasAnyCapability(user.userId,user.orgId,'org.manage') && !await this.policy.hasAnyCapability(user.userId,user.orgId,'progress.read'))
      throw new ForbiddenException({code:'FORBIDDEN'});
    const { rows } = await this.db.query(
      `SELECT u.id, u.display_name, u.status, u.created_at,
              primary_membership.department_id AS primary_department_id,
              primary_department.name AS primary_department_name,
              COALESCE(string_agg(DISTINCT d.name, '、') FILTER (WHERE d.name IS NOT NULL), '') AS departments,
              COALESCE(array_agg(DISTINCT g.capability) FILTER (WHERE g.capability IS NOT NULL), ARRAY[]::text[]) AS capabilities
         FROM users u
         LEFT JOIN department_memberships dm ON dm.user_id = u.id AND dm.org_id = $1 AND dm.valid_to IS NULL
         LEFT JOIN departments d ON d.id = dm.department_id
         LEFT JOIN LATERAL (
           SELECT membership.department_id
           FROM department_memberships membership
           WHERE membership.user_id = u.id AND membership.org_id = u.org_id
             AND membership.valid_from <= current_date
             AND (membership.valid_to IS NULL OR membership.valid_to > current_date)
           ORDER BY membership.valid_from DESC
           LIMIT 1
         ) primary_membership ON TRUE
         LEFT JOIN departments primary_department
           ON primary_department.id = primary_membership.department_id AND primary_department.org_id = u.org_id
         LEFT JOIN effective_capability_grants g ON g.user_id = u.id AND g.org_id = $1 AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_to IS NULL OR g.valid_to>now())
        WHERE u.org_id = $1 AND (${boundary} OR ${progress})
        GROUP BY u.id, primary_membership.department_id, primary_department.name
        ORDER BY u.display_name`,
      params,
    );
    return { data: rows };
  }

  /** 授权管理（org.manage）：显式授予能力（PRD 3.3 催办/校准等由管理员显式授权） */
  @Post('capability-grants')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('org.manage')
  @CapabilityResource('collection')
  @HttpCode(201)
  async createGrant(
    @CurrentUser() actor: AuthContext,
    @Body()
    body: {
      user_id?: unknown;
      capability?: unknown;
      scope_type?: unknown;
      scope_id?: unknown;
      reason?: unknown;
    },
  ) {
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    const capability = typeof body.capability === 'string' ? body.capability : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId)) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'user_id' });
    if (!isCapability(capability)) {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'capability' });
    }
    if (!reason || reason.length > 500) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'reason' });

    const scopeType=body.scope_type ?? 'ORG';
    if (!['ORG','DEPARTMENT','CYCLE'].includes(String(scopeType))) throw new BadRequestException({code:'FIELD_INVALID',field:'scope_type'});
    const scopeId=typeof body.scope_id==='string'?body.scope_id:null;
    if ((scopeType==='ORG' && scopeId) || (scopeType!=='ORG' && (!scopeId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(scopeId))))
      throw new BadRequestException({code:'FIELD_INVALID',field:'scope_id'});
    const scope={scopeType:scopeType as ScopeType,scopeId:scopeId??undefined};
    await this.policy.assertCapability(actor.userId,actor.orgId,'org.manage',scope);
    // A delegation must never exceed the grantor's own capability and resource scope.
    await this.policy.assertCapability(actor.userId,actor.orgId,capability,scope);
    if(scopeType!=='ORG') {
      const table=scopeType==='CYCLE'?'cycles':'departments';
      if(!(await this.db.query(`SELECT id FROM ${table} WHERE id=$1 AND org_id=$2`,[scopeId,actor.orgId])).rowCount)
        throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    }
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM capability_grants WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL FOR SHARE',[actor.userId,actor.orgId]);
      const transactionPolicy=new PolicyService(client as unknown as Pool);
      await transactionPolicy.assertCapability(actor.userId,actor.orgId,'org.manage',scope);
      await transactionPolicy.assertCapability(actor.userId,actor.orgId,capability,scope);
      // Serialize grants for one target so rapid/retried submissions cannot
      // create duplicate active capability rows without adding a schema rule.
      const { rows: target } = await client.query(
        `SELECT id FROM users WHERE id = $1 AND org_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
        [userId, actor.orgId],
      );
      if (!target[0]) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'user_id' });
      const existing = await client.query(
        `SELECT id, user_id, capability, scope_type::text AS scope_type, scope_id, reason,
                valid_from, valid_to, revoked_at
         FROM capability_grants
         WHERE org_id = $1 AND user_id = $2 AND capability = $3 AND scope_type = $4
           AND scope_id IS NOT DISTINCT FROM $5 AND revoked_at IS NULL
           AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [actor.orgId, userId, capability, scopeType, scopeId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { data: { ...existing.rows[0], already_granted: true } };
      }
      const { rows } = await client.query(
      `INSERT INTO capability_grants
         (org_id, user_id, capability, scope_type, scope_id, reason, granted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, capability, scope_type::text AS scope_type, scope_id, reason,
                 valid_from, valid_to, revoked_at`,
      [
        actor.orgId,
        userId,
        capability,
        scopeType,
        scopeId,
        reason,
        actor.userId,
      ],
    );

      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'capability.grant','capability_grant',$3,$4)`,[actor.orgId,actor.userId,rows[0].id,JSON.stringify({capability,scopeType,scopeId,reason})]);
      await client.query('COMMIT');
      return { data: { ...rows[0], already_granted: false } };
    } catch(e) { await client.query('ROLLBACK');throw e; } finally { client.release(); }
  }

  /** 授权管理（org.manage）：撤销授权 */
  @Post('capability-grants/:id/revoke')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('org.manage')
  @CapabilityResource('collection')
  @HttpCode(200)
  async revokeGrant(@CurrentUser() actor: AuthContext, @Param('id') grantId: string) {
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(grantId))throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      const found=await client.query('SELECT capability,scope_type,scope_id FROM capability_grants WHERE id=$1 AND org_id=$2 FOR UPDATE',[grantId,actor.orgId]);
      if(!found.rowCount) throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
      const grant=found.rows[0];
      await client.query('SELECT id FROM capability_grants WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL FOR SHARE',[actor.userId,actor.orgId]);
      await new PolicyService(client as unknown as Pool).assertCapability(actor.userId,actor.orgId,'org.manage',{scopeType:grant.scope_type,scopeId:grant.scope_id??undefined});
      await client.query('UPDATE capability_grants SET revoked_at=now() WHERE id=$1 AND org_id=$2',[grantId,actor.orgId]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'capability.revoke','capability_grant',$3,$4)`,[actor.orgId,actor.userId,grantId,JSON.stringify(grant)]);
      await client.query('COMMIT');
      return {data:{id:grantId,revoked:true}};
    } catch(e) { await client.query('ROLLBACK');throw e; } finally { client.release(); }
  }
}
