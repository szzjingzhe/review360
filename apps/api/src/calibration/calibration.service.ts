import { PolicyService } from '../authz/policy.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  checkCalibrationActor,
  lockResultCycle, invalidateTargetBuilds,
  createTriggers,
  isCalibrationAction,
  isRevisionRequested,
  revisionDueAt,
  statusAfterAction,
  thresholdsFrom,
  type CalibrationCaseStatus,
  type ConflictReason,
} from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';

/** 核验列表响应：白名单投影，不含多余字段 */
export interface CalibrationCaseView {
  id: string;
  reasonCode: string;
  status: CalibrationCaseStatus;
  createdAt: Date;
  detail: string | null;
  assigneeId: string | null;
  cycle: { id: string; month: string };
  /** 核验对象（被评价人） */
  target: { id: string; displayName: string };
  /** 原始评分来源；调用方须已持有 calibration.read_raw */
  source: {
    revisionId: string;
    revisionNo: number;
    scoreBp: number | null;
    reviewer: { id: string; displayName: string };
  };
  latestAction: { action: string; reason: string; actorId: string; createdAt: Date } | null;
}

const CONFLICT_CODE: Record<ConflictReason, string> = {
  CASE_FINAL: 'CASE_FINAL',
  SELF_CONFLICT: 'SELF_CONFLICT',
  AUTHOR_CONFLICT: 'AUTHOR_CONFLICT',
  SAME_APPROVER: 'SAME_APPROVER',
  VOID_REQUEST_REQUIRED: 'VOID_REQUEST_REQUIRED',
};

@Injectable()
export class CalibrationService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  // ============================================================
  // 列表（技术文档 §9.3：查询前筛选本人冲突，响应白名单投影）
  // ============================================================

  async listCases(
    actor: AuthContext,
    query: { cycleId?: string; status?: string; page?: number; pageSize?: number },
  ): Promise<{ items: CalibrationCaseView[]; page: number; pageSize: number; total: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));

    const params: unknown[] = [actor.orgId, actor.userId];
    let where = `cc.org_id = $1 AND rv.target_id <> $2`;
    if (query.cycleId) {
      params.push(query.cycleId);
      where += ` AND cc.cycle_id = $${params.length}`;
    }
    if (query.status) {
      if (!['OPEN', 'RESOLVED', 'DISMISSED'].includes(query.status)) {
        throw new BadRequestException({ code: 'FIELD_INVALID', field: 'status' });
      }
      params.push(query.status);
      where += ` AND cc.status = $${params.length}`;
    }

    where += ' AND ' + new PolicyService(this.db).scopedSql(actor,'calibration.read_raw','cc.cycle_id','(SELECT cp.dept_snapshot FROM cycle_participants cp WHERE cp.cycle_id=cc.cycle_id AND cp.user_id=rv.target_id AND cp.org_id=cc.org_id)',params);
    const totalRes = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM calibration_cases cc
         JOIN review_revisions rr ON rr.id = cc.review_revision_id
         JOIN reviews rv ON rv.id = rr.review_id
        WHERE ${where}`,
      params,
    );

    const rows = await this.db.query<{
      id: string; reason_code: string; status: CalibrationCaseStatus; created_at: Date;
      assignee_id: string | null; detail: string | null;
      cycle_id: string; cycle_month: string;
      target_id: string; target_name: string;
      revision_id: string; revision_no: number; score_bp: number | null;
      reviewer_id: string; reviewer_name: string;
      latest: { action: string; reason: string; actorId: string; createdAt: string } | null;
    }>(
      `SELECT cc.id, cc.reason_code, cc.status, cc.created_at, cc.assignee_id,
              (SELECT a.reason FROM calibration_actions a
                WHERE a.case_id = cc.id AND a.action = 'OPEN' ORDER BY a.created_at LIMIT 1) AS detail,
              c.id AS cycle_id, to_char(c.month, 'YYYY-MM') AS cycle_month,
              ut.id AS target_id, ut.display_name AS target_name,
              rr.id AS revision_id, rr.revision_no, rr.score_bp,
              ur.id AS reviewer_id, ur.display_name AS reviewer_name,
              (SELECT json_build_object('action', a.action, 'reason', a.reason,
                                        'actorId', a.actor_id, 'createdAt', a.created_at)
                 FROM calibration_actions a WHERE a.case_id = cc.id
                ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS latest
         FROM calibration_cases cc
         JOIN review_revisions rr ON rr.id = cc.review_revision_id
         JOIN reviews rv ON rv.id = rr.review_id
         JOIN cycles c ON c.id = cc.cycle_id
         JOIN users ut ON ut.id = rv.target_id
         JOIN users ur ON ur.id = rv.reviewer_id
        WHERE ${where}
        ORDER BY cc.created_at DESC, cc.id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        reasonCode: r.reason_code,
        status: r.status,
        createdAt: r.created_at,
        detail: r.detail,
        assigneeId: r.assignee_id,
        cycle: { id: r.cycle_id, month: r.cycle_month },
        target: { id: r.target_id, displayName: r.target_name },
        source: {
          revisionId: r.revision_id,
          revisionNo: r.revision_no,
          scoreBp: r.score_bp,
          reviewer: { id: r.reviewer_id, displayName: r.reviewer_name },
        },
        latestAction: r.latest
          ? {
              action: r.latest.action,
              reason: r.latest.reason,
              actorId: r.latest.actorId,
              createdAt: new Date(r.latest.createdAt),
            }
          : null,
      })),
      page,
      pageSize,
      total: Number(totalRes.rows[0].count),
    };
  }

  // ============================================================
  // 核验动作（PRD §9.1：不提供直接覆盖原始分，更正由原评价人形成修订版）
  // ============================================================

  async actOnCase(
    actor: AuthContext,
    caseId: string,
    body: { action?: string; reason?: string; assigneeId?: string | null },
  ): Promise<{ id: string; status: CalibrationCaseStatus; action: string }> {
    const action = body.action;
    if (typeof action !== 'string' || !isCalibrationAction(action)) {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'action' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'reason' });
    if (reason.length > 1000) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'reason' });

    return withTx(this.db, async (client) => {
      const ref=(await client.query('SELECT cycle_id FROM calibration_cases WHERE id=$1 AND org_id=$2',[caseId,actor.orgId])).rows[0];
      if(!ref)throw new NotFoundException({code:'CASE_NOT_FOUND'});
      await lockResultCycle(client,ref.cycle_id);
      const cur = await client.query<{
        id: string; status: CalibrationCaseStatus; org_id: string; cycle_id: string;
        target_id: string; reviewer_id: string; void_requested_by: string | null;review_id:string;revision_id:string;current_revision_id:string;invalidated_at:Date|null;
      }>(
        `SELECT cc.id, cc.status, cc.org_id, cc.cycle_id, cc.invalidated_at,
                rv.target_id, rv.reviewer_id,rv.id AS review_id,rr.id AS revision_id,rv.current_revision_id,
                (SELECT a.actor_id FROM calibration_actions a
                  WHERE a.case_id = cc.id AND a.action = 'VOID_REQUEST'
                  ORDER BY a.created_at DESC LIMIT 1) AS void_requested_by
           FROM calibration_cases cc
           JOIN review_revisions rr ON rr.id = cc.review_revision_id
           JOIN reviews rv ON rv.id = rr.review_id
          WHERE cc.id = $1 AND cc.org_id = $2
          FOR UPDATE OF cc,rv`,
        [caseId, actor.orgId],
      );
      if (!cur.rowCount) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });
      const row = cur.rows[0];
      if(row.invalidated_at)throw new ConflictException({code:'CASE_INVALIDATED'});
      if(row.current_revision_id!==row.revision_id)throw new ConflictException({code:'CASE_REVISION_STALE'});

      const conflict = checkCalibrationActor(
        {
          actorId: actor.userId,
          targetId: row.target_id,
          reviewerId: row.reviewer_id,
          caseStatus: row.status,
          voidRequestedBy: row.void_requested_by,
        },
        action,
      );
      if (conflict) {
        const code = CONFLICT_CODE[conflict];
        // 终态是并发状态冲突；利益冲突是权限问题
        if (conflict === 'CASE_FINAL' || conflict==='VOID_REQUEST_REQUIRED') throw new ConflictException({ code });
        throw new ForbiddenException({ code });
      }

      await client.query(
        `INSERT INTO calibration_actions (id, case_id, org_id, actor_id, action, reason, previous_status, next_status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
        [caseId, actor.orgId, actor.userId, action, reason, row.status, statusAfterAction(action)],
      );

      if(action==='VOID_APPROVE') {
        await client.query("UPDATE reviews SET status='WITHDRAWN' WHERE id=$1 AND current_revision_id=$2 AND org_id=$3",[row.review_id,row.revision_id,actor.orgId]);
        await invalidateTargetBuilds(client,row.cycle_id,row.target_id);
      }
      const nextStatus = statusAfterAction(action);
      // 要求"原评价人"处理的动作：同时开出一个独立的修订截止时间（PRD §8.1）。
      // 修订通常发生在校准期（周期 close_at 之后），所以不能沿用周期截止时间。
      const revisionDue = isRevisionRequested(action) ? revisionDueAt(new Date()) : null;
      await client.query(
        `UPDATE calibration_cases
            SET status = $2,
                assignee_id = COALESCE($3, assignee_id),
                revision_due_at = COALESCE($4, revision_due_at)
          WHERE id = $1`,
        [caseId, nextStatus, body.assigneeId ?? null, revisionDue],
      );

      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
         VALUES ($1, $2, $3, 'calibration_case', $4, $5)`,
        [actor.orgId, actor.userId, `calibration.${action.toLowerCase()}`, caseId, reason],
      );

      return { id: caseId, status: nextStatus, action };
    });
  }

  // ============================================================
  // 扫描并建立核验项（周期截止时按期扫描；也供运维补偿手动触发）
  // ============================================================

  /**
   * 对周期内全部已提交他评按 PRD §8.3 判定并建立核验项。
   * UNIQUE(review_revision_id, reason_code) 保证重复扫描幂等。
   */
  async scanCycle(actor: AuthContext, cycleId: string): Promise<{ created: number; skipped: number }> {
    return withTx(this.db, async (client) => {
      await lockResultCycle(client,cycleId);
      if((await client.query("SELECT 1 FROM cycles WHERE id=$1 AND org_id=$2 AND status IN ('ARCHIVED','CANCELLED')",[cycleId,actor.orgId])).rowCount)throw new ConflictException({code:'CYCLE_READ_ONLY'});
      const cyc = await client.query<{ id: string; ruleset_checksum: string | null; config: unknown }>(
        `SELECT c.id, r.checksum AS ruleset_checksum, r.config_json AS config
           FROM cycles c JOIN rulesets r ON r.id = c.ruleset_id
          WHERE c.id = $1 AND c.org_id = $2`,
        [cycleId, actor.orgId],
      );
      if (!cyc.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });

      const thresholds = thresholdsFrom(cyc.rows[0].config);
      const result = await createTriggers(client, cycleId, actor.orgId, thresholds);

      if (result.created > 0) {
        await client.query(
          `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
           VALUES ($1, $2, 'calibration.scan', 'cycle', $3, $4)`,
          [actor.orgId, actor.userId, cycleId, `建立核验项 ${result.created} 条`],
        );
      }
      return result;
    });
  }
}

async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
