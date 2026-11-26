import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  saveAwardDecision,
  type AwardDecision as AwardDecisionValue,
} from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';

/**
 * 评优决策（技术文档 §11，呼应 D07）。
 * 系统不自动授奖：人工提名/评定（AWARDED / NOMINATED / NONE），按 (cycle,target,category) 幂等覆盖。
 * 候选排名由 results.controller 的 GET /cycles/:cycleId/award-candidates 提供（M4 已落地）。
 */
@Injectable()
export class AwardService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  async saveDecision(
    actor: AuthContext,
    body: { cycleId: string; targetId: string; category?: string; decision: AwardDecisionValue; reason?: string },
  ): Promise<{ id: string; status: string }> {
    const decision = body.decision;
    if (!['AWARDED', 'NOMINATED', 'NONE'].includes(decision)) {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'decision' });
    }
    const category = (body.category ?? '优秀员工').trim();
    if (!category) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'category' });
    if (decision !== 'NONE' && (!body.reason || !body.reason.trim())) {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'reason' });
    }

    return withTx(this.db, async (client) => {
      const cyc = await client.query<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM cycles WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [body.cycleId, actor.orgId],
      );
      if (!cyc.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });

      // 被评人须属本周期参与者
      const part = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM cycle_participants
          WHERE cycle_id = $1 AND user_id = $2`,
        [body.cycleId, body.targetId],
      );
      if (Number(part.rows[0].n) === 0) {
        throw new ForbiddenException({ code: 'TARGET_NOT_IN_CYCLE' });
      }
      const publication=(await client.query('SELECT publication_version FROM published_results WHERE cycle_id=$1 AND org_id=$2 AND target_id=$3 ORDER BY publication_version DESC LIMIT 1',[body.cycleId,actor.orgId,body.targetId])).rows[0];
      if(!publication)throw new BadRequestException({code:'PUBLISHED_RESULT_REQUIRED'});

      const { id } = await saveAwardDecision(client, {
        cycleId: body.cycleId,
        orgId: actor.orgId,
        targetId: body.targetId,
        category,
        decision,
        reason: body.reason,
        actorId: actor.userId,
        resultVersion: publication.publication_version,
      });

      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
         VALUES ($1, $2, 'award.decide', 'cycle', $3, $4)`,
        [actor.orgId, actor.userId, body.cycleId, `${category}:${decision}`],
      );

      return { id, status: 'OK' };
    });
  }

  /** 某周期已有评优决定（供前端回显；字段与前端类型对齐为 camelCase） */
  async listDecisions(
    actor: AuthContext,
    cycleId: string,
  ): Promise<
    Array<{
      id: string;
      cycleId: string;
      targetId: string;
      category: string;
      decision: string;
      reason: string | null;
      createdAt: Date;
    }>
  > {
    const { rows } = await this.db.query<{
      id: string;
      cycle_id: string;
      target_id: string;
      category: string;
      decision: string;
      reason: string | null;
      created_at: Date;
    }>(
      `SELECT id, cycle_id, target_id, category, decision, reason, created_at
         FROM award_decisions
        WHERE org_id = $1 AND cycle_id = $2
        ORDER BY category, target_id`,
      [actor.orgId, cycleId],
    );
    return rows.map((r) => ({
      id: r.id,
      cycleId: r.cycle_id,
      targetId: r.target_id,
      category: r.category,
      decision: r.decision,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }
}

async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
