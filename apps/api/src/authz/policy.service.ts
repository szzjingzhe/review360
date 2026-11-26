import { ForbiddenException, NotFoundException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { Capability, ScopeType } from './capabilities';

export interface CapabilityGrant {
  capability: string;
  scope_type: ScopeType;
  scope_id: string | null;
}

/**
 * 权限判定服务（技术文档 4.3）：
 * Guard 只做 RBAC 入口，对象范围与本人隔离必须由 policy 层继续校验。
 */
@Injectable()
export class PolicyService {
  constructor(@Inject('DATABASE_POOL') private readonly db: Pool) {}

  /** 查询用户当前有效的 capability 授权 */
  async listCapabilities(userId: string, orgId: string): Promise<CapabilityGrant[]> {
    const { rows } = await this.db.query<CapabilityGrant>(
      `SELECT capability, scope_type::text AS scope_type, scope_id
       FROM effective_capability_grants
       WHERE user_id = $1 AND org_id = $2
         AND valid_from <= now()
         AND (valid_to IS NULL OR valid_to > now())
         AND revoked_at IS NULL
          AND ((scope_type='ORG' AND scope_id IS NULL)
            OR (scope_type='DEPARTMENT' AND EXISTS(SELECT 1 FROM departments d WHERE d.id=scope_id AND d.org_id=$2))
            OR (scope_type='CYCLE' AND EXISTS(SELECT 1 FROM cycles c WHERE c.id=scope_id AND c.org_id=$2)))`,
      [userId, orgId],
    );
    return rows;
  }

  /**
   * 判定是否拥有某能力（可带 scope 要求）。
   * scopeType 未指定时任何 ORG 级授权即可通过；指定 scope 须精确匹配或在 ORG 范围内。
   */
  async hasCapability(
    userId: string,
    orgId: string,
    capability: Capability,
    scope?: { scopeType: ScopeType; scopeId?: string },
  ): Promise<boolean> {
    const grants = await this.listCapabilities(userId, orgId);
    return grants.some((g) => {
      if (g.capability !== capability || g.scope_type === 'STATION') return false;
      if (!scope) return g.scope_type === 'ORG' && g.scope_id == null;
      if (g.scope_type === 'ORG') return g.scope_id == null;
      if (g.scope_type !== scope.scopeType) return false;
      return !!scope.scopeId && g.scope_id === scope.scopeId;
    });
  }

  /** Entry check for a collection; every row must also satisfy scopedSql. */
  async hasAnyCapability(userId: string, orgId: string, capability: Capability) {
    return (await this.listCapabilities(userId, orgId)).some(g => g.capability === capability && g.scope_type !== 'STATION');
  }

  async assertCollection(actor: {userId:string;orgId:string}, capability: Capability, cycleId?:string) {
    const grants=(await this.listCapabilities(actor.userId,actor.orgId)).filter(g=>g.capability===capability&&g.scope_type!=='STATION');
    if (cycleId) {
      if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cycleId) || !(await this.db.query('SELECT id FROM cycles WHERE id=$1 AND org_id=$2',[cycleId,actor.orgId])).rowCount)
        throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
      if(!grants.some(g=>g.scope_type==='ORG'||g.scope_type==='DEPARTMENT'||g.scope_type==='CYCLE'&&g.scope_id===cycleId))
        throw new ForbiddenException({code:'FORBIDDEN',capability});
    } else if(!grants.length) throw new ForbiddenException({code:'FORBIDDEN',capability});
  }

  async assertParticipant(actor:{userId:string;orgId:string},capability:Capability,cycleId:unknown,userId:unknown) {
    const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if(typeof cycleId!=='string'||typeof userId!=='string'||!uuid.test(cycleId)||!uuid.test(userId))throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    const row=(await this.db.query(`SELECT p.dept_snapshot FROM cycle_participants p JOIN cycles c ON c.id=p.cycle_id AND c.org_id=p.org_id
      WHERE p.cycle_id=$1 AND p.user_id=$2 AND p.org_id=$3`,[cycleId,userId,actor.orgId])).rows[0];
    if(!row)throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    if(!await this.hasCapability(actor.userId,actor.orgId,capability,{scopeType:'CYCLE',scopeId:cycleId})
      && !await this.hasCapability(actor.userId,actor.orgId,capability,{scopeType:'DEPARTMENT',scopeId:row.dept_snapshot}))
      throw new ForbiddenException({code:'FORBIDDEN',capability});
  }

  /**
   * 断言对象是本周期内、本组织的有效参评人，但不施加部门边界。
   * 供跨部门人工指定使用：调用方必须再自行确认评价人本人持有周期级管理授权。
   */
  async assertCycleParticipant(actor:{userId:string;orgId:string},cycleId:unknown,userId:unknown) {
    const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if(typeof cycleId!=='string'||typeof userId!=='string'||!uuid.test(cycleId)||!uuid.test(userId))throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    const row=(await this.db.query(`SELECT p.dept_snapshot FROM cycle_participants p
      WHERE p.cycle_id=$1 AND p.user_id=$2 AND p.org_id=$3`,[cycleId,userId,actor.orgId])).rows[0];
    if(!row)throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    return row as {dept_snapshot:string};
  }

  async auditDenied(actor: {userId:string;orgId:string}, capability: string) {
    await this.db.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,reason)
      VALUES($1,$2,'authorization.denied','api',$3)`,[actor.orgId,actor.userId,capability]);
  }

  async auditRawAccess(actor:{userId:string;orgId:string},route:string) {
    await this.db.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,reason)
      VALUES($1,$2,'authorization.raw_access','api',$3)`,[actor.orgId,actor.userId,route]);
  }

  /** SQL row boundary. Column expressions are server constants, never request input. */
  scopedSql(actor: {userId:string;orgId:string}, capability: Capability,
    cycleColumn: string | null, deptColumn: string | null, params: unknown[]) {
    const n = params.length;
    params.push(actor.userId, actor.orgId, capability);
    return `EXISTS (SELECT 1 FROM effective_capability_grants sg WHERE sg.user_id=$${n+1} AND sg.org_id=$${n+2}
      AND sg.capability=$${n+3} AND sg.revoked_at IS NULL AND sg.valid_from<=now()
      AND (sg.valid_to IS NULL OR sg.valid_to>now()) AND (
        (sg.scope_type='ORG' AND sg.scope_id IS NULL)
        ${cycleColumn ? `OR (sg.scope_type='CYCLE' AND sg.scope_id=${cycleColumn})` : ''}
        ${deptColumn ? `OR (sg.scope_type='DEPARTMENT' AND sg.scope_id=${deptColumn})` : ''}))`;
  }

  async assertResource(actor: {userId:string;orgId:string}, capability: Capability,
    kind: string, id: string | undefined, departmentId?: string) {
    if (!id || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    const statements: Record<string,string> = {
      cycle: 'SELECT id AS cycle_id,NULL::uuid AS dept_id FROM cycles WHERE id=$1 AND org_id=$2',
      build: 'SELECT b.cycle_id,p.dept_snapshot AS dept_id FROM result_builds b JOIN cycle_participants p ON p.cycle_id=b.cycle_id AND p.user_id=b.target_id AND p.org_id=b.org_id WHERE b.id=$1 AND b.org_id=$2',
      case: 'SELECT c.cycle_id,p.dept_snapshot AS dept_id FROM calibration_cases c JOIN review_revisions v ON v.id=c.review_revision_id JOIN reviews r ON r.id=v.review_id JOIN cycle_participants p ON p.cycle_id=c.cycle_id AND p.user_id=r.target_id AND p.org_id=c.org_id WHERE c.id=$1 AND c.org_id=$2',
      feedback: 'SELECT b.cycle_id,p.dept_snapshot AS dept_id FROM feedback_requests f JOIN published_results b ON b.id=f.publication_id AND b.org_id=f.org_id JOIN cycle_participants p ON p.cycle_id=b.cycle_id AND p.user_id=b.target_id AND p.org_id=b.org_id WHERE f.id=$1 AND f.org_id=$2',
    };
    if (!statements[kind]) throw new ForbiddenException({code:'FORBIDDEN'});
    const row=(await this.db.query(statements[kind],[id,actor.orgId])).rows[0];
    if (!row) throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    if (departmentId) {
      const dept=await this.db.query('SELECT id FROM departments WHERE id=$1 AND org_id=$2',[departmentId,actor.orgId]);
      if (!dept.rowCount) throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
    }
    const allowed=await this.hasCapability(actor.userId,actor.orgId,capability,{scopeType:'CYCLE',scopeId:row.cycle_id})
      || (!!(departmentId || row.dept_id) && await this.hasCapability(actor.userId,actor.orgId,capability,{scopeType:'DEPARTMENT',scopeId:departmentId || row.dept_id}));
    if (!allowed) throw new ForbiddenException({code:'FORBIDDEN',capability});
  }

  /** 断言能力，失败抛 403 */
  async assertCapability(
    userId: string,
    orgId: string,
    capability: Capability,
    scope?: { scopeType: ScopeType; scopeId?: string },
  ): Promise<void> {
    if (!(await this.hasCapability(userId, orgId, capability, scope))) {
      throw new ForbiddenException({ code: 'FORBIDDEN', capability });
    }
  }

  /** 本人原始评价隔离（PRD 4 / 技术文档 4.3）：target 为当前用户时一律拒绝读取原始他评 */
  assertNotSelfTarget(actorUserId: string, targetUserId: string): void {
    if (actorUserId === targetUserId) {
      throw new ForbiddenException({ code: 'SELF_AUDIT_FORBIDDEN' });
    }
  }

  /** 用户当前正式部门（开放区间归属） */
  async primaryDepartment(userId: string): Promise<{ id: string; code: string } | null> {
    const { rows } = await this.db.query<{ id: string; code: string }>(
      `SELECT d.id, d.code
       FROM department_memberships m
       JOIN departments d ON d.id = m.department_id
       WHERE m.user_id = $1 AND m.valid_to IS NULL
       ORDER BY m.valid_from DESC
       LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /** 可读进度的部门范围：当前正式部门。 */
  async visibleDepartments(userId: string): Promise<{ id: string; code: string; via: 'MEMBER' }[]> {
    const primary = await this.primaryDepartment(userId);
    const out: { id: string; code: string; via: 'MEMBER' }[] = [];
    if (primary) out.push({ ...primary, via: 'MEMBER' });
    return out;
  }

  /** 是否为某部门现任部长 */
  async isHeadOf(userId: string, deptId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `SELECT 1 FROM appointments
       WHERE user_id = $1 AND role = 'HEAD' AND scope_dept_id = $2 AND valid_to IS NULL`,
      [userId, deptId],
    );
    return (rowCount ?? 0) > 0;
  }
}
