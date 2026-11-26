import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { Pool } from 'pg';
import { effectiveReviewSql, completenessCheck } from '@360/domain';
import { CycleManagementService } from './cycle-management.service';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, type AuthContext } from '../auth/current-user.decorator';
import { CapabilityGuard, CapabilityResource, RequireCapabilities } from '../authz/capability.guard';
import { PolicyService } from '../authz/policy.service';
import { CockpitService } from './cockpit.service';
import { DATABASE_POOL } from '../database/database.module';

@Controller('management')
@UseGuards(SessionGuard,CapabilityGuard)
@RequireCapabilities('management.access')
@CapabilityResource('collection')
export class ManagementController {
  constructor(@Inject(DATABASE_POOL) private readonly db:Pool, private readonly policy:PolicyService, private readonly cockpit:CockpitService, private readonly cycleManagement:CycleManagementService) {}
  @Get('result-overview')
  async resultOverview(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string) {
    if(!cycleId)throw new BadRequestException({code:'FIELD_INVALID',field:'cycleId'});
    await this.policy.assertCollection(actor,'result.read_aggregate',cycleId);
    const params:unknown[]=[actor.orgId,cycleId,actor.userId];
    const scope=this.policy.scopedSql(actor,'result.read_aggregate','p.cycle_id','p.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','p.cycle_id','p.dept_snapshot',params);
    const rows=(await this.db.query(`SELECT p.user_id,u.display_name,d.name AS department_name,
      (SELECT count(*)::int FROM assignments a WHERE a.org_id=p.org_id AND a.cycle_id=p.cycle_id AND a.target_id=p.user_id AND a.status='ACTIVE' AND a.reviewer_id<>a.target_id) AS peer_expected,
      (SELECT count(*)::int FROM reviews r JOIN review_revisions v ON v.id=r.current_revision_id WHERE r.org_id=p.org_id AND r.cycle_id=p.cycle_id AND r.target_id=p.user_id AND r.kind='PEER' AND ${effectiveReviewSql('r','v')}) AS peer_submitted,
      EXISTS(SELECT 1 FROM reviews s JOIN review_revisions sv ON sv.id=s.current_revision_id WHERE s.org_id=p.org_id AND s.cycle_id=p.cycle_id AND s.target_id=p.user_id AND s.kind='SELF' AND ${effectiveReviewSql('s','sv')}) AS self_submitted,
      b.id AS build_id,b.status AS build_status,b.exact_score,b.created_at AS build_at,b.dimension_json,
      pub.id AS publication_id,pub.publication_version,pub.published_at
      FROM cycle_participants p JOIN users u ON u.id=p.user_id AND u.org_id=p.org_id LEFT JOIN departments d ON d.id=p.dept_snapshot AND d.org_id=p.org_id
      LEFT JOIN LATERAL (SELECT * FROM result_builds b WHERE b.org_id=p.org_id AND b.cycle_id=p.cycle_id AND b.target_id=p.user_id ORDER BY b.created_at DESC,b.id DESC LIMIT 1) b ON true
      LEFT JOIN LATERAL (SELECT id,publication_version,published_at FROM published_results pr WHERE pr.org_id=p.org_id AND pr.cycle_id=p.cycle_id AND pr.target_id=p.user_id ORDER BY pr.publication_version DESC LIMIT 1) pub ON true
      WHERE p.org_id=$1 AND p.cycle_id=$2 AND p.eligibility='ELIGIBLE' AND p.user_id<>$3 AND ${scope} AND ${entry} ORDER BY u.display_name`,params)).rows;
    const data=await Promise.all(rows.map(async row=>({...row,incomplete_reasons:await completenessCheck(this.db,cycleId,row.user_id)})));
    return {data};
  }
  @Get('assignment-cycles')
  async assignmentCycles(@CurrentUser() actor:AuthContext) {
    const params:unknown[]=[actor.orgId];
    const manage=this.policy.scopedSql(actor,'assignment.manage','c.id','p.dept_snapshot',params);
    const read=this.policy.scopedSql(actor,'assignment.read','c.id','p.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','c.id','p.dept_snapshot',params);
    const rows=(await this.db.query(`SELECT c.id,c.title,to_char(c.month,'YYYY-MM') AS month,c.status
      FROM cycles c WHERE c.org_id=$1 AND EXISTS(SELECT 1 FROM
        (SELECT NULL::uuid AS dept_snapshot UNION SELECT dept_snapshot FROM cycle_participants WHERE cycle_id=c.id AND org_id=c.org_id AND eligibility='ELIGIBLE') p
        WHERE (${manage} OR ${read}) AND ${entry}) ORDER BY c.month DESC,c.created_at DESC`,params)).rows;
    return {data:rows};
  }
  @Get('assignment-relations')
  async assignmentRelations(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string) {
    if(!cycleId)throw new BadRequestException({code:'FIELD_INVALID',field:'cycleId'});
    const cycle=(await this.db.query('SELECT id FROM cycles WHERE id=$1 AND org_id=$2',[cycleId,actor.orgId])).rowCount;
    if(!cycle)throw new BadRequestException({code:'FIELD_INVALID',field:'cycleId'});
    // 只读授权独立于 assignment.manage：缺少时返回可辨识的原因，界面不能把 403 显示成“0 条关系”。
    if(!await this.policy.hasAnyCapability(actor.userId,actor.orgId,'assignment.read'))
      throw new ForbiddenException({code:'ASSIGNMENT_READ_FORBIDDEN',capability:'assignment.read'});
    const params:unknown[]=[actor.orgId,actor.userId,cycleId];
    const reviewerScope=this.policy.scopedSql(actor,'assignment.read','a.cycle_id','rp.dept_snapshot',params);
    const targetScope=this.policy.scopedSql(actor,'assignment.read','a.cycle_id','tp.dept_snapshot',params);
    const reviewerEntry=this.policy.scopedSql(actor,'management.access','a.cycle_id','rp.dept_snapshot',params);
    const targetEntry=this.policy.scopedSql(actor,'management.access','a.cycle_id','tp.dept_snapshot',params);
    const rows=(await this.db.query(`SELECT a.id,a.cycle_id,a.reviewer_id,a.target_id,ru.display_name AS reviewer_name,tu.display_name AS target_name,
      rd.name AS reviewer_department,td.name AS target_department,rp.dept_snapshot AS reviewer_department_id,tp.dept_snapshot AS target_department_id,
      CASE WHEN a.source_type='REPLACEMENT' THEN 'REPLACEMENT' WHEN a.reason='MANUAL' THEN 'MANUAL' ELSE 'SYSTEM' END AS origin,
      a.status,a.created_at,me.reason AS manual_reason,mu.display_name AS assigned_by,me.created_at AS assigned_at
      FROM assignments a JOIN cycle_participants rp ON rp.org_id=a.org_id AND rp.cycle_id=a.cycle_id AND rp.user_id=a.reviewer_id
      JOIN cycle_participants tp ON tp.org_id=a.org_id AND tp.cycle_id=a.cycle_id AND tp.user_id=a.target_id
      JOIN users ru ON ru.org_id=a.org_id AND ru.id=a.reviewer_id JOIN users tu ON tu.org_id=a.org_id AND tu.id=a.target_id
      LEFT JOIN departments rd ON rd.id=rp.dept_snapshot AND rd.org_id=a.org_id LEFT JOIN departments td ON td.id=tp.dept_snapshot AND td.org_id=a.org_id
      LEFT JOIN assignment_manual_edges me ON me.org_id=a.org_id AND me.cycle_id=a.cycle_id AND me.reviewer_id=a.reviewer_id AND me.target_id=a.target_id AND a.reason='MANUAL'
      LEFT JOIN users mu ON mu.id=me.created_by AND mu.org_id=a.org_id
      WHERE a.org_id=$1 AND a.target_id<>$2 AND a.cycle_id=$3 AND a.status='ACTIVE' AND a.reviewer_id<>a.target_id
      AND rp.eligibility='ELIGIBLE' AND tp.eligibility='ELIGIBLE' AND ${reviewerScope} AND ${targetScope} AND ${reviewerEntry} AND ${targetEntry}
      ORDER BY a.created_at,a.id`,params)).rows;
    return {data:rows};
  }
  @Get('cycle-detail')
  async cycleDetail(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string) { return {data:await this.cycleManagement.detail(actor,cycleId)}; }
  @Get('cycle-progress')
  async cycleProgress(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string) {
    if(!cycleId||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cycleId)) throw new BadRequestException({code:'FIELD_INVALID',field:'cycleId'});
    await this.policy.assertCollection(actor,'progress.read',cycleId);
    const params:unknown[]=[actor.orgId,cycleId];
    const scope=this.policy.scopedSql(actor,'progress.read','p.cycle_id','p.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','p.cycle_id','p.dept_snapshot',params);
    const rows=(await this.db.query(`SELECT p.user_id,u.display_name,p.dept_snapshot AS department_id,d.name AS department_name,p.eligibility,p.exclusion_reason,
      (SELECT count(*)::int FROM monthly_reports r WHERE r.org_id=p.org_id AND r.cycle_id=p.cycle_id AND r.user_id=p.user_id AND EXISTS (SELECT 1 FROM report_versions rv WHERE rv.id=r.active_version_id AND rv.report_id=r.id AND rv.scan_status='PASSED' AND rv.preview_status='READY')) AS materials,
      (SELECT count(*)::int FROM reviews r WHERE r.org_id=p.org_id AND r.cycle_id=p.cycle_id AND r.target_id=p.user_id AND r.kind='SELF' AND EXISTS(SELECT 1 FROM review_revisions rv WHERE rv.id=r.current_revision_id AND ${effectiveReviewSql('r','rv')})) AS self_submitted,
      (SELECT count(*)::int FROM assignments a WHERE a.org_id=p.org_id AND a.cycle_id=p.cycle_id AND a.target_id=p.user_id AND a.status='ACTIVE' AND a.source_type<>'SELF') AS peer_expected,
      (SELECT count(*)::int FROM reviews r JOIN assignments a ON a.id=r.assignment_id AND a.org_id=r.org_id WHERE r.org_id=p.org_id AND r.cycle_id=p.cycle_id AND r.target_id=p.user_id AND r.kind='PEER' AND a.status='ACTIVE' AND a.source_type<>'SELF' AND EXISTS(SELECT 1 FROM review_revisions rv WHERE rv.id=r.current_revision_id AND ${effectiveReviewSql('r','rv')})) AS peer_submitted
      FROM cycle_participants p JOIN users u ON u.id=p.user_id AND u.org_id=p.org_id LEFT JOIN departments d ON d.id=p.dept_snapshot AND d.org_id=p.org_id
      WHERE p.org_id=$1 AND p.cycle_id=$2 AND p.eligibility='ELIGIBLE' AND ${scope} AND ${entry} ORDER BY d.sort_order NULLS LAST,u.display_name`,params)).rows;
    return {data:rows};
  }
  @Get('cycle-progress-tasks')
  async cycleProgressTasks(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string) {
    if(!cycleId||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cycleId)) throw new BadRequestException({code:'FIELD_INVALID'});
    await this.policy.assertCollection(actor,'progress.read',cycleId);
    await this.policy.assertCollection(actor,'assignment.read',cycleId);
    const params:unknown[]=[actor.orgId,cycleId,actor.userId];
    const filters=['progress.read','assignment.read','management.access'].flatMap(cap=>[
      this.policy.scopedSql(actor,cap as 'progress.read'|'assignment.read'|'management.access','a.cycle_id','rp.dept_snapshot',params),
      this.policy.scopedSql(actor,cap as 'progress.read'|'assignment.read'|'management.access','a.cycle_id','tp.dept_snapshot',params)]);
    const rows=(await this.db.query(`SELECT a.id,a.reviewer_id,a.target_id,ru.display_name AS reviewer_name,tu.display_name AS target_name,
      rd.name AS reviewer_department,td.name AS target_department,
      EXISTS(SELECT 1 FROM reviews r JOIN review_revisions rv ON rv.id=r.current_revision_id WHERE r.org_id=a.org_id AND r.cycle_id=a.cycle_id AND r.assignment_id=a.id AND r.kind='PEER' AND ${effectiveReviewSql('r','rv')}) AS completed
      FROM assignments a JOIN cycle_participants rp ON rp.org_id=a.org_id AND rp.cycle_id=a.cycle_id AND rp.user_id=a.reviewer_id
      JOIN cycle_participants tp ON tp.org_id=a.org_id AND tp.cycle_id=a.cycle_id AND tp.user_id=a.target_id
      JOIN users ru ON ru.id=a.reviewer_id AND ru.org_id=a.org_id JOIN users tu ON tu.id=a.target_id AND tu.org_id=a.org_id
      LEFT JOIN departments rd ON rd.id=rp.dept_snapshot AND rd.org_id=a.org_id LEFT JOIN departments td ON td.id=tp.dept_snapshot AND td.org_id=a.org_id
      WHERE a.org_id=$1 AND a.cycle_id=$2 AND a.target_id<>$3 AND a.status='ACTIVE' AND a.source_type<>'SELF' AND tp.eligibility='ELIGIBLE' AND ${filters.join(' AND ')} ORDER BY ru.display_name,tu.display_name`,params)).rows;
    return {data:rows};
  }
  @Get('cockpit')
  async cockpitData(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string,@Query('periods') periods?:string) {
    return {data:await this.cockpit.read(actor,cycleId,periods)};
  }
  @Get('exceptions')
  async exceptions(@CurrentUser() actor:AuthContext) {
    await this.policy.assertCollection(actor,'calibration.resolve');
    const params:unknown[]=[actor.orgId,actor.userId];
    const boundary=this.policy.scopedSql(actor,'calibration.resolve','cc.cycle_id','cp.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','cc.cycle_id','cp.dept_snapshot',params);
    return {data:(await this.db.query(`SELECT cc.id,cc.cycle_id,cc.reason_code,cc.status,cc.severity,cc.invalidated_at,cc.created_at,u.display_name AS target_name,d.name AS department_name,
      to_char(c.month,'YYYY-MM') AS month FROM calibration_cases cc JOIN review_revisions rr ON rr.id=cc.review_revision_id
      JOIN reviews r ON r.id=rr.review_id JOIN cycles c ON c.id=cc.cycle_id AND c.org_id=cc.org_id
      JOIN users u ON u.id=r.target_id AND u.org_id=cc.org_id
      JOIN cycle_participants cp ON cp.cycle_id=cc.cycle_id AND cp.user_id=r.target_id AND cp.org_id=cc.org_id
      LEFT JOIN departments d ON d.id=cp.dept_snapshot AND d.org_id=cc.org_id
      WHERE cc.org_id=$1 AND r.target_id<>$2 AND r.reviewer_id<>$2 AND ${boundary} AND ${entry} ORDER BY cc.created_at DESC`,params)).rows};
  }
  @Get('exception-history')
  async exceptionHistory(@CurrentUser() actor:AuthContext,@Query('caseId') caseId?:string) {
    if(!caseId||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(caseId))throw new BadRequestException({code:'FIELD_INVALID'});
    await this.policy.assertCollection(actor,'calibration.resolve');
    const params:unknown[]=[actor.orgId,actor.userId,caseId];
    const scope=this.policy.scopedSql(actor,'calibration.resolve','cc.cycle_id','cp.dept_snapshot',params);
    const allowed=await this.db.query(`SELECT cc.id FROM calibration_cases cc JOIN review_revisions rr ON rr.id=cc.review_revision_id JOIN reviews r ON r.id=rr.review_id JOIN cycle_participants cp ON cp.cycle_id=cc.cycle_id AND cp.org_id=cc.org_id AND cp.user_id=r.target_id WHERE cc.org_id=$1 AND r.target_id<>$2 AND r.reviewer_id<>$2 AND cc.id=$3 AND ${scope}`,params);
    if(!allowed.rowCount)throw new BadRequestException({code:'CASE_NOT_FOUND'});
    return {data:(await this.db.query(`SELECT a.action,a.reason,a.created_at,u.display_name AS actor_name FROM calibration_actions a LEFT JOIN users u ON u.id=a.actor_id AND u.org_id=a.org_id WHERE a.org_id=$1 AND a.case_id=$2 AND a.action<>'OPEN' ORDER BY a.created_at,a.id`,[actor.orgId,caseId])).rows};
  }
  @Get('dashboard')
  async dashboard(@CurrentUser() actor:AuthContext) {
    // Scope each numerator and denominator by the same participant boundary.
    const params:unknown[]=[actor.orgId];
    const scope=this.policy.scopedSql(actor,'progress.read','c.id','p.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','c.id','p.dept_snapshot',params);
    const manage=this.policy.scopedSql(actor,'cycle.manage','c.id',null,params);
    const rows=(await this.db.query(`SELECT c.id,c.title,to_char(c.month,'YYYY-MM') AS month,c.status,c.open_at,c.close_at,c.publish_at,c.ruleset_id,c.row_version,(${manage}) AS can_manage,
      (SELECT count(*)::int FROM cycle_participants p WHERE p.cycle_id=c.id AND p.org_id=c.org_id AND p.eligibility='ELIGIBLE' AND ${scope} AND ${entry}) AS participants,
      (SELECT count(*)::int FROM monthly_reports r JOIN cycle_participants p ON p.cycle_id=r.cycle_id AND p.user_id=r.user_id AND p.org_id=r.org_id
        WHERE r.cycle_id=c.id AND r.org_id=c.org_id AND p.eligibility='ELIGIBLE' AND ${scope} AND ${entry} AND EXISTS(SELECT 1 FROM report_versions rv WHERE rv.id=r.active_version_id AND rv.report_id=r.id AND rv.scan_status='PASSED' AND rv.preview_status='READY')) AS materials,
      (SELECT count(*)::int FROM reviews r JOIN cycle_participants p ON p.cycle_id=r.cycle_id AND p.user_id=r.target_id AND p.org_id=r.org_id
        WHERE r.cycle_id=c.id AND r.org_id=c.org_id AND r.kind='SELF' AND EXISTS(SELECT 1 FROM review_revisions rv WHERE rv.id=r.current_revision_id AND ${effectiveReviewSql('r','rv')}) AND p.eligibility='ELIGIBLE' AND ${scope} AND ${entry}) AS self_submitted,
      (SELECT count(*)::int FROM assignments a JOIN cycle_participants p ON p.cycle_id=a.cycle_id AND p.user_id=a.target_id AND p.org_id=a.org_id
        WHERE a.cycle_id=c.id AND a.org_id=c.org_id AND a.status='ACTIVE' AND a.source_type<>'SELF' AND p.eligibility='ELIGIBLE' AND ${scope} AND ${entry}) AS peer_expected,
      (SELECT count(*)::int FROM reviews r JOIN assignments a ON a.id=r.assignment_id AND a.org_id=r.org_id
        JOIN cycle_participants p ON p.cycle_id=r.cycle_id AND p.user_id=r.target_id AND p.org_id=r.org_id
        WHERE r.cycle_id=c.id AND r.org_id=c.org_id AND r.kind='PEER' AND EXISTS(SELECT 1 FROM review_revisions rv WHERE rv.id=r.current_revision_id AND ${effectiveReviewSql('r','rv')}) AND a.status='ACTIVE' AND a.source_type<>'SELF' AND p.eligibility='ELIGIBLE' AND ${scope} AND ${entry}) AS peer_submitted,
      (SELECT count(DISTINCT pr.target_id)::int FROM published_results pr JOIN cycle_participants p ON p.cycle_id=pr.cycle_id AND p.user_id=pr.target_id AND p.org_id=pr.org_id
        WHERE pr.cycle_id=c.id AND pr.org_id=c.org_id AND p.eligibility='ELIGIBLE' AND ${scope} AND ${entry}) AS published,
      (SELECT count(*)::int FROM calibration_cases cc JOIN reviews r ON r.current_revision_id=cc.review_revision_id AND r.org_id=cc.org_id JOIN cycle_participants p ON p.cycle_id=cc.cycle_id AND p.user_id=r.target_id AND p.org_id=cc.org_id WHERE cc.cycle_id=c.id AND cc.org_id=c.org_id AND cc.status='OPEN' AND cc.invalidated_at IS NULL AND p.eligibility='ELIGIBLE' AND ${scope} AND ${entry}) AS open_cases
      FROM cycles c WHERE c.org_id=$1 AND EXISTS(SELECT 1 FROM (SELECT NULL::uuid AS dept_snapshot UNION SELECT dept_snapshot FROM cycle_participants WHERE cycle_id=c.id AND org_id=c.org_id) p WHERE ${scope} AND ${entry}) ORDER BY c.month DESC,c.created_at DESC`,params)).rows;
    return {data:rows.map(r=>({...r,materialRate:r.participants?r.materials/r.participants:null,
      selfRate:r.participants?r.self_submitted/r.participants:null,peerRate:r.peer_expected?r.peer_submitted/r.peer_expected:null,management_stage:r.status==='CALIBRATING'?(r.open_cases?'待核验':'待发布'):null})),permissions:{canCreate:await this.policy.hasCapability(actor.userId,actor.orgId,'cycle.manage')}};
  }
  @Get('archives')
  async archives(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string,@Query('departmentId') departmentId?:string,@Query('history') history?:string) {
    await this.policy.assertCollection(actor,'result.read_published',cycleId);
    if(cycleId&&!/^[\da-f-]{36}$/i.test(cycleId)||departmentId&&!/^[\da-f-]{36}$/i.test(departmentId))throw new BadRequestException({code:'FIELD_INVALID'});
    const params:unknown[]=[actor.orgId,cycleId??null,departmentId??null];
    const boundary=this.policy.scopedSql(actor,'result.read_published','p.cycle_id','cp.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','p.cycle_id','cp.dept_snapshot',params);
    const rows=(await this.db.query(`SELECT p.id,p.cycle_id,to_char(c.month,'YYYY-MM') AS month,c.title,p.target_id,u.display_name,
      cp.dept_snapshot AS department_id,d.name AS department_name,p.publication_version,p.supersedes_id,p.published_at,p.payload_json,
      b.exact_score AS peer_average,b.dimension_json AS dimension_aggregates,
      (SELECT jsonb_object_agg(ti.id::text,jsonb_build_object('code',ti.code,'label',ti.label))
        FROM template_items ti JOIN template_versions tv ON tv.id=ti.template_id
        WHERE tv.ruleset_id=c.ruleset_id AND tv.org_id=p.org_id) AS dimension_metadata
      FROM published_results p JOIN cycles c ON c.id=p.cycle_id AND c.org_id=p.org_id JOIN users u ON u.id=p.target_id AND u.org_id=p.org_id
      JOIN cycle_participants cp ON cp.cycle_id=p.cycle_id AND cp.user_id=p.target_id AND cp.org_id=p.org_id LEFT JOIN departments d ON d.id=cp.dept_snapshot AND d.org_id=p.org_id
      JOIN result_builds b ON b.id=p.result_build_id AND b.org_id=p.org_id
      WHERE p.org_id=$1 AND ($2::uuid IS NULL OR p.cycle_id=$2) AND ($3::uuid IS NULL OR cp.dept_snapshot=$3) AND ${boundary} AND ${entry}
      ${history==='true'?'':`AND NOT EXISTS(SELECT 1 FROM published_results newer WHERE newer.org_id=p.org_id AND newer.cycle_id=p.cycle_id AND newer.target_id=p.target_id AND newer.publication_version>p.publication_version)`}
      ORDER BY c.month DESC,u.display_name,p.publication_version DESC`,params)).rows;
    return {data:rows};
  }
  @Get('archive-ledger')
  async archiveLedger(@CurrentUser() actor:AuthContext) {
    await this.policy.assertCollection(actor,'progress.read');
    await this.policy.assertCollection(actor,'result.read_published');
    const params:unknown[]=[actor.orgId];
    const progress=this.policy.scopedSql(actor,'progress.read','c.id','cp.dept_snapshot',params);
    const results=this.policy.scopedSql(actor,'result.read_published','c.id','cp.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','c.id','cp.dept_snapshot',params);
    const rows=(await this.db.query(`SELECT c.id,c.title,to_char(c.month,'YYYY-MM') AS month,c.status,c.open_at,c.close_at,
      count(DISTINCT cp.user_id) FILTER (WHERE cp.eligibility='ELIGIBLE')::int AS participants,
      count(DISTINCT cp.user_id) FILTER (WHERE cp.eligibility='ELIGIBLE' AND latest.id IS NOT NULL)::int AS published,
      max(latest.published_at) FILTER (WHERE cp.eligibility='ELIGIBLE') AS published_at,
      (SELECT reason FROM cycle_state_log l WHERE l.cycle_id=c.id AND l.reason IS NOT NULL AND l.reason<>'' ORDER BY l.created_at DESC,l.id DESC LIMIT 1) AS reason
      FROM cycles c LEFT JOIN cycle_participants cp ON cp.cycle_id=c.id AND cp.org_id=c.org_id
      LEFT JOIN LATERAL (SELECT pr.id,pr.published_at FROM published_results pr WHERE pr.org_id=cp.org_id AND pr.cycle_id=cp.cycle_id AND pr.target_id=cp.user_id ORDER BY pr.publication_version DESC LIMIT 1) latest ON true
      WHERE c.org_id=$1 AND ${progress} AND ${results} AND ${entry}
      GROUP BY c.id ORDER BY c.month DESC,c.created_at DESC`,params)).rows;
    return {data:rows};
  }
  @Get('insights-summary')
  async insightsSummary(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string,@Query('departmentId') departmentId?:string) {
    if(!cycleId||!departmentId||![cycleId,departmentId].every(v=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)))throw new BadRequestException({code:'FIELD_INVALID'});
    await this.policy.assertCollection(actor,'progress.read',cycleId);
    await this.policy.assertCollection(actor,'result.read_published',cycleId);
    const params:unknown[]=[actor.orgId,cycleId,departmentId];
    const progress=this.policy.scopedSql(actor,'progress.read','cp.cycle_id','cp.dept_snapshot',params);
    const results=this.policy.scopedSql(actor,'result.read_published','cp.cycle_id','cp.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','cp.cycle_id','cp.dept_snapshot',params);
    const row=(await this.db.query(`SELECT count(*)::int AS participants,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM monthly_reports mr JOIN report_versions rv ON rv.id=mr.active_version_id AND rv.report_id=mr.id AND rv.org_id=mr.org_id WHERE mr.org_id=cp.org_id AND mr.cycle_id=cp.cycle_id AND mr.user_id=cp.user_id AND rv.scan_status='PASSED' AND rv.preview_status='READY'))::int AS materials,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM published_results pr WHERE pr.org_id=cp.org_id AND pr.cycle_id=cp.cycle_id AND pr.target_id=cp.user_id))::int AS published
      FROM cycle_participants cp WHERE cp.org_id=$1 AND cp.cycle_id=$2 AND cp.dept_snapshot=$3 AND cp.eligibility='ELIGIBLE' AND ${progress} AND ${results} AND ${entry}`,params)).rows[0];
    return {data:{...row,materialRate:row.participants?row.materials/row.participants:null}};
  }
  @Get('departments')
  async departments(@CurrentUser() actor:AuthContext) {
    const params:unknown[]=[actor.orgId];
    const progress=this.policy.scopedSql(actor,'progress.read','cp.cycle_id','d.id',params);
    const results=this.policy.scopedSql(actor,'result.read_published','cp.cycle_id','d.id',params);
    return {data:(await this.db.query(`SELECT d.id,d.name FROM departments d WHERE d.org_id=$1 AND EXISTS (
      SELECT 1 FROM (SELECT NULL::uuid AS cycle_id UNION SELECT cycle_id FROM cycle_participants WHERE org_id=$1 AND dept_snapshot=d.id) cp
      WHERE ${progress} OR ${results}) ORDER BY d.sort_order,d.name`,params)).rows};
  }
  @Get('submissions')
  async submissions(@CurrentUser() actor:AuthContext,@Query('cycleId') cycleId?:string) {
    await this.policy.assertCollection(actor,'progress.read',cycleId);
    if(!cycleId)return {data:[]};
    const params:unknown[]=[actor.orgId,cycleId];const boundary=this.policy.scopedSql(actor,'progress.read','cp.cycle_id','cp.dept_snapshot',params);
    const entry=this.policy.scopedSql(actor,'management.access','cp.cycle_id','cp.dept_snapshot',params);
    return {data:(await this.db.query(`SELECT cp.user_id,u.display_name,cp.dept_snapshot,cp.eligibility,
      r.active_version_id,r.locked_at,s.status AS self_status,s.current_revision_id
      FROM cycle_participants cp JOIN users u ON u.id=cp.user_id AND u.org_id=cp.org_id
      LEFT JOIN monthly_reports r ON r.cycle_id=cp.cycle_id AND r.user_id=cp.user_id AND r.org_id=cp.org_id
      LEFT JOIN reviews s ON s.cycle_id=cp.cycle_id AND s.target_id=cp.user_id AND s.kind='SELF' AND s.org_id=cp.org_id
      WHERE cp.org_id=$1 AND cp.cycle_id=$2 AND ${boundary} AND ${entry} ORDER BY u.display_name`,params)).rows};
  }
}
