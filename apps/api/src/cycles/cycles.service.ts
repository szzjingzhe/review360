import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { lockResultCycle } from '@360/domain';

export interface CycleScheduleInput {
  open_at: string;
  /** 自评阶段结束时间：此时间前仅本人可自评+上传材料，之后才开放他评 */
  self_close_at?: string | null;
  close_at: string;
  calibration_at?: string;
  publish_at: string;
}

/** 解析 ISO 时间串，失败抛 400 */
function parseTime(field: string, value: unknown): Date {
  if (typeof value !== 'string' || value === '') {
    throw new BadRequestException({ code: 'FIELD_INVALID', field });
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({ code: 'FIELD_INVALID', field });
  }
  return d;
}

function parseMonth(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new BadRequestException({ code: 'FIELD_INVALID', field: 'month' });
  }
  return `${value}-01`;
}

/**
 * 「进行中」状态集合：同一组织同一时刻只允许一期处于这些状态（001/036 的口径）。
 * DRAFT 不占用互斥，允许提前准备多期草稿；PUBLISHED / ARCHIVED / CANCELLED 为已完成，不占用。
 * 数据库层由部分唯一索引 uq_cycle_single_active 强保证，服务层只负责给出可读报错。
 */
export const ACTIVE_CYCLE_STATUSES = ['PENDING_OPEN', 'REVIEWING', 'PAUSED', 'CALIBRATING', 'PARTIALLY_PUBLISHED'] as const;

/** '2026-11-01' / '2026-11' → '2026-11' */
function monthKey(month: string): string {
  return String(month).slice(0, 7);
}

/**
 * 周期服务（技术文档 5.2 / §6 状态机）：
 * DRAFT → PENDING_OPEN → REVIEWING → CALIBRATING → PARTIALLY_PUBLISHED → PUBLISHED → ARCHIVED
 * 任何非终态可 → CANCELLED。本模块负责 DRAFT/PENDING_OPEN 段；开期预检与锁定见 M2.4。
 */
@Injectable()
export class CyclesService {
  constructor(@Inject('DATABASE_POOL') private readonly db: Pool) {}

  /** 创建周期（DRAFT）：校验规则集已冻结、时间合法，生成参与者快照 */
  async createCycle(
    actor: { userId: string; orgId: string },
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const month = parseMonth(body.month);
    const rulesetId = typeof body.ruleset_id === 'string' ? body.ruleset_id : '';
    if (!rulesetId) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'ruleset_id' });
    // 同月可有多期：未填标题时按该月已有期数顺延，避免列表出现多个同名周期
    let title: string;
    if (typeof body.title === 'string' && body.title.trim() !== '') {
      title = body.title.trim().slice(0, 100);
    } else {
      const { rows: seqRows } = await this.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM cycles WHERE org_id = $1 AND month = $2`,
        [actor.orgId, month],
      );
      const seq = (seqRows[0]?.n ?? 0) + 1;
      title = `${monthKey(month)} 月度环评${seq > 1 ? `（第${seq}期）` : ''}`;
    }

    const open = parseTime('open_at', body.open_at);
    const close = parseTime('close_at', body.close_at);
    const publish = parseTime('publish_at', body.publish_at);
    // 自评截止：可空。为空时退回单窗口旧行为
    const selfClose =
      body.self_close_at === undefined || body.self_close_at === null || body.self_close_at === ''
        ? null
        : parseTime('self_close_at', body.self_close_at);
    const calibration =
      body.calibration_at === undefined || body.calibration_at === null
        ? null
        : parseTime('calibration_at', body.calibration_at);

    // 时间顺序（技术文档 5.2：开启 < 自评截止 <= 截止 <= 发布；校准不早于截止）
    if (open >= close) throw new BadRequestException({ code: 'SCHEDULE_INVALID', detail: 'open_at must be before close_at' });
    if (selfClose && (open >= selfClose || selfClose > close)) {
      throw new BadRequestException({ code: 'SCHEDULE_INVALID', detail: 'open_at < self_close_at <= close_at required' });
    }
    if (close > publish) throw new BadRequestException({ code: 'SCHEDULE_INVALID', detail: 'close_at must not be after publish_at' });
    if (calibration && calibration < close) {
      throw new BadRequestException({ code: 'SCHEDULE_INVALID', detail: 'calibration_at must not be before close_at' });
    }

    // 规则集必须属于本组织且已冻结（冻结前配置不可用于开期）
    const { rows: rsRows } = await this.db.query(
      `SELECT id FROM rulesets WHERE id = $1 AND org_id = $2 AND status = 'FROZEN'`,
      [rulesetId, actor.orgId],
    );
    if (!rsRows[0]) throw new BadRequestException({ code: 'RULESET_NOT_FROZEN' });

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // 同月唯一：重复创建直接报冲突
      const { rows } = await client.query(
        `INSERT INTO cycles (id, org_id, month, title, status, open_at, self_close_at, close_at, calibration_at, publish_at, ruleset_id, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, to_char(month, 'YYYY-MM-DD') AS month, title, status, open_at, self_close_at, close_at, calibration_at, publish_at, ruleset_id, row_version`,
        [actor.orgId, month, title, open, selfClose, close, calibration, publish, rulesetId, actor.userId],
      );
      const cycle = rows[0];

      await client.query(
        `INSERT INTO cycle_state_log (cycle_id, from_status, to_status, actor_id, reason)
         VALUES ($1, '', 'DRAFT', $2, '创建周期')`,
        [cycle.id, actor.userId],
      );
      // worker 调度阶段计划（M2.5 扫描 planned_at）
      await client.query(
        `INSERT INTO cycle_phases (cycle_id, phase, planned_at, created_by) VALUES
         ($1, 'OPEN', $2, $3), ($1, 'CLOSE', $4, $3), ($1, 'PUBLISH', $5, $3)`,
        [cycle.id, open, actor.userId, close, publish],
      );
      await this.snapshotParticipants(client, actor.orgId, cycle.id, rulesetId);
      await client.query('COMMIT');
      return cycle;
    } catch (err) {
      await client.query('ROLLBACK');
      // 同月不再唯一（036），插入 DRAFT 不会撞月份；若仍冲突说明并发下撞了活跃唯一索引
      if ((err as { code?: string }).code === '23505') {
        throw new BadRequestException({ code: 'CYCLE_CREATE_CONFLICT' });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** 从当前组织数据重建参与者快照（仅 DRAFT；开期后快照锁定，见 M2.4） */
  private async snapshotParticipants(
    client: PoolClient,
    orgId: string,
    cycleId: string,
    rulesetId: string,
  ): Promise<void> {
    await client.query(`DELETE FROM cycle_participants WHERE cycle_id = $1`, [cycleId]);

    // HRBP 专项角色已取消：所有部门人员仅按 HEAD / MEMBER 选择模板。
    await client.query(
      `INSERT INTO cycle_participants
         (cycle_id, org_id, user_id, dept_snapshot, role_snapshot, station_snapshot, template_id)
       SELECT $1, $2, m.user_id, m.department_id,
         CASE WHEN h.user_id IS NOT NULL THEN 'HEAD' ELSE 'MEMBER' END,
         NULL,
         CASE
           WHEN h.user_id IS NOT NULL THEN (SELECT t.id FROM template_versions t WHERE t.ruleset_id = $3 AND t.role_code = 'HEAD')
           ELSE (SELECT t.id FROM template_versions t WHERE t.ruleset_id = $3 AND t.role_code = 'MEMBER')
         END
       FROM department_memberships m
       JOIN departments gd ON gd.id=m.department_id AND gd.org_id=m.org_id AND gd.code NOT IN ('GUIDE','GUIDANCE')
       JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
       LEFT JOIN (
         SELECT user_id, scope_dept_id FROM appointments
         WHERE org_id = $2 AND role = 'HEAD' AND valid_from<=CURRENT_DATE AND (valid_to IS NULL OR valid_to>CURRENT_DATE)
       ) h ON h.user_id = m.user_id AND h.scope_dept_id=m.department_id
       WHERE m.org_id = $2 AND m.valid_from<=CURRENT_DATE AND (m.valid_to IS NULL OR m.valid_to>CURRENT_DATE)`,
      [cycleId, orgId, rulesetId],
    );

    // 监管独立复核人不参与被评价（技术文档 §7），不写入参与者快照
  }

  async listCycles(orgId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      `SELECT c.id, to_char(c.month, 'YYYY-MM-DD') AS month, c.title, c.status, c.open_at, c.self_close_at, c.close_at, c.calibration_at, c.publish_at,
              c.ruleset_id, c.row_version, c.created_at,
              (SELECT count(*)::int FROM cycle_participants p WHERE p.cycle_id = c.id AND p.eligibility='ELIGIBLE') AS participant_count,
              (l.locked_at IS NOT NULL) AS locked
       FROM cycles c
       LEFT JOIN cycle_locks l ON l.cycle_id = c.id
       WHERE c.org_id = $1
       ORDER BY c.month DESC, c.created_at DESC`,
      [orgId],
    );
    return rows;
  }

  async updateCycle(actor:{userId:string;orgId:string},cycleId:string,body:Record<string,unknown>){
    const c=await this.db.connect();try{await c.query('BEGIN');await lockResultCycle(c,cycleId);
      const old=(await c.query('SELECT * FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE',[cycleId,actor.orgId])).rows[0];
      if(!old)throw new NotFoundException();if(old.status!=='DRAFT')throw new BadRequestException({code:'NOT_DRAFT'});
      if(body.row_version!==undefined&&body.row_version!==old.row_version)throw new BadRequestException({code:'STATE_CONFLICT'});
      const month=body.month===undefined?old.month:parseMonth(body.month);
      const title=body.title===undefined?old.title:typeof body.title==='string'&&body.title.trim()?body.title.trim().slice(0,100):null;
      if(!title)throw new BadRequestException({code:'FIELD_INVALID',field:'title'});
      const open=body.open_at===undefined?old.open_at:parseTime('open_at',body.open_at),close=body.close_at===undefined?old.close_at:parseTime('close_at',body.close_at),publish=body.publish_at===undefined?old.publish_at:parseTime('publish_at',body.publish_at);
      const calibration=body.calibration_at===undefined?old.calibration_at:body.calibration_at===null?null:parseTime('calibration_at',body.calibration_at);
      const selfClose=body.self_close_at===undefined?old.self_close_at:body.self_close_at===null||body.self_close_at===''?null:parseTime('self_close_at',body.self_close_at);
      if(!open||!close||!publish||open>=close||close>publish||calibration&&calibration<close)throw new BadRequestException({code:'SCHEDULE_INVALID'});
      if(selfClose&&(open>=selfClose||selfClose>close))throw new BadRequestException({code:'SCHEDULE_INVALID',detail:'open_at < self_close_at <= close_at required'});
      const row=(await c.query("UPDATE cycles SET month=$3,title=$4,open_at=$5,close_at=$6,publish_at=$7,calibration_at=$8,self_close_at=$9,row_version=row_version+1 WHERE id=$1 AND org_id=$2 RETURNING id,to_char(month,'YYYY-MM-DD') AS month,title,status,open_at,self_close_at,close_at,publish_at,calibration_at,ruleset_id,row_version",[cycleId,actor.orgId,month,title,open,close,publish,calibration,selfClose])).rows[0];
      await c.query("UPDATE cycle_phases SET planned_at=CASE phase WHEN 'OPEN' THEN $2 WHEN 'CLOSE' THEN $3 WHEN 'PUBLISH' THEN $4 ELSE planned_at END WHERE cycle_id=$1 AND actual_at IS NULL",[cycleId,open,close,publish]);
      await c.query("UPDATE assignment_runs SET status='SUPERSEDED' WHERE cycle_id=$1 AND status IN('FEASIBLE','INFEASIBLE')",[cycleId]);
      await c.query('DELETE FROM cycle_open_confirmations WHERE cycle_id=$1',[cycleId]);
      await c.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id) VALUES($1,$2,'cycle.update','cycle',$3)",[actor.orgId,actor.userId,cycleId]);
      await c.query('COMMIT');return row;
    }catch(error){await c.query('ROLLBACK');if((error as {code?:string}).code==='23505')throw new BadRequestException({code:'CYCLE_CREATE_CONFLICT'});throw error;}finally{c.release();}
  }

  /**
   * 删除周期：
   * - DRAFT：要求无正式业务数据（保持原有收敛口径）；
   * - CANCELLED：允许连同业务数据一并清理，让管理员可以重新发起同月周期。
   */
  async deleteCycle(actor:{userId:string;orgId:string},cycleId:string){
    const c=await this.db.connect();try{await c.query('BEGIN');await lockResultCycle(c,cycleId);
      const cycle=(await c.query('SELECT status FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE',[cycleId,actor.orgId])).rows[0];
      if(!cycle)throw new NotFoundException();
      if(cycle.status==='DRAFT'){
        const business=(await c.query('SELECT EXISTS(SELECT 1 FROM reviews WHERE cycle_id=$1 UNION ALL SELECT 1 FROM monthly_reports WHERE cycle_id=$1 UNION ALL SELECT 1 FROM assignments WHERE cycle_id=$1 UNION ALL SELECT 1 FROM result_builds WHERE cycle_id=$1 UNION ALL SELECT 1 FROM cycle_locks WHERE cycle_id=$1) AS present',[cycleId])).rows[0];
        if(business.present)throw new BadRequestException({code:'DRAFT_HAS_BUSINESS_DATA'});
        await this.purgeCycleData(c,cycleId,actor.orgId,{});
        await c.query('DELETE FROM cycles WHERE id=$1 AND org_id=$2',[cycleId,actor.orgId]);
        await c.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id) VALUES($1,$2,'cycle.delete_draft','cycle',$3)",[actor.orgId,actor.userId,cycleId]);
      }else if(cycle.status==='CANCELLED'){
        await this.purgeCycleData(c,cycleId,actor.orgId,{});
        await c.query('DELETE FROM cycles WHERE id=$1 AND org_id=$2',[cycleId,actor.orgId]);
        await c.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'cycle.delete_cancelled','cycle',$3,'清理已撤销周期，释放同名月份')",[actor.orgId,actor.userId,cycleId]);
      }else{
        throw new BadRequestException({code:'NOT_DRAFT'});
      }
      await c.query('COMMIT');return {id:cycleId,deleted:true};
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }

  /**
   * 已撤销周期「重启为草稿」：清空评价与材料等业务数据，保留参评快照和阶段记录，
   * 让管理员不必重建月份即可重新配置并发起。
   */
  async restoreCycle(actor:{userId:string;orgId:string},cycleId:string,reason:unknown){
    const why=typeof reason==='string'&&reason.trim()?reason.trim().slice(0,500):'管理员重启已撤销周期';
    const c=await this.db.connect();try{await c.query('BEGIN');await lockResultCycle(c,cycleId);
      const cycle=(await c.query('SELECT status FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE',[cycleId,actor.orgId])).rows[0];
      if(!cycle)throw new NotFoundException();
      if(cycle.status!=='CANCELLED')throw new BadRequestException({code:'NOT_CANCELLED'});
      await this.purgeCycleData(c,cycleId,actor.orgId,{keepParticipants:true,keepPhases:true,keepHistory:true,keepAnnouncement:true});
      await c.query("UPDATE cycles SET status='DRAFT',row_version=row_version+1,updated_at=now() WHERE id=$1 AND org_id=$2",[cycleId,actor.orgId]);
      await c.query("INSERT INTO cycle_state_log(cycle_id,from_status,to_status,actor_id,reason) VALUES($1,'CANCELLED','DRAFT',$2,$3)",[cycleId,actor.userId,why]);
      await c.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'cycle.restore','cycle',$3,$4)",[actor.orgId,actor.userId,cycleId,why]);
      await c.query('COMMIT');return {id:cycleId,status:'DRAFT'};
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }

  /** 按外键依赖自下而上清理周期业务数据；保留项由 options 控制。 */
  private async purgeCycleData(c:PoolClient,cycleId:string,orgId:string,options:{keepParticipants?:boolean;keepPhases?:boolean;keepHistory?:boolean;keepAnnouncement?:boolean}){
    const q=(sql:string,params:unknown[])=>c.query(sql,params);
    const run=(sql:string)=>c.query(sql,[cycleId]);
    // 先解开所有互相引用的悬挂指针，否则后面的 DELETE 会被外键挡住
    await run('UPDATE reviews SET current_revision_id=NULL WHERE cycle_id=$1');
    await run('UPDATE assignments SET replaces_id=NULL WHERE cycle_id=$1');
    await run('UPDATE published_results SET supersedes_id=NULL WHERE cycle_id=$1');
    await run('UPDATE monthly_reports SET active_version_id=NULL WHERE cycle_id=$1');
    // 第一层：结果链路（依赖 published_results / result_builds / review_revisions）
    await run('DELETE FROM growth_analyses WHERE publication_id IN (SELECT id FROM published_results WHERE cycle_id=$1)');
    await run('DELETE FROM feedback_requests WHERE publication_id IN (SELECT id FROM published_results WHERE cycle_id=$1)');
    await run('DELETE FROM result_source_reviews WHERE result_build_id IN (SELECT id FROM result_builds WHERE cycle_id=$1)');
    await run('DELETE FROM result_feedback WHERE result_build_id IN (SELECT id FROM result_builds WHERE cycle_id=$1)');
    await run('DELETE FROM result_approvals WHERE result_build_id IN (SELECT id FROM result_builds WHERE cycle_id=$1)');
    await run('DELETE FROM result_monthly_reports WHERE cycle_id=$1');
    await run('DELETE FROM published_results WHERE cycle_id=$1');
    await run('DELETE FROM result_builds WHERE cycle_id=$1');
    // 第二层：核验链路（calibration_actions → calibration_cases → review_revisions）
    await run('DELETE FROM calibration_actions WHERE case_id IN (SELECT id FROM calibration_cases WHERE cycle_id=$1)');
    await run('DELETE FROM calibration_cases WHERE cycle_id=$1');
    // 第三层：评审链路（review_item_scores / snapshots → review_revisions → reviews）
    await run('DELETE FROM review_item_scores WHERE revision_id IN (SELECT rv.id FROM review_revisions rv JOIN reviews r ON r.id=rv.review_id WHERE r.cycle_id=$1)');
    await run('DELETE FROM review_material_snapshots WHERE revision_id IN (SELECT rv.id FROM review_revisions rv JOIN reviews r ON r.id=rv.review_id WHERE r.cycle_id=$1)');
    await run('DELETE FROM review_material_snapshots WHERE report_id IN (SELECT id FROM monthly_reports WHERE cycle_id=$1)');
    await run('DELETE FROM review_revisions WHERE review_id IN (SELECT id FROM reviews WHERE cycle_id=$1)');
    await run('DELETE FROM review_drafts WHERE cycle_id=$1');
    // 第四层：材料链路（versions → materials → report_versions → reports）
    await run('DELETE FROM upload_sessions WHERE report_id IN (SELECT id FROM monthly_reports WHERE cycle_id=$1)');
    await run('DELETE FROM monthly_material_versions WHERE material_id IN (SELECT m.id FROM monthly_materials m JOIN monthly_reports r ON r.id=m.report_id WHERE r.cycle_id=$1)');
    await run('DELETE FROM monthly_materials WHERE report_id IN (SELECT id FROM monthly_reports WHERE cycle_id=$1)');
    await run('DELETE FROM report_versions WHERE report_id IN (SELECT id FROM monthly_reports WHERE cycle_id=$1)');
    await run('DELETE FROM monthly_reports WHERE cycle_id=$1');
    // 第五层：评审与分配主体
    await run('DELETE FROM reviews WHERE cycle_id=$1');
    await run('DELETE FROM assignments WHERE cycle_id=$1');
    // 第六层：分配运行（confirmations / locks → runs → manual_edges → participants）
    await run('DELETE FROM cycle_open_confirmations WHERE cycle_id=$1');
    await run('DELETE FROM cycle_locks WHERE cycle_id=$1');
    await q('DELETE FROM assignment_manual_edges WHERE cycle_id=$1 AND org_id=$2',[cycleId,orgId]);
    await q('DELETE FROM assignment_runs WHERE cycle_id=$1 AND org_id=$2',[cycleId,orgId]);
    // 第七层：其余直接挂在周期上的表
    await run('DELETE FROM reviewer_cycle_stats WHERE cycle_id=$1');
    await run('DELETE FROM reviewer_statements WHERE cycle_id=$1');
    await run('DELETE FROM award_decisions WHERE cycle_id=$1');
    await run('DELETE FROM material_submission_batches WHERE cycle_id=$1');
    await run('DELETE FROM scheduled_jobs WHERE cycle_id=$1');
    if(!options.keepAnnouncement)await run('DELETE FROM announcements WHERE cycle_id=$1');
    if(!options.keepPhases)await run('DELETE FROM cycle_phases WHERE cycle_id=$1');
    if(!options.keepHistory)await run('DELETE FROM cycle_state_log WHERE cycle_id=$1');
    if(!options.keepParticipants)await q('DELETE FROM cycle_participants WHERE cycle_id=$1 AND org_id=$2',[cycleId,orgId]);
  }

  async getCycle(orgId: string, cycleId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query(
      `SELECT c.id, to_char(c.month, 'YYYY-MM-DD') AS month, c.title, c.status, c.open_at, c.self_close_at, c.close_at, c.calibration_at, c.publish_at,
              c.ruleset_id, c.row_version, c.created_at, c.updated_at,
              l.locked_at, l.locked_by, l.assignment_run_id
       FROM cycles c
       LEFT JOIN cycle_locks l ON l.cycle_id = c.id
       WHERE c.id = $1 AND c.org_id = $2`,
      [cycleId, orgId],
    );
    if (!rows[0]) throw new NotFoundException();

    const { rows: participantRows } = await this.db.query(
      `SELECT p.user_id, u.display_name, d.code AS dept_code, p.role_snapshot, p.station_snapshot,
              p.eligibility, p.exclusion_reason
       FROM cycle_participants p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN departments d ON d.id = p.dept_snapshot
       WHERE p.cycle_id = $1
       ORDER BY d.sort_order NULLS LAST, u.display_name`,
      [cycleId],
    );

    const { rows: stateLog } = await this.db.query(
      `SELECT from_status, to_status, reason, created_at FROM cycle_state_log
       WHERE cycle_id = $1 ORDER BY created_at`,
      [cycleId],
    );

    return { ...rows[0], participants: participantRows, state_log: stateLog };
  }

  /** DRAFT 状态下重建参与者快照（人员/任命变动后） */
  async refreshParticipants(actor: {userId:string;orgId:string},cycleId:string) {
    const client=await this.db.connect();try{await client.query('BEGIN');await lockResultCycle(client,cycleId);
      const cycle=(await client.query('SELECT status,ruleset_id FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE',[cycleId,actor.orgId])).rows[0];
      if(!cycle)throw new NotFoundException();if(cycle.status!=='DRAFT')throw new BadRequestException({code:'NOT_DRAFT'});
      await this.snapshotParticipants(client,actor.orgId,cycleId,cycle.ruleset_id);
      await client.query("UPDATE assignment_runs SET status='SUPERSEDED' WHERE cycle_id=$1 AND status IN('FEASIBLE','INFEASIBLE')",[cycleId]);
      await client.query('DELETE FROM cycle_open_confirmations WHERE cycle_id=$1',[cycleId]);
      const count=(await client.query('SELECT count(*)::int AS count FROM cycle_participants WHERE cycle_id=$1',[cycleId])).rows[0].count;
      await client.query('COMMIT');return {cycle_id:cycleId,participant_count:count};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async submitCycle(actor:{userId:string;orgId:string},cycleId:string) {
    return this.transition(actor,cycleId,['DRAFT'],'PENDING_OPEN','提交开期');
  }
  async cancelCycle(actor:{userId:string;orgId:string},cycleId:string,reason:unknown) {
    if(typeof reason!=='string'||!reason.trim()||reason.trim().length>500)throw new BadRequestException({code:'CANCELLATION_REASON_REQUIRED'});
    return this.transition(actor,cycleId,['DRAFT','PENDING_OPEN','REVIEWING','PAUSED','CALIBRATING'],'CANCELLED',reason.trim());
  }
  async pauseCycle(actor:{userId:string;orgId:string},cycleId:string,reason:unknown) {
    if(typeof reason!=='string'||!reason.trim()||reason.trim().length>500)throw new BadRequestException({code:'REASON_REQUIRED'});
    return this.transition(actor,cycleId,['REVIEWING'],'PAUSED',reason.trim());
  }
  async resumeCycle(actor:{userId:string;orgId:string},cycleId:string,reason:unknown) {
    if(typeof reason!=='string'||!reason.trim()||reason.trim().length>500)throw new BadRequestException({code:'REASON_REQUIRED'});
    return this.transition(actor,cycleId,['PAUSED'],'REVIEWING',reason.trim());
  }
  async archiveCycle(actor:{userId:string;orgId:string},cycleId:string) {
    return this.transition(actor,cycleId,['PUBLISHED'],'ARCHIVED','管理员明确归档');
  }
  async archivePreflight(actor:{userId:string;orgId:string}, cycleId:string) {
    const client=await this.db.connect();
    try { return await this.checkArchive(client,actor,cycleId); } finally { client.release(); }
  }
  private async checkArchive(client:PoolClient,actor:{orgId:string},cycleId:string) {
    const {rows}=await client.query(`SELECT c.status, c.close_at <= now() AS ended,
      (SELECT count(*)::int FROM cycle_participants p WHERE p.cycle_id=c.id AND p.org_id=c.org_id AND p.eligibility='ELIGIBLE') AS participants,
      (SELECT count(DISTINCT pr.target_id)::int FROM published_results pr JOIN cycle_participants p ON p.cycle_id=pr.cycle_id AND p.org_id=pr.org_id AND p.user_id=pr.target_id AND p.eligibility='ELIGIBLE' WHERE pr.cycle_id=c.id AND pr.org_id=c.org_id) AS published,
      (SELECT count(*)::int FROM calibration_cases cc WHERE cc.cycle_id=c.id AND cc.org_id=c.org_id AND cc.status='OPEN' AND cc.invalidated_at IS NULL) AS exceptions,
      (SELECT count(*)::int FROM feedback_requests f JOIN published_results pr ON pr.id=f.publication_id WHERE pr.cycle_id=c.id AND f.org_id=c.org_id AND f.status IN ('PENDING','APPROVED','REREVIEW_PENDING')) AS appeals,
      (SELECT count(*)::int FROM result_builds b WHERE b.cycle_id=c.id AND b.org_id=c.org_id AND b.status IN ('BUILT','APPROVED','STALE') AND NOT EXISTS (SELECT 1 FROM result_builds newer WHERE newer.cycle_id=b.cycle_id AND newer.org_id=b.org_id AND newer.target_id=b.target_id AND newer.created_at>b.created_at)) AS corrections,
      (SELECT count(*)::int FROM growth_analyses g JOIN published_results pr ON pr.id=g.publication_id WHERE pr.cycle_id=c.id AND g.org_id=c.org_id AND g.status IN ('DRAFT','GENERATING')) AS growth_pending
      FROM cycles c WHERE c.id=$1 AND c.org_id=$2`,[cycleId,actor.orgId]);
    const r=rows[0]; if(!r) throw new NotFoundException();
    const checks=[
      {key:'cycle',ok:r.status==='PUBLISHED'&&r.ended,message:r.status==='CANCELLED'?'已撤销周期不能作为正常月评归档。':r.status==='ARCHIVED'?'该周期已归档。':r.status!=='PUBLISHED'?'周期须结束且全部正式发布后才能归档。':!r.ended?'评价截止时间尚未到达。':'周期已结束并正式发布。',path:''},
      {key:'publication',ok:r.participants>0&&r.published===r.participants,message:`有效参评 ${r.participants} 人，已正式发布 ${r.published} 人。`,path:'/management/monthly/results'},
      {key:'exceptions',ok:r.exceptions===0,message:r.exceptions?`有 ${r.exceptions} 条异常待核验。`:'没有待核验异常。',path:'/management/monthly/exceptions'},
      {key:'appeals',ok:r.appeals===0,message:r.appeals?`有 ${r.appeals} 条申诉尚未办结。`:'没有未办结申诉。',path:'/management/feedback'},
      {key:'corrections',ok:r.corrections===0,message:r.corrections?`有 ${r.corrections} 项结果构建或更正尚未发布，请检查。`:'没有待处理的结果构建或更正。',path:'/management/monthly/results'},
      {key:'growth',ok:r.growth_pending===0,message:r.growth_pending?`有 ${r.growth_pending} 份成长报告正在生成或等待确认。`:'成长报告没有待确认草稿；未确认内容不会展示。',path:'/management/monthly/growth'},
      {key:'history',ok:true,message:'归档保留材料、评价记录、发布版本及操作记录。',path:''},
    ];
    return {eligible:checks.every(c=>c.ok),checks};
  }
  private async transition(actor:{userId:string;orgId:string},id:string,allowed:string[],next:string,reason:string) {
    const client=await this.db.connect();try{await client.query('BEGIN');await lockResultCycle(client,id);
      const row=(await client.query('SELECT status FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,actor.orgId])).rows[0];
      if(!row)throw new NotFoundException();if(!allowed.includes(row.status))throw new BadRequestException({code:'CYCLE_STATUS_INVALID',status:row.status});
      // 同时只允许一期进行中：进入活跃态前先看本组织有没有别的周期正在跑（036）
      if((ACTIVE_CYCLE_STATUSES as readonly string[]).includes(next)){
        const busy=(await client.query(
          `SELECT id,title,to_char(month,'YYYY-MM') AS month,status FROM cycles
            WHERE org_id=$1 AND id<>$2 AND status = ANY($3::text[]) LIMIT 1`,
          [actor.orgId,id,[...ACTIVE_CYCLE_STATUSES]],
        )).rows[0];
        if(busy)throw new BadRequestException({code:'CYCLE_ACTIVE_EXISTS',active:{id:busy.id,title:busy.title,month:busy.month,status:busy.status}});
      }
      if(next==='ARCHIVED'){const preflight=await this.checkArchive(client,actor,id);if(!preflight.eligible)throw new BadRequestException({code:'ARCHIVE_PRECHECK_FAILED',checks:preflight.checks});}
      if(next==='CANCELLED'&&(await client.query('SELECT 1 FROM published_results WHERE cycle_id=$1 AND org_id=$2 LIMIT 1',[id,actor.orgId])).rowCount)
        throw new BadRequestException({code:'PUBLISHED_CANNOT_CANCEL'});
      const result=(await client.query('UPDATE cycles SET status=$3,row_version=row_version+1 WHERE id=$1 AND org_id=$2 RETURNING id,status',[id,actor.orgId,next])).rows[0];
      await client.query('INSERT INTO cycle_state_log(cycle_id,from_status,to_status,actor_id,reason) VALUES($1,$2,$3,$4,$5)',[id,row.status,next,actor.userId,reason]);
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,$3,'cycle',$4,$5)",[actor.orgId,actor.userId,'cycle.'+next.toLowerCase(),id,reason]);
      await client.query('COMMIT');return result;
    }catch(e){await client.query('ROLLBACK');if((e as {code?:string}).code==='23505')throw new BadRequestException({code:'CYCLE_ACTIVE_EXISTS'});throw e;}finally{client.release();}
  }

  private async getDraftCycle(orgId: string, cycleId: string) {
    const { rows } = await this.db.query(
      `SELECT id, status, ruleset_id FROM cycles WHERE id = $1 AND org_id = $2`,
      [cycleId, orgId],
    );
    if (!rows[0]) throw new NotFoundException();
    if (rows[0].status !== 'DRAFT') {
      throw new BadRequestException({ code: 'NOT_DRAFT', status: rows[0].status });
    }
    return rows[0];
  }
}
