import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { completenessCheck, currentInputHash, effectiveReviewSql, RESULT_FORMULA_VERSION } from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import { PolicyService } from '../authz/policy.service';
import type { AuthContext } from '../auth/current-user.decorator';
import type { Capability } from '../authz/capabilities';

/** Read-only dashboard projection. All counts share a repeatable-read snapshot. */
@Injectable()
export class CockpitService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool, private readonly policy: PolicyService) {}

  async read(actor: AuthContext, cycleId?: string, periods = '6') {
    if (cycleId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cycleId)) throw new BadRequestException({code:'FIELD_INVALID'});
    if (!['3','6','12'].includes(periods)) throw new BadRequestException({code:'FIELD_INVALID',field:'periods'});
    const client = await this.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const params: unknown[] = [actor.orgId];
      const access = this.policy.scopedSql(actor,'management.access','c.id','cp.dept_snapshot',params);
      const progress = this.policy.scopedSql(actor,'progress.read','c.id','cp.dept_snapshot',params);
      const cycles = (await client.query(`SELECT c.id,c.title,to_char(c.month,'YYYY-MM') AS month,c.status,c.open_at,c.close_at
        FROM cycles c WHERE c.org_id=$1 AND EXISTS (SELECT 1 FROM (SELECT NULL::uuid AS dept_snapshot UNION SELECT p.dept_snapshot FROM cycle_participants p WHERE p.cycle_id=c.id AND p.org_id=c.org_id) cp WHERE ${access} AND ${progress})
        ORDER BY c.month DESC,c.created_at DESC`,params)).rows;
      const selected = cycleId ? cycles.find(c=>c.id===cycleId) : cycles.find(c=>['REVIEWING','CALIBRATING','PARTIALLY_PUBLISHED'].includes(c.status)) ?? cycles[0];
      if (cycleId && !selected) throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
      if (!selected) {await client.query('COMMIT');return {cycles,cycle:null,departments:[],todos:[],trend:[],permissions:[]};}
      const p: unknown[] = [actor.orgId,selected.id];
      const boundary=this.policy.scopedSql(actor,'progress.read','cp.cycle_id','cp.dept_snapshot',p);
      const entry=this.policy.scopedSql(actor,'management.access','cp.cycle_id','cp.dept_snapshot',p);
      const departments=(await client.query(`WITH eligible AS (
        SELECT cp.* FROM cycle_participants cp WHERE cp.org_id=$1 AND cp.cycle_id=$2 AND cp.eligibility='ELIGIBLE' AND ${boundary} AND ${entry}
      ), tasks AS (
        SELECT a.id,a.target_id,EXISTS(SELECT 1 FROM reviews r JOIN review_revisions rr ON rr.id=r.current_revision_id
          WHERE r.assignment_id=a.id AND r.org_id=$1 AND r.cycle_id=$2 AND ${effectiveReviewSql('r','rr')}) AS done
        FROM assignments a JOIN eligible cp ON cp.user_id=a.target_id WHERE a.org_id=$1 AND a.cycle_id=$2 AND a.status='ACTIVE'
      ) SELECT cp.dept_snapshot AS id,COALESCE(d.name,'未分配部门') AS name,count(*)::int AS participants,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM monthly_reports mr JOIN report_versions rv ON rv.id=mr.active_version_id AND rv.report_id=mr.id
          WHERE mr.org_id=$1 AND mr.cycle_id=$2 AND mr.user_id=cp.user_id AND rv.scan_status='PASSED' AND rv.preview_status='READY'))::int AS materials,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM reviews r JOIN review_revisions rr ON rr.id=r.current_revision_id
          WHERE r.org_id=$1 AND r.cycle_id=$2 AND r.target_id=cp.user_id AND r.kind='SELF' AND ${effectiveReviewSql('r','rr')}))::int AS self_submitted,
        COALESCE(sum((SELECT count(*) FROM tasks t WHERE t.target_id=cp.user_id)),0)::int AS peer_expected,
        COALESCE(sum((SELECT count(*) FROM tasks t WHERE t.target_id=cp.user_id AND t.done)),0)::int AS peer_submitted
        FROM eligible cp LEFT JOIN departments d ON d.id=cp.dept_snapshot AND d.org_id=cp.org_id
        GROUP BY cp.dept_snapshot,d.name,d.sort_order ORDER BY d.sort_order NULLS LAST,d.name`,p)).rows;
      const totals = departments.reduce((a,r)=>{for(const k of Object.keys(a))a[k]+=r[k];return a;},{participants:0,materials:0,self_submitted:0,peer_expected:0,peer_submitted:0} as Record<string,number>);
      const ratio=(n:number,d:number)=>d?n/d:null;
      const todos=await this.todos(client,actor,selected.id);
      const trend=await this.trend(client,actor,selected.id,Number(periods));
      const grants=await this.policy.listCapabilities(actor.userId,actor.orgId);
      const permissions=[...new Set(grants.filter(g=>g.scope_type==='ORG'||g.scope_type==='CYCLE'&&g.scope_id===selected.id||g.scope_type==='DEPARTMENT'&&departments.some(d=>d.id===g.scope_id)).map(g=>g.capability))];
      await client.query('COMMIT');
      return {cycles,cycle:{...selected,...totals,materialRate:ratio(totals.materials,totals.participants),selfRate:ratio(totals.self_submitted,totals.participants),peerRate:ratio(totals.peer_submitted,totals.peer_expected),
        overallRate:ratio(totals.self_submitted+totals.peer_submitted,totals.participants+totals.peer_expected)},departments:departments.map(d=>({...d,rate:ratio(d.peer_submitted+d.self_submitted,d.peer_expected+d.participants),done:d.peer_submitted+d.self_submitted,expected:d.peer_expected+d.participants})),todos,trend,permissions};
    } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
  }

  private async todos(db:PoolClient,actor:AuthContext,cycleId:string) {
    const scope=(cap:Capability,p:unknown[])=>this.policy.scopedSql(actor,cap,'cp.cycle_id','cp.dept_snapshot',p);
    const p:unknown[]=[actor.orgId,cycleId,actor.userId];const boundary=scope('calibration.resolve',p);
    const calibration=Number((await db.query(`SELECT count(*)::int AS n FROM calibration_cases cc JOIN reviews r ON r.current_revision_id=cc.review_revision_id AND r.org_id=cc.org_id
      JOIN cycle_participants cp ON cp.cycle_id=cc.cycle_id AND cp.user_id=r.target_id AND cp.org_id=cc.org_id
      WHERE cc.org_id=$1 AND cc.cycle_id=$2 AND cc.status='OPEN' AND cp.eligibility='ELIGIBLE' AND r.target_id<>$3 AND r.reviewer_id<>$3 AND ${boundary}`,p)).rows[0].n);
    const f:unknown[]=[actor.orgId,cycleId,actor.userId];const fb=scope('feedback.manage',f);
    const feedback=Number((await db.query(`SELECT count(*)::int AS n FROM feedback_requests fr JOIN published_results pr ON pr.id=fr.publication_id AND pr.org_id=fr.org_id
      JOIN cycle_participants cp ON cp.cycle_id=pr.cycle_id AND cp.user_id=pr.target_id AND cp.org_id=pr.org_id
      WHERE fr.org_id=$1 AND pr.cycle_id=$2 AND fr.applicant_id<>$3 AND fr.status IN ('PENDING','REREVIEW_PENDING') AND ${fb}`,f)).rows[0].n);
    const b:unknown[]=[actor.orgId,cycleId,actor.userId];const confirm=scope('result.confirm',b),publish=scope('result.publish',b);
    const builds=(await db.query(`SELECT rb.*,(${confirm}) AS can_confirm,(${publish}) AS can_publish,
      (SELECT ra.decision='APPROVED' AND ra.approver_id<>rb.target_id FROM result_approvals ra WHERE ra.result_build_id=rb.id ORDER BY ra.created_at DESC,ra.id DESC LIMIT 1) AS approved
      FROM result_builds rb JOIN cycle_participants cp ON cp.cycle_id=rb.cycle_id AND cp.user_id=rb.target_id AND cp.org_id=rb.org_id JOIN cycles c ON c.id=rb.cycle_id AND c.org_id=rb.org_id
      WHERE rb.org_id=$1 AND rb.cycle_id=$2 AND rb.target_id<>$3 AND cp.eligibility='ELIGIBLE' AND c.status IN ('CALIBRATING','PARTIALLY_PUBLISHED','PUBLISHED')
      AND rb.status IN ('BUILT','APPROVED') AND (${confirm} OR ${publish})
      AND NOT EXISTS(SELECT 1 FROM result_builds newer WHERE newer.org_id=rb.org_id AND newer.cycle_id=rb.cycle_id AND newer.target_id=rb.target_id AND newer.created_at>rb.created_at)`,b)).rows;
    let confirmation=0,publication=0;
    for(const row of builds) {
      if(row.formula_version!==RESULT_FORMULA_VERSION||row.exact_score===null)continue;
      if((await completenessCheck(db,cycleId,row.target_id)).length)continue;
      if(await currentInputHash(db,cycleId,row.target_id,row.formula_version)!==row.input_hash)continue;
      if(row.status==='BUILT'&&row.can_confirm)confirmation++;
      if(row.status==='APPROVED'&&row.approved&&row.can_publish)publication++;
    }
    return [{key:'calibration',label:'评分异常核验',count:calibration,capability:'calibration.resolve',to:'/management/monthly?tab=exceptions'},
      {key:'confirmation',label:'评价结果确认',count:confirmation,capability:'result.confirm',to:'/management/monthly?tab=results'},
      {key:'feedback',label:'反馈申诉处理',count:feedback,capability:'feedback.manage',to:'/management/feedback'},
      {key:'publication',label:'结果发布',count:publication,capability:'result.publish',to:'/management/monthly?tab=results'}];
  }

  private async trend(db:PoolClient,actor:AuthContext,cycleId:string,periods:number) {
    const p:unknown[]=[actor.orgId,cycleId,periods];
    const boundary=this.policy.scopedSql(actor,'result.read_published','cp.cycle_id','cp.dept_snapshot',p);
    const entry=this.policy.scopedSql(actor,'management.access','cp.cycle_id','cp.dept_snapshot',p);
    // Publication payload is the immutable official snapshot; never read mutable build dimensions.
    return (await db.query(`WITH latest AS (
      SELECT DISTINCT ON (pr.cycle_id,pr.target_id) pr.*,c.month,c.title FROM published_results pr
      JOIN cycles c ON c.id=pr.cycle_id AND c.org_id=pr.org_id
      JOIN result_builds rb ON rb.id=pr.result_build_id AND rb.org_id=pr.org_id
      JOIN cycle_participants cp ON cp.cycle_id=pr.cycle_id AND cp.user_id=pr.target_id AND cp.org_id=pr.org_id
      WHERE pr.org_id=$1 AND c.month<=(SELECT month FROM cycles WHERE id=$2 AND org_id=$1)
      AND NOT EXISTS(SELECT 1 FROM published_results newer WHERE newer.org_id=pr.org_id AND newer.cycle_id=pr.cycle_id AND newer.target_id=pr.target_id AND newer.publication_version>pr.publication_version)
      AND c.status<>'CANCELLED' AND rb.status='PUBLISHED' AND cp.eligibility='ELIGIBLE' AND ${boundary} AND ${entry}
      ORDER BY pr.cycle_id,pr.target_id,pr.publication_version DESC
    ), recent AS (SELECT DISTINCT cycle_id,month FROM latest ORDER BY month DESC,cycle_id LIMIT $3)
    SELECT l.cycle_id,to_char(l.month,'YYYY-MM') AS month,l.title,item->>'label' AS dimension,
      round(avg((item->>'avg_score')::numeric),2)::float8 AS value,count(*)::int AS sample_count
      FROM latest l JOIN recent r ON r.cycle_id=l.cycle_id CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.payload_json->'peer_items')='array' THEN l.payload_json->'peer_items' ELSE '[]'::jsonb END) item
      WHERE jsonb_typeof(item->'avg_score')='number' AND item->>'label' IS NOT NULL
      GROUP BY l.cycle_id,l.month,l.title,item->>'label' HAVING count(DISTINCT l.target_id)>=3 ORDER BY l.month,l.cycle_id,dimension`,p)).rows;
  }
}
