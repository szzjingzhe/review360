import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PolicyService } from '../authz/policy.service';
import { Pool, PoolClient } from 'pg';
import { generateAssignment, ALGORITHM_VERSION, lockResultCycle, invalidateTargetBuilds, loadAssignmentInput, MIN_INDEGREE, ASSIGNMENT_MAX_INDEGREE, ASSIGNMENT_MAX_OUTDEGREE, checkOpenPrerequisites, openConfirmedCycle, AssignmentStateError, assignmentEdgeIssue } from '@360/domain';

interface CycleRow {
  id: string;
  month: string;
  status: string;
  ruleset_id: string;
}

/**
 * 分配服务（技术文档 §7 / M2.4）：
 * 预检（preview）：从参与者快照 + 历史边生成可行性预览 run，不落 assignments；
 * 开期（open）：PENDING_OPEN → REVIEWING，锁定 run、写入 assignments 与 cycle_locks；
 * 替补（replace）：评审期单边替换（REPLACEMENT 边，引用被替换边）。
 */
@Injectable()
export class AssignmentService {
  constructor(@Inject('DATABASE_POOL') private readonly db: Pool) {}

  /** 从参与者快照构建 domain 输入（快照即锁定的人员视图） */
  private async loadDomainInput(orgId:string,cycle:CycleRow,db:Pick<PoolClient,'query'>=this.db){return loadAssignmentInput(db,orgId,cycle);}

  /** Department grants expose and edit only relations wholly within that department. */
  async manualRelations(actor:{userId:string;orgId:string},cycleId:string) {
    await this.getManageableCycle(actor.orgId,cycleId,['DRAFT','PENDING_OPEN','REVIEWING','CALIBRATING','PARTIALLY_PUBLISHED','PUBLISHED','ARCHIVED']);
    const params:unknown[]=[cycleId,actor.orgId];
    const boundary=new PolicyService(this.db).scopedSql(actor,'assignment.manage','p.cycle_id','p.dept_snapshot',params);
    const participants=(await this.db.query(`SELECT p.user_id,p.dept_snapshot,p.role_snapshot,u.display_name,d.name AS department_name
      FROM cycle_participants p JOIN users u ON u.id=p.user_id AND u.org_id=p.org_id JOIN departments d ON d.id=p.dept_snapshot AND d.org_id=p.org_id
      WHERE p.cycle_id=$1 AND p.org_id=$2 AND p.eligibility='ELIGIBLE' AND p.role_snapshot IN ('HEAD','MEMBER') AND ${boundary}
      ORDER BY d.name,u.display_name`,params)).rows;
    const ids=participants.map(p=>p.user_id);
    const names=this.nameMap(participants);
    if(ids.length===0)return {participants,edges:[],logs:[]};
    const edges=(await this.db.query(`SELECT id,reviewer_id,target_id,reason,created_by,created_at FROM assignment_manual_edges WHERE cycle_id=$1 AND org_id=$2 AND reviewer_id=ANY($3::uuid[]) AND target_id=ANY($3::uuid[]) ORDER BY created_at,id`,[cycleId,actor.orgId,ids])).rows;
    const logs=(await this.db.query(`SELECT ae.id,ae.action,ae.created_at,ae.reason,u.display_name AS actor_name
      FROM audit_events ae LEFT JOIN users u ON u.id=ae.actor_id AND u.org_id=ae.org_id
      WHERE ae.org_id=$1 AND ae.resource_type='cycle' AND ae.resource_id=$2
      AND ae.action IN ('assignment.manual.add','assignment.manual.remove')
      AND split_part(ae.reason,'->',1)=ANY($3::text[]) AND split_part(split_part(ae.reason,'->',2),' | ',1)=ANY($3::text[])
      ORDER BY ae.created_at DESC,ae.id DESC LIMIT 100`,[actor.orgId,cycleId,ids])).rows;
    // 审计 reason 形如「<reviewerId>-><targetId> | 跨部门 | 原因：<文本>」；只回显记录到的内容，旧记录不补造操作人姓名。
    const parse=this.parseAuditReason;
    return {participants,edges:edges.map(e=>({...e,reviewer_name:names.get(e.reviewer_id)??null,target_name:names.get(e.target_id)??null,created_by_name:e.created_by?names.get(e.created_by)??null:null})),
      logs:logs.map(l=>({...l,...parse(l.reason)}))};
  }

  /** 解析人工关系审计摘要；无法识别的历史记录返回空字段，由界面显示「未记录」。 */
  private parseAuditReason(reason:string|null|undefined){
    const [pair='',...rest]=String(reason??'').split(' | ');
    const [reviewerId='',targetId='']=pair.split('->');
    const crossDepartment=rest.some(part=>part==='跨部门');
    const reasonText=rest.find(part=>part.startsWith('原因：'))?.slice('原因：'.length)??null;
    return {reviewer_id:reviewerId||null,target_id:targetId||null,cross_department:crossDepartment,reason_text:reasonText};
  }

  /** 审核人/被评价人姓名映射，供关系表与操作日志展示 */
  private nameMap(participants: Array<{user_id:string;display_name:string}>) {
    return new Map(participants.map(p=>[p.user_id,p.display_name]));
  }

  async setManualRelation(actor:{userId:string;orgId:string},cycleId:string,body:Record<string,unknown>,remove=false) {
    const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if(typeof body.reviewer_id!=='string'||typeof body.target_id!=='string'||!uuid.test(body.reviewer_id)||!uuid.test(body.target_id)||body.reviewer_id===body.target_id)
      throw new BadRequestException({code:'MANUAL_EDGE_INVALID'});
    if(!remove&&(typeof body.reason!=='string'||!body.reason.trim()||body.reason.trim().length>500))throw new BadRequestException({code:'MANUAL_REASON_REQUIRED'});
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');await lockResultCycle(client,cycleId);
      const cycle=(await client.query('SELECT status FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE',[cycleId,actor.orgId])).rows[0];
      if(!cycle)throw new NotFoundException({code:'CYCLE_NOT_FOUND'});
      if(!['DRAFT','PENDING_OPEN'].includes(cycle.status))throw new ConflictException({code:'ASSIGNMENT_LOCKED'});
      const people=(await client.query(`SELECT user_id,dept_snapshot,role_snapshot FROM cycle_participants WHERE cycle_id=$1 AND org_id=$2 AND user_id=ANY($3::uuid[]) AND eligibility='ELIGIBLE' FOR SHARE`,[cycleId,actor.orgId,[body.reviewer_id,body.target_id]])).rows;
      if(people.length!==2||people.some(p=>!['HEAD','MEMBER'].includes(p.role_snapshot)))throw new BadRequestException({code:'MANUAL_PARTICIPANT_INVALID'});
      const policy=new PolicyService(client as unknown as Pool);
      const crossDepartment=people[0].dept_snapshot!==people[1].dept_snapshot;
      if(crossDepartment){
        // 跨部门人工指定：部门级授权不足以防串用，要求评价人对本周期持有管理授权（ORG/CYCLE）。
        const cycleScope=await policy.hasCapability(actor.userId,actor.orgId,'assignment.manage',{scopeType:'CYCLE',scopeId:cycleId});
        if(!cycleScope)throw new ForbiddenException({code:'CROSS_DEPARTMENT_REQUIRES_CYCLE_SCOPE'});
        await policy.assertCycleParticipant(actor,cycleId,body.reviewer_id);
        await policy.assertCycleParticipant(actor,cycleId,body.target_id);
      } else {
        await policy.assertParticipant(actor,'assignment.manage',cycleId,body.reviewer_id);
        await policy.assertParticipant(actor,'assignment.manage',cycleId,body.target_id);
      }
      if(remove)await client.query('DELETE FROM assignment_manual_edges WHERE cycle_id=$1 AND org_id=$2 AND reviewer_id=$3 AND target_id=$4',[cycleId,actor.orgId,body.reviewer_id,body.target_id]);
      else {
        const edges=(await client.query('SELECT reviewer_id AS "reviewerId",target_id AS "targetId" FROM assignment_manual_edges WHERE cycle_id=$1 AND org_id=$2',[cycleId,actor.orgId])).rows;
        const issue=assignmentEdgeIssue(people.map(p=>({userId:p.user_id,deptId:p.dept_snapshot,role:p.role_snapshot})),edges,body.reviewer_id,body.target_id,true);
        if(issue)throw new BadRequestException({code:issue});
        await client.query(`INSERT INTO assignment_manual_edges(org_id,cycle_id,reviewer_id,target_id,created_by,reason) VALUES($1,$2,$3,$4,$5,$6)`,[actor.orgId,cycleId,body.reviewer_id,body.target_id,actor.userId,(body.reason as string).trim()]);
      }
      await client.query("UPDATE assignment_runs SET status='SUPERSEDED' WHERE cycle_id=$1 AND status IN ('FEASIBLE','INFEASIBLE')",[cycleId]);
      await client.query('DELETE FROM cycle_open_confirmations WHERE cycle_id=$1',[cycleId]);
      const auditReason=`${body.reviewer_id}->${body.target_id}${crossDepartment?' | 跨部门':''}${remove?'':' | 原因：'+(body.reason as string).trim()}`;
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,$3,'cycle',$4,$5)`,[actor.orgId,actor.userId,remove?'assignment.manual.remove':'assignment.manual.add',cycleId,auditReason]);
      await client.query('COMMIT');return {ok:true,cross_department:crossDepartment};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }

  /** 生成预览 run（FEASIBLE/INFEASIBLE），不写 assignments */
  async previewRun(actor: { userId: string; orgId: string }, cycleId: string) {
    const cycle = await this.getManageableCycle(actor.orgId, cycleId, ['DRAFT', 'PENDING_OPEN']);
    const { domainParticipants, history, manualEdges } = await this.loadDomainInput(actor.orgId, cycle);

    const seed = cycle.month;
    const result = generateAssignment({
      participants: domainParticipants,
      manualEdges,
      history,
      avoidPairs: [],
      seed,
      algorithmVersion: ALGORITHM_VERSION,
    });

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await lockResultCycle(client,cycleId);
      const current=(await client.query('SELECT status FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE',[cycleId,actor.orgId])).rows[0];
      if(!current||!['DRAFT','PENDING_OPEN'].includes(current.status))throw new ConflictException({code:'ASSIGNMENT_LOCKED'});
      const fresh=await this.loadDomainInput(actor.orgId,cycle,client);
      if(generateAssignment({participants:fresh.domainParticipants,history:fresh.history,manualEdges:fresh.manualEdges,avoidPairs:[],seed,algorithmVersion:ALGORITHM_VERSION}).inputHash!==result.inputHash)throw new ConflictException({code:'RUN_INPUT_CHANGED'});
      const version = await this.nextRunVersion(client, cycleId);
      const { rows } = await client.query(
        `INSERT INTO assignment_runs (id, cycle_id, org_id, version, seed, algorithm_version, input_hash, cost, diagnostics, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, version, status, seed, algorithm_version, input_hash, diagnostics`,
        [
          cycleId,
          actor.orgId,
          version,
          seed,
          result.algorithmVersion,
          result.inputHash,
          result.edges.length,
          JSON.stringify({ feasible: result.feasible, diagnostics: result.diagnostics }),
          result.feasible ? 'FEASIBLE' : 'INFEASIBLE',
        ],
      );
      await client.query('COMMIT');
      const departmentRows=(await this.db.query(`SELECT p.user_id,d.name AS department_name,d.code AS department_code
        FROM cycle_participants p LEFT JOIN departments d ON d.id=p.dept_snapshot AND d.org_id=p.org_id
        WHERE p.cycle_id=$1 AND p.org_id=$2`,[cycleId,actor.orgId])).rows as Array<{user_id:string;department_name:string|null;department_code:string|null}>;
      const deptNames=new Map(departmentRows.map(r=>[r.user_id,r.department_name]));
      const diagnostics=result.diagnostics.map(message=>{
        for(const person of domainParticipants) message=message.split(person.userId).join(person.displayName||'参评成员');
        for(const department of departmentRows) if(department.department_code) message=message.replace('部门 '+department.department_code,'部门 '+(department.department_name||'未分配'));
        return message.replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi,'相关成员');
      });
      return {
        ...rows[0],
        edge_count: result.edges.length,
        feasible: result.feasible,
        diagnostics,
        // 缺口带上姓名与部门，界面不再直接暴露 UUID
        shortfalls: result.shortfalls.map((s)=>({...s,department_name:deptNames.get(s.targetId)??null})),
        indegree_summary: this.summarizeIndegrees(result.indegrees),
        indegrees:result.indegrees,outdegrees:result.outdegrees,limits:{minReceived:MIN_INDEGREE,maxReceived:ASSIGNMENT_MAX_INDEGREE,maxAssigned:ASSIGNMENT_MAX_OUTDEGREE},
        edges:result.edges.map(e=>({...e,reviewerName:domainParticipants.find(p=>p.userId===e.reviewerId)?.displayName,targetName:domainParticipants.find(p=>p.userId===e.targetId)?.displayName})),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** 保存已经核对过的预览方案；关系仍是草稿，开期时才正式生效。 */
  async confirmPreview(actor:{userId:string;orgId:string},cycleId:string,runId:unknown) {
    if(typeof runId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(runId))throw new BadRequestException({code:'PREVIEW_REQUIRED'});
    const client=await this.db.connect();try {
      await client.query('BEGIN');await lockResultCycle(client,cycleId);
      const cycle=(await client.query("SELECT id,to_char(month,'YYYY-MM-DD') AS month,status,ruleset_id FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE",[cycleId,actor.orgId])).rows[0];
      if(!cycle||!['DRAFT','PENDING_OPEN'].includes(cycle.status))throw new ConflictException({code:'ASSIGNMENT_LOCKED'});
      const run=(await client.query("SELECT id,input_hash FROM assignment_runs WHERE id=$1 AND cycle_id=$2 AND org_id=$3 AND status='FEASIBLE' FOR UPDATE",[runId,cycleId,actor.orgId])).rows[0];
      if(!run)throw new BadRequestException({code:'RUN_NOT_FEASIBLE'});
      const input=await loadAssignmentInput(client,actor.orgId,cycle);
      const result=generateAssignment({participants:input.domainParticipants,history:input.history,manualEdges:input.manualEdges,avoidPairs:[],seed:cycle.month,algorithmVersion:ALGORITHM_VERSION});
      if(!result.feasible||result.inputHash!==run.input_hash)throw new ConflictException({code:'RUN_INPUT_CHANGED'});
      await client.query("UPDATE assignment_runs SET diagnostics=coalesce(diagnostics,'{}'::jsonb)||jsonb_build_object('confirmed_at',now(),'confirmed_by',$3::text) WHERE id=$1 AND org_id=$2",[runId,actor.orgId,actor.userId]);
      await client.query("UPDATE assignment_runs SET diagnostics=diagnostics-'confirmed_at'-'confirmed_by' WHERE cycle_id=$1 AND org_id=$2 AND id<>$3 AND status IN ('FEASIBLE','INFEASIBLE') AND diagnostics ? 'confirmed_at'",[cycleId,actor.orgId,runId]);
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'assignment.preview.confirm','cycle',$3,$4)",[actor.orgId,actor.userId,cycleId,'confirmed preview '+runId]);
      await client.query('COMMIT');return {id:runId,edge_count:result.edges.length};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }

  async confirmedPreview(actor:{userId:string;orgId:string},cycleId:string) {
    const cycle=await this.getManageableCycle(actor.orgId,cycleId,['DRAFT','PENDING_OPEN']);
    const run=(await this.db.query("SELECT id,input_hash FROM assignment_runs WHERE cycle_id=$1 AND org_id=$2 AND status='FEASIBLE' AND diagnostics ? 'confirmed_at' ORDER BY created_at DESC LIMIT 1",[cycleId,actor.orgId])).rows[0];
    if(!run)return null;
    const input=await this.loadDomainInput(actor.orgId,cycle);
    const result=generateAssignment({participants:input.domainParticipants,history:input.history,manualEdges:input.manualEdges,avoidPairs:[],seed:cycle.month,algorithmVersion:ALGORITHM_VERSION});
    if(!result.feasible||run.input_hash!==result.inputHash)return null;
    const names=new Map(input.domainParticipants.map(p=>[p.userId,p.displayName]));
    return {id:run.id,feasible:true,edge_count:result.edges.length,indegrees:result.indegrees,outdegrees:result.outdegrees,limits:{minReceived:MIN_INDEGREE,maxReceived:ASSIGNMENT_MAX_INDEGREE,maxAssigned:ASSIGNMENT_MAX_OUTDEGREE},edges:result.edges.map(e=>({...e,reviewerName:names.get(e.reviewerId),targetName:names.get(e.targetId)}))};
  }

  /** 开期：PENDING_OPEN → REVIEWING，锁定分配并写入 assignments */
  async openCycle(actor:{userId:string;orgId:string},cycleId:string,runId?:string){
    if(!runId)throw new BadRequestException({code:'PREVIEW_CONFIRM_REQUIRED'});
    const client=await this.db.connect();try{
      await client.query('BEGIN');await lockResultCycle(client,cycleId);
      const cycle=(await client.query("SELECT id,to_char(month,'YYYY-MM-DD') AS month,status,ruleset_id,open_at,close_at,now() AS now FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE",[cycleId,actor.orgId])).rows[0];
      if(!cycle)throw new NotFoundException({code:'CYCLE_NOT_FOUND'});
      if(cycle.status!=='PENDING_OPEN')throw new ConflictException({code:'STATE_CONFLICT'});
      const run=(await client.query("SELECT id,input_hash FROM assignment_runs WHERE id=$1 AND cycle_id=$2 AND org_id=$3 AND status='FEASIBLE'",[runId,cycleId,actor.orgId])).rows[0];
      if(!run)throw new BadRequestException({code:'RUN_NOT_FEASIBLE'});
      const input=await loadAssignmentInput(client,actor.orgId,cycle);
      const result=generateAssignment({participants:input.domainParticipants,history:input.history,manualEdges:input.manualEdges,avoidPairs:[],seed:cycle.month,algorithmVersion:ALGORITHM_VERSION});
      if(!result.feasible||result.inputHash!==run.input_hash)throw new ConflictException({code:'RUN_INPUT_CHANGED'});
      const prereq=await checkOpenPrerequisites(client,actor.orgId);
      if(prereq.blocking.length)throw new BadRequestException({code:'OPEN_PREREQUISITE_MISSING',missing:prereq.blocking});
      await client.query('INSERT INTO cycle_open_confirmations(cycle_id,org_id,run_id,confirmed_by) VALUES($1,$2,$3,$4) ON CONFLICT(cycle_id) DO UPDATE SET run_id=EXCLUDED.run_id,confirmed_by=EXCLUDED.confirmed_by,confirmed_at=now()',[cycleId,actor.orgId,runId,actor.userId]);
      const outcome=cycle.open_at&&cycle.now<cycle.open_at?{cycle_id:cycleId,status:'PENDING_OPEN',scheduled:true}:await openConfirmedCycle(client,actor,cycleId,runId);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'cycle.confirm_open','cycle',$3,$4)`,[actor.orgId,actor.userId,cycleId,'confirmed preview '+runId]);
      await client.query('COMMIT');return outcome;
    }catch(error){await client.query('ROLLBACK');if(error instanceof AssignmentStateError)throw new BadRequestException(error.detail);if((error as {code?:string}).code==='23505')throw new BadRequestException({code:'CYCLE_ACTIVE_EXISTS'});throw error;}finally{client.release();}
  }

  /** 替补：取消一条边，补一条 REPLACEMENT 边（自动选人或指定 reviewer） */
  async replaceAssignment(actor:{userId:string;orgId:string},cycleId:string,assignmentId:string,body:Record<string,unknown>){
    const c=await this.db.connect();try{
      await c.query('BEGIN');await lockResultCycle(c,cycleId);
      const cycle=(await c.query("SELECT id,status,close_at,now() AS now FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE",[cycleId,actor.orgId])).rows[0];
      if(!cycle)throw new NotFoundException();if(!['REVIEWING','CALIBRATING','PARTIALLY_PUBLISHED'].includes(cycle.status))throw new BadRequestException({code:'STATE_CONFLICT'});
      const afterDeadline=cycle.status==='CALIBRATING'||!cycle.close_at||cycle.now>=cycle.close_at;
      const dueAt=typeof body.due_at==='string'?new Date(body.due_at):null;
      if(afterDeadline&&(!dueAt||!Number.isFinite(dueAt.getTime())||dueAt<=cycle.now))throw new BadRequestException({code:'SUPPLEMENT_DEADLINE_REQUIRED'});
      if(dueAt&&(!Number.isFinite(dueAt.getTime())||dueAt<=cycle.now))throw new BadRequestException({code:'SUPPLEMENT_DEADLINE_INVALID'});
      if(afterDeadline&&(typeof body.reason!=='string'||!body.reason.trim()))throw new BadRequestException({code:'SUPPLEMENT_REASON_REQUIRED'});
      const old=(await c.query('SELECT * FROM assignments WHERE id=$1 AND cycle_id=$2 AND org_id=$3 FOR UPDATE',[assignmentId,cycleId,actor.orgId])).rows[0];
      if(!old)throw new NotFoundException();if(old.status!=='ACTIVE')throw new BadRequestException({code:'ASSIGNMENT_NOT_ACTIVE'});
      if((await c.query('SELECT 1 FROM published_results WHERE cycle_id=$1 AND target_id=$2 AND org_id=$3 LIMIT 1',[cycleId,old.target_id,actor.orgId])).rowCount)throw new BadRequestException({code:'PUBLISHED_TARGET_REQUIRES_CORRECTION'});
      if((await c.query("SELECT 1 FROM reviews WHERE assignment_id=$1 AND status='SUBMITTED'",[assignmentId])).rowCount)throw new BadRequestException({code:'ASSIGNMENT_ALREADY_SUBMITTED'});
      const people=(await c.query("SELECT p.user_id AS \"userId\",p.dept_snapshot AS \"deptId\",p.role_snapshot AS role FROM cycle_participants p JOIN users u ON u.id=p.user_id AND u.org_id=p.org_id AND u.status='ACTIVE' WHERE p.cycle_id=$1 AND p.org_id=$2 AND p.eligibility='ELIGIBLE'",[cycleId,actor.orgId])).rows;
      const edges=(await c.query(`SELECT reviewer_id AS "reviewerId",target_id AS "targetId" FROM assignments WHERE cycle_id=$1 AND org_id=$2 AND status<>'CANCELLED' AND id<>$3`,[cycleId,actor.orgId,assignmentId])).rows;
      const requested=typeof body.reviewer_id==='string'&&body.reviewer_id?body.reviewer_id:null;
      if(requested&&!people.some(p=>p.userId===requested))throw new NotFoundException({code:'REPLACEMENT_CANDIDATE_NOT_FOUND'});
      const candidates=requested?people.filter(p=>p.userId===requested):people.filter(p=>!assignmentEdgeIssue(people,edges,p.userId,old.target_id)).sort((a,b)=>edges.filter(e=>e.reviewerId===a.userId).length-edges.filter(e=>e.reviewerId===b.userId).length||a.userId.localeCompare(b.userId));
      const reviewer=candidates[0];if(!reviewer)throw new BadRequestException({code:'NO_REPLACEMENT_CANDIDATE'});
      const issue=assignmentEdgeIssue(people,edges,reviewer.userId,old.target_id);if(issue)throw new BadRequestException({code:issue});
      const reason=typeof body.reason==='string'?body.reason.trim().slice(0,500):'controlled replacement';
      await c.query("UPDATE assignments SET status='CANCELLED',reason=$2 WHERE id=$1",[assignmentId,reason]);
      const created=(await c.query("INSERT INTO assignments(id,run_id,cycle_id,org_id,reviewer_id,target_id,source_type,is_fixed,replaces_id,reason) SELECT gen_random_uuid(),l.assignment_run_id,$1,$2,$3,$4,'REPLACEMENT',false,$5,$6 FROM cycle_locks l WHERE l.cycle_id=$1 RETURNING id,reviewer_id,target_id,source_type,replaces_id",[cycleId,actor.orgId,reviewer.userId,old.target_id,assignmentId,reason])).rows[0];
      if(!created)throw new BadRequestException({code:'CYCLE_NOT_LOCKED'});
      if(dueAt)await c.query('UPDATE assignments SET supplement_due_at=$2,supplement_authorized_by=$3 WHERE id=$1',[created.id,dueAt,actor.userId]);
      await c.query("INSERT INTO reviews(id,cycle_id,org_id,assignment_id,reviewer_id,target_id,kind,status) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'PEER','DRAFT')",[cycleId,actor.orgId,created.id,reviewer.userId,old.target_id]);
      await c.query('UPDATE cycles SET assignment_version=coalesce(assignment_version,1)+1 WHERE id=$1 AND org_id=$2',[cycleId,actor.orgId]);
      await invalidateTargetBuilds(c,cycleId,old.target_id);
      await c.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'assignment.replace','assignment',$3,$4)",[actor.orgId,actor.userId,created.id,JSON.stringify({reason,replacesId:assignmentId,supplementDueAt:dueAt?.toISOString()??null})]);
      await c.query('COMMIT');return created;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }

  /** 列出周期分配 run 与统计（assignment.manage） */
  async listRuns(orgId: string, cycleId: string) {
    const { rows } = await this.db.query(
      `SELECT r.id, r.version, r.status, r.seed, r.algorithm_version, r.input_hash, r.cost, r.diagnostics, r.created_at
       FROM assignment_runs r
       WHERE r.cycle_id = $1 AND r.org_id = $2
       ORDER BY r.version DESC`,
      [cycleId, orgId],
    );
    return rows;
  }

  private async getManageableCycle(orgId: string, cycleId: string, statuses: string[]): Promise<CycleRow> {
    const { rows } = await this.db.query(
      `SELECT id, to_char(month, 'YYYY-MM-DD') AS month, status, ruleset_id
       FROM cycles WHERE id = $1 AND org_id = $2`,
      [cycleId, orgId],
    );
    if (!rows[0]) throw new NotFoundException();
    if (!statuses.includes(rows[0].status)) {
      throw new BadRequestException({ code: 'STATE_CONFLICT', status: rows[0].status });
    }
    return rows[0];
  }

  private async nextRunVersion(client: PoolClient, cycleId: string): Promise<number> {
    const { rows } = await client.query(
      `SELECT coalesce(max(version), 0) + 1 AS next FROM assignment_runs WHERE cycle_id = $1`,
      [cycleId],
    );
    return rows[0].next;
  }

  private summarizeIndegrees(indegrees: Record<string, number>) {
    const dist: Record<number, number> = {};
    for (const d of Object.values(indegrees)) dist[d] = (dist[d] ?? 0) + 1;
    return Object.fromEntries(Object.entries(dist).sort(([a], [b]) => Number(a) - Number(b)));
  }
}
