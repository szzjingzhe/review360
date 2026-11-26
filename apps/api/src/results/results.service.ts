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
  buildOne,
  lockResultCycle, scanResultCycle, RESULT_FORMULA_VERSION,
  completenessCheck,
  effectiveReviewSql,
  currentInputHash,
  type BuildOutcome,
} from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';

/**
 * 结果构建与审批（技术文档 §10）。
 *
 * - 构建输入：有效 revision 列表、报告锁定版本、ruleset 校验和、
 *   assignment_version 及反馈版本 → input_hash；同输入复用已有 build。
 * - 完整性（PRD §9.2）：任务齐全、自评完成、应处理核验项关闭后才可构建。
 * - 审批绑定精确 build：发布事务重验 input_hash，输入改变返回 RESULT_STALE。
 * SQL 编排在 @360/domain 的 results/ops.ts（与 worker 共用）。
 */

@Injectable()
export class ResultsService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  // ============================================================
  // 构建：单目标或全周期
  // ============================================================

  async buildResults(
    actor: AuthContext,
    cycleId: string,
    body: { targetId?: string } | undefined,
  ): Promise<{ items: BuildOutcome[]; incomplete: Array<{ targetId: string; reasons: string[] }> }> {
    return withTx(this.db, async (client) => {
      const cyc = await lockCycleInOrg(client, actor.orgId, cycleId);
      if (!['CALIBRATING','REVIEWING','PARTIALLY_PUBLISHED','PUBLISHED'].includes(cyc.status)) {
        throw new ConflictException({ code: 'CYCLE_STATUS_INVALID', status: cyc.status });
      }

      await scanResultCycle(client,cycleId,actor.orgId);
      const targets=(await client.query<{target_id:string}>(`SELECT user_id AS target_id FROM cycle_participants
        WHERE cycle_id=$1 AND org_id=$2 AND eligibility='ELIGIBLE' AND ($3::uuid IS NULL OR user_id=$3)
        ORDER BY user_id`,[cycleId,actor.orgId,body?.targetId??null])).rows;
      if(body?.targetId && !targets.length)throw new NotFoundException({code:'TARGET_NOT_IN_CYCLE'});

      const items: BuildOutcome[] = [];
      const incomplete: Array<{ targetId: string; reasons: string[] }> = [];
      for (const t of targets) {
        const check = await completenessCheck(client, cycleId, t.target_id);
        if (check.length > 0) {
          incomplete.push({ targetId: t.target_id, reasons: check });
          continue;
        }
        items.push(await buildOne(client, cycleId, actor.orgId, t.target_id));
      }
      if (items.length === 0 && incomplete.length > 0) {
        throw new BadRequestException({ code: 'RESULT_INCOMPLETE', detail: incomplete });
      }
      if (items.length > 0) {
        await client.query(
          `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
           VALUES ($1, $2, 'result.build', 'cycle', $3, $4)`,
          [actor.orgId, actor.userId, cycleId, `构建结果 ${items.length} 份`],
        );
      }
      return { items, incomplete };
    });
  }

  // ============================================================
  // 审批（result.confirm；本人排除；输入未变）
  // ============================================================

  async approveBuild(
    actor: AuthContext,
    buildId: string,
    body: { decision?: string; reason?: string },
  ): Promise<{ id: string; status: string; decision: string }> {
    const decision = body.decision;
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'decision' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (decision === 'REJECTED' && !reason) {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'reason' });
    }

    const outcome=await withTx(this.db, async (client) => {
      const ref=(await client.query('SELECT cycle_id FROM result_builds WHERE id=$1 AND org_id=$2',[buildId,actor.orgId])).rows[0];
      if(!ref)throw new NotFoundException({code:'BUILD_NOT_FOUND'});
      await lockResultCycle(client,ref.cycle_id);
      const b = await client.query<{
        id: string; cycle_id: string; org_id: string; target_id: string;
        input_hash: string; formula_version: string; status: string;
      }>(
        `SELECT id, cycle_id, org_id, target_id, input_hash, formula_version, status
           FROM result_builds WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [buildId, actor.orgId],
      );
      if (!b.rowCount) throw new NotFoundException({ code: 'BUILD_NOT_FOUND' });
      const build = b.rows[0];

      // 本人排除（PRD §9.1：本人不得确认自己的结果）
      if (build.target_id === actor.userId) {
        throw new ForbiddenException({ code: 'SELF_AUDIT_FORBIDDEN' });
      }
      if (build.status === 'PUBLISHED') {
        throw new ConflictException({ code: 'BUILD_PUBLISHED' });
      }

      await scanResultCycle(client,build.cycle_id,actor.orgId);
      const reasons=await completenessCheck(client,build.cycle_id,build.target_id);
      const cur=await currentInputHash(client,build.cycle_id,build.target_id,build.formula_version);
      if(build.status==='STALE'||build.formula_version!==RESULT_FORMULA_VERSION||reasons.length||cur===null||cur!==build.input_hash){
        await client.query("UPDATE result_builds SET status='STALE' WHERE id=$1 AND status<>'PUBLISHED'",[buildId]);
        return null;
      }

      await client.query(
        `INSERT INTO result_approvals (id, result_build_id, org_id, approver_id, decision, reason)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [buildId, actor.orgId, actor.userId, decision, reason || null],
      );
      const nextStatus = decision === 'APPROVED' ? 'APPROVED' : 'BUILT';
      await client.query(`UPDATE result_builds SET status = $2 WHERE id = $1`, [buildId, nextStatus]);

      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
         VALUES ($1, $2, $3, 'result_build', $4, $5)`,
        [actor.orgId, actor.userId, `result.${decision.toLowerCase()}`, buildId, reason || null],
      );
      return { id: buildId, status: nextStatus, decision };
    });
    if(!outcome)throw new ConflictException({code:'RESULT_STALE'});
    return outcome;
  }

  // ============================================================
  // 查询：build 列表（审批台用）
  // ============================================================

  async listBuilds(
    actor: AuthContext,
    cycleId: string,
    query: { status?: string; targetId?: string },
  ): Promise<unknown[]> {
    const params: unknown[] = [actor.orgId, cycleId, actor.userId];
    let where = `b.org_id = $1 AND b.cycle_id = $2 AND b.target_id<>$3`;
    if (query.status) {
      if (!['BUILT', 'STALE', 'APPROVED', 'PUBLISHED'].includes(query.status)) {
        throw new BadRequestException({ code: 'FIELD_INVALID', field: 'status' });
      }
      params.push(query.status);
      where += ` AND b.status = $${params.length}`;
    }
    if (query.targetId) {
      params.push(query.targetId);
      where += ` AND b.target_id = $${params.length}`;
    }
    where += ' AND ' + new PolicyService(this.db).scopedSql(actor,'result.read_aggregate','b.cycle_id', '(SELECT cp.dept_snapshot FROM cycle_participants cp WHERE cp.cycle_id=b.cycle_id AND cp.user_id=b.target_id AND cp.org_id=b.org_id)',params);
    const { rows } = await this.db.query(
      `SELECT b.id, b.cycle_id, b.target_id, u.display_name AS target_name, b.dimension_json,
              b.input_hash, b.formula_version, b.exact_score, b.status, b.created_at,
              (SELECT count(*)::int FROM result_approvals a
                WHERE a.result_build_id = b.id AND a.decision = 'APPROVED') AS approvals
         FROM result_builds b JOIN users u ON u.id = b.target_id
        WHERE ${where}
        ORDER BY u.display_name`,
      params,
    );
    return rows;
  }

  async listReviewScores(actor: AuthContext, cycleId: string): Promise<unknown[]> {
    const params:unknown[]=[actor.orgId,cycleId,actor.userId];
    const boundary=new PolicyService(this.db).scopedSql(actor,'calibration.read_raw','r.cycle_id','(SELECT cp.dept_snapshot FROM cycle_participants cp WHERE cp.cycle_id=r.cycle_id AND cp.user_id=r.target_id AND cp.org_id=r.org_id)',params);
    const { rows } = await this.db.query(
      `SELECT r.id AS review_id, r.target_id, ut.display_name AS target_name,
              r.reviewer_id, ur.display_name AS reviewer_name,
              rr.score_bp, rr.revision_no, rr.submitted_at
         FROM reviews r
         JOIN users ut ON ut.id = r.target_id
         JOIN users ur ON ur.id = r.reviewer_id
         JOIN review_revisions rr ON rr.id=r.current_revision_id
        WHERE r.org_id = $1 AND r.cycle_id = $2 AND r.kind = 'PEER' AND ${effectiveReviewSql('r','rr')} AND r.target_id <> $3 AND ${boundary}
        ORDER BY ut.display_name, rr.submitted_at DESC`,
      params,
    );
    return rows.map((r) => ({ reviewId: r.review_id, targetId: r.target_id, targetName: r.target_name, reviewerId: r.reviewer_id, reviewerName: r.reviewer_name, score: r.score_bp === null ? null : Number(r.score_bp) / 100, revisionNo: r.revision_no, submittedAt: r.submitted_at }));
  }
}

// ============================================================
// helpers
// ============================================================

async function lockCycleInOrg(
  client: PoolClient,
  orgId: string,
  cycleId: string,
): Promise<{ id: string; status: string }> {
  await lockResultCycle(client,cycleId);
  const { rows } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM cycles WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [cycleId, orgId],
  );
  if (!rows[0]) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });
  return rows[0];
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
