import { personalPublication } from './personal-projection';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { publishBuildTx, lockResultCycle, listAwardCandidates } from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';

/**
 * 结果发布与个人结果读取（技术文档 §10、§9.3 匿名反馈）。
 *
 * 发布事务重验：build input_hash、有效批准、本人隔离（SQL 编排在
 * @360/domain 的 results/ops.ts，与 worker PUBLISH 相位共用）。
 * payload_json 为匿名投影：不含 review_id/reviewer_id/来源类别/精确提交时间。
 * 个人结果 API 只读 published_results.payload_json，即使有后台权限
 * 也不返回自己的原始他评。
 */

@Injectable()
export class PublishService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  // ============================================================
  // 发布单个 build（result.publish 能力；本人排除；重验输入与批准）
  // ============================================================

  async publishBuild(
    actor: AuthContext,
    buildId: string,
  ): Promise<{ publicationId: string; targetId: string; publicationVersion: number; exactScore: number | null }> {
    const outcome=await withTx(this.db, async (client) => {
      const ref=(await client.query('SELECT cycle_id FROM result_builds WHERE id=$1 AND org_id=$2',[buildId,actor.orgId])).rows[0];
      if(!ref)throw new NotFoundException({code:'BUILD_NOT_FOUND'});
      await lockResultCycle(client,ref.cycle_id);
      const b = await client.query<{ cycle_id: string; target_id: string; status: string }>(
        `SELECT cycle_id, target_id, status FROM result_builds WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [buildId, actor.orgId],
      );
      if (!b.rowCount) throw new NotFoundException({ code: 'BUILD_NOT_FOUND' });
      const build = b.rows[0];

      // 本人排除（发布自己结果的人不得是自己）
      if (build.target_id === actor.userId) {
        throw new ForbiddenException({ code: 'SELF_AUDIT_FORBIDDEN' });
      }
      if (build.status === 'PUBLISHED') {
        throw new ConflictException({ code: 'ALREADY_PUBLISHED' });
      }
      if (build.status !== 'APPROVED') {
        throw new ConflictException({ code: build.status === 'STALE' ? 'RESULT_STALE' : 'APPROVAL_REQUIRED' });
      }

      const approval = await client.query<{ id: string }>(
        `SELECT a.id FROM result_approvals a
          WHERE a.result_build_id = $1 AND a.decision = 'APPROVED'
          ORDER BY a.created_at DESC LIMIT 1`,
        [buildId],
      );
      if (!approval.rowCount) throw new ConflictException({ code: 'APPROVAL_REQUIRED' });

      const cyc = await client.query<{ status: string }>(
        `SELECT status FROM cycles WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [build.cycle_id, actor.orgId],
      );
      if (!cyc.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });
      const cycleStatus = cyc.rows[0].status;
      if (cycleStatus !== 'CALIBRATING' && cycleStatus !== 'PUBLISHED' && cycleStatus !== 'PARTIALLY_PUBLISHED') {
        throw new ConflictException({ code: 'CYCLE_STATUS_INVALID', status: cycleStatus });
      }

      // publishBuildTx 内部重验 input_hash；返回 null 表示输入已变（RESULT_STALE）
      const result = await publishBuildTx(client, actor.orgId, buildId);
      if (result === null) return null;

      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
         VALUES ($1, $2, 'result.publish', 'published_result', $3, $4)`,
        [actor.orgId, actor.userId, result.publicationId, `v${result.publicationVersion}`],
      );
      return result;
    });
    if(!outcome)throw new ConflictException({code:'RESULT_STALE'});
    return outcome;
  }

  // ============================================================
  // 本人结果（只读 payload 快照投影）
  // ============================================================

  async listMyResults(actor: AuthContext): Promise<unknown[]> {
    const { rows } = await this.db.query(
      `SELECT p.id,p.cycle_id,to_char(c.month,'YYYY-MM') AS month,p.publication_version,
              p.payload_json,p.published_at,c.title,c.open_at,c.close_at,b.dimension_json
         FROM published_results p JOIN cycles c ON c.id=p.cycle_id AND c.org_id=p.org_id
         LEFT JOIN result_builds b ON b.id=p.result_build_id AND b.org_id=p.org_id
        WHERE p.org_id=$1 AND p.target_id=$2 ORDER BY p.published_at DESC`,[actor.orgId,actor.userId]);
    if (!rows.length) return [];
    return rows.map(personalPublication);
  }

  // ============================================================
  // 评优候选（award.manage；只读已发布完整结果；不给成员端）
  // ============================================================

  async awardCandidates(actor: AuthContext, cycleId: string): Promise<unknown[]> {
    const cyc = await this.db.query<{ id: string }>(
      `SELECT id FROM cycles WHERE id = $1 AND org_id = $2`,
      [cycleId, actor.orgId],
    );
    if (!cyc.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });

    return listAwardCandidates(this.db,cycleId);
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
