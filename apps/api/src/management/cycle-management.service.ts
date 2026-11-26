import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PolicyService } from '../authz/policy.service';
import type { AuthContext } from '../auth/current-user.decorator';

/** Cycle settings projection: no scores, no assignment identities, scoped roster only. */
@Injectable()
export class CycleManagementService {
 constructor(@Inject('DATABASE_POOL') private readonly db:Pool,private readonly policy:PolicyService) {}
 async detail(actor:AuthContext,id?:string) {
  if(!id||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))throw new BadRequestException({code:'FIELD_INVALID',field:'cycleId'});
  const p:unknown[]=[actor.orgId,id];
  const scope=this.policy.scopedSql(actor,'progress.read','c.id','cp.dept_snapshot',p);
  const entry=this.policy.scopedSql(actor,'management.access','c.id','cp.dept_snapshot',p);
  const client=await this.db.connect();
  try {
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const cycle=(await client.query(`SELECT c.id,c.title,to_char(c.month,'YYYY-MM') AS month,c.status,c.open_at,c.close_at,c.publish_at,c.calibration_at,c.ruleset_id,c.row_version,(SELECT rs.version FROM rulesets rs WHERE rs.id=c.ruleset_id AND rs.org_id=c.org_id) AS rule_version,
    EXISTS(SELECT 1 FROM reviews WHERE cycle_id=c.id UNION ALL SELECT 1 FROM monthly_reports WHERE cycle_id=c.id UNION ALL SELECT 1 FROM assignments WHERE cycle_id=c.id UNION ALL SELECT 1 FROM result_builds WHERE cycle_id=c.id UNION ALL SELECT 1 FROM cycle_locks WHERE cycle_id=c.id) AS has_business,
    EXISTS(SELECT 1 FROM published_results WHERE cycle_id=c.id AND org_id=c.org_id) AS has_publication
    FROM cycles c WHERE c.id=$2 AND c.org_id=$1 AND EXISTS(SELECT 1 FROM (SELECT NULL::uuid AS dept_snapshot UNION SELECT dept_snapshot FROM cycle_participants WHERE cycle_id=c.id AND org_id=c.org_id) cp WHERE ${scope} AND ${entry})`,p)).rows[0];
   if(!cycle)throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
   const q:unknown[]=[actor.orgId,id];
   const rosterScope=this.policy.scopedSql(actor,'progress.read','cp.cycle_id','cp.dept_snapshot',q);
   const rosterEntry=this.policy.scopedSql(actor,'management.access','cp.cycle_id','cp.dept_snapshot',q);
   const participants=(await client.query(`SELECT cp.user_id,u.display_name,cp.dept_snapshot,d.name AS department_name,cp.role_snapshot,cp.eligibility,cp.exclusion_reason
    FROM cycle_participants cp JOIN users u ON u.id=cp.user_id AND u.org_id=cp.org_id LEFT JOIN departments d ON d.id=cp.dept_snapshot AND d.org_id=cp.org_id
    WHERE cp.org_id=$1 AND cp.cycle_id=$2 AND ${rosterScope} AND ${rosterEntry} ORDER BY d.sort_order NULLS LAST,u.display_name`,q)).rows;
   const stateLog=(await client.query('SELECT l.from_status,l.to_status,l.reason,l.created_at,u.display_name AS actor_name FROM cycle_state_log l LEFT JOIN users u ON u.id=l.actor_id AND u.org_id=$2 WHERE l.cycle_id=$1 ORDER BY l.created_at',[id,actor.orgId])).rows;
   // Existing mutation endpoints authorize cycle.manage at ORG or exact CYCLE scope.
   const grants=await this.policy.listCapabilities(actor.userId,actor.orgId);
   const manage=grants.some(g=>g.capability==='cycle.manage'&&(g.scope_type==='ORG'||g.scope_type==='CYCLE'&&g.scope_id===id));
   const canCreate=grants.some(g=>g.capability==='cycle.manage'&&g.scope_type==='ORG');
   await client.query('COMMIT');
   return {cycle,participants,stateLog,permissions:{canCreate,canEdit:manage&&cycle.status==='DRAFT',canRefresh:manage&&cycle.status==='DRAFT',canDelete:manage&&((cycle.status==='DRAFT'&&!cycle.has_business)||cycle.status==='CANCELLED'),canRestore:manage&&cycle.status==='CANCELLED',canArchive:manage&&cycle.status==='PUBLISHED',canPause:manage&&cycle.status==='REVIEWING',canResume:manage&&cycle.status==='PAUSED',canCancel:manage&&['DRAFT','PENDING_OPEN','REVIEWING','PAUSED','CALIBRATING'].includes(cycle.status)&&!cycle.has_publication}};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
}
