import { PolicyService } from '../authz/policy.service';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  createFeedbackRequest,
  listFeedbackRequests,
  resolveFeedbackRequest,
  openRereview,
  resolveRereview,
  type FeedbackDecision,
  type RereviewDecision,
  enqueueNotification,
  validateAppealReason,
  lockResultCycle,
} from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';

/**
 * 反馈申诉闭环（技术文档 §13，呼应 D06）。
 * 申请：本人对本人已发布结果发起（窗口内），无需额外能力，但受本人隔离 + 窗口约束。
 * 处理：feedback.manage 角色审批（APPROVED/DONE 或 REJECTED）。
 * 每个动作写入通知 outbox，由 worker 投递。
 */
@Injectable()
export class FeedbackService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  async createRequest(
    actor: AuthContext,
    publicationId: string,
    reason: unknown,
  ): Promise<{ id: string; status: string }> {
    if (typeof publicationId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(publicationId)) {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'publicationId' });
    }
    let reasonText: string;
    try { reasonText = validateAppealReason(reason); }
    catch (e) { throw new BadRequestException({ code: (e as Error).message }); }
    return withTx(this.db, async (client) => {
      const publication = await client.query<{target_id: string; published_at: Date; cycle_id:string}>(
        `SELECT p.target_id,p.published_at,p.cycle_id FROM published_results p
         JOIN cycles c ON c.id=p.cycle_id AND c.org_id=p.org_id
         WHERE p.id=$1 AND p.org_id=$2`, [publicationId, actor.orgId]);
      if (!publication.rowCount) throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND' });
      if (publication.rows[0].target_id !== actor.userId) throw new ForbiddenException({ code: 'NOT_OWN_RESULT' });
      await assertCycleOpenForFeedback(client,actor.orgId,publication.rows[0].cycle_id);
      if (new Date(publication.rows[0].published_at).getTime() > Date.now()) {
        throw new BadRequestException({ code: 'FEEDBACK_WINDOW_CLOSED' });
      }
      // 重复申请保护：已有 PENDING 申请则 409（与 M4 行为一致）
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM feedback_requests
          WHERE publication_id = $1 AND applicant_id = $2 AND status = 'PENDING'`,
        [publicationId, actor.userId],
      );
      if (existing.rowCount) {
        throw new ConflictException({ code: 'FEEDBACK_DUPLICATED' });
      }

      let created: { id: string; status: string };
      try {
        created = await createFeedbackRequest(client, {
          publicationId,
          applicantId: actor.userId,
          reason: reasonText,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'NOT_OWN_RESULT') throw new ForbiddenException({ code: 'NOT_OWN_RESULT' });
        if (msg === 'FEEDBACK_DUPLICATED') throw new ConflictException({code:'FEEDBACK_DUPLICATED'});
        if (msg === 'FEEDBACK_WINDOW_CLOSED') {
          throw new BadRequestException({ code: 'FEEDBACK_WINDOW_CLOSED' });
        }
        if (msg === 'publication_not_found') throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND' });
        throw e;
      }

      await enqueueNotification(client, {
        orgId: actor.orgId,
        eventKey: `feedback.submitted:${created.id}`,
        recipientId: actor.userId,
        channel: 'IN_APP',
        payload: { type: 'FEEDBACK_SUBMITTED', publicationId, requestId: created.id },
      });
      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
         VALUES ($1, $2, 'feedback.request', 'published_result', $3, $4)`,
        [actor.orgId, actor.userId, publicationId, reasonText],
      );
      return created;
    });
  }

  async listRequests(actor: AuthContext, status?: string) {
    const rows = await listFeedbackRequests(this.db, actor.orgId, { status });
    const params:unknown[]=[actor.orgId];
    const boundary=new PolicyService(this.db).scopedSql(actor,'feedback.manage','p.cycle_id','cp.dept_snapshot',params);
    const allowed=await this.db.query(`SELECT f.id FROM feedback_requests f JOIN published_results p ON p.id=f.publication_id AND p.org_id=f.org_id
      JOIN cycle_participants cp ON cp.cycle_id=p.cycle_id AND cp.user_id=p.target_id AND cp.org_id=p.org_id WHERE f.org_id=$1 AND ${boundary}`,params);
    const ids=new Set(allowed.rows.map(r=>r.id));
    return rows.filter(r=>ids.has(r.id));
  }

  async listMine(actor: AuthContext) {
    return listFeedbackRequests(this.db, actor.orgId, { applicantId: actor.userId });
  }

  async resolve(
    actor: AuthContext,
    id: string,
    decision: FeedbackDecision,
    note?: string,
  ): Promise<{ id: string; status: string }> {
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'decision' });
    }
    note = requiredHandlingNote(note);
    return withTx(this.db, async (client) => {
      const req = await client.query<{ applicant_id: string; org_id: string }>(
        `SELECT fr.applicant_id, p.org_id FROM feedback_requests fr
          JOIN published_results p ON p.id = fr.publication_id
         WHERE fr.id = $1 AND fr.org_id=$2 AND p.org_id=$2`,
        [id, actor.orgId],
      );
      if (!req.rowCount) throw new NotFoundException({ code: 'FEEDBACK_REQUEST_NOT_FOUND' });

      let out: { id: string; status: string };
      try {
        out = await resolveFeedbackRequest(client, { id, handlerId: actor.userId, decision, note });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('FEEDBACK_NOT_PENDING')) {
          throw new ConflictLikeException(msg);
        }
        if (msg === 'feedback_request_not_found') throw new NotFoundException({ code: 'FEEDBACK_REQUEST_NOT_FOUND' });
        throw e;
      }

      await enqueueNotification(client, {
        orgId: req.rows[0].org_id,
        eventKey: `feedback.resolved:${id}`,
        recipientId: req.rows[0].applicant_id,
        channel: 'IN_APP',
        payload: { type: 'FEEDBACK_RESOLVED', requestId: id, decision },
      });
      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
         VALUES ($1, $2, 'feedback.resolve', 'feedback_request', $3, $4)`,
        [actor.orgId, actor.userId, id, `${decision}${note ? ':' + note : ''}`],
      );
      return out;
    });
  }

  async openRereview(
    actor: AuthContext,
    id: string,
    reason?: string,
  ): Promise<{ id: string; status: string }> {
    const reasonText = (reason ?? '').trim();
    if (!reasonText) {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'reason' });
    }
    return withTx(this.db, async (client) => {
      const req = await client.query<{ applicant_id: string; org_id: string }>(
        `SELECT fr.applicant_id, p.org_id FROM feedback_requests fr
          JOIN published_results p ON p.id = fr.publication_id
         WHERE fr.id = $1 AND fr.org_id=$2 AND p.org_id=$2`,
        [id, actor.orgId],
      );
      if (!req.rowCount) throw new NotFoundException({ code: 'FEEDBACK_REQUEST_NOT_FOUND' });

      // 仅本人可发起二次申诉
      if (req.rows[0].applicant_id !== actor.userId) {
        throw new ForbiddenException({ code: 'NOT_OWN_RESULT' });
      }
      const cycle=(await client.query('SELECT p.cycle_id FROM feedback_requests f JOIN published_results p ON p.id=f.publication_id WHERE f.id=$1 AND f.org_id=$2',[id,actor.orgId])).rows[0];
      await assertCycleOpenForFeedback(client,actor.orgId,cycle.cycle_id);

      let out: { id: string; status: string };
      try {
        out = await openRereview(client, { id, applicantId: actor.userId, reason: reasonText });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'NOT_OWN_RESULT') throw new ForbiddenException({ code: 'NOT_OWN_RESULT' });
        if (msg.startsWith('REREVIEW_NOT_ALLOWED')) {
          throw new ConflictException({ code: 'REREVIEW_NOT_ALLOWED', detail: msg });
        }
        if (msg === 'feedback_request_not_found') throw new NotFoundException({ code: 'FEEDBACK_REQUEST_NOT_FOUND' });
        throw e;
      }

      await enqueueNotification(client, {
        orgId: req.rows[0].org_id,
        eventKey: `feedback.rereview.opened:${id}`,
        recipientId: actor.userId,
        channel: 'IN_APP',
        payload: { type: 'FEEDBACK_REREVIEW_OPENED', requestId: id },
      });
      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
         VALUES ($1, $2, 'feedback.rereview.open', 'feedback_request', $3, $4)`,
        [actor.orgId, actor.userId, id, reasonText],
      );
      return out;
    });
  }

  async resolveRereview(
    actor: AuthContext,
    id: string,
    decision: RereviewDecision,
    note?: string,
  ): Promise<{ id: string; status: string }> {
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'decision' });
    }
    note = requiredHandlingNote(note);
    return withTx(this.db, async (client) => {
      const req = await client.query<{ applicant_id: string; org_id: string }>(
        `SELECT fr.applicant_id, p.org_id FROM feedback_requests fr
          JOIN published_results p ON p.id = fr.publication_id
         WHERE fr.id = $1 AND fr.org_id=$2 AND p.org_id=$2`,
        [id, actor.orgId],
      );
      if (!req.rowCount) throw new NotFoundException({ code: 'FEEDBACK_REQUEST_NOT_FOUND' });

      let out: { id: string; status: string };
      try {
        out = await resolveRereview(client, { id, handlerId: actor.userId, decision, note });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('REREVIEW_NOT_PENDING')) {
          throw new ConflictException({ code: 'REREVIEW_NOT_PENDING', detail: msg });
        }
        if (msg === 'feedback_request_not_found') throw new NotFoundException({ code: 'FEEDBACK_REQUEST_NOT_FOUND' });
        throw e;
      }

      await enqueueNotification(client, {
        orgId: req.rows[0].org_id,
        eventKey: `feedback.rereview.resolved:${id}`,
        recipientId: req.rows[0].applicant_id,
        channel: 'IN_APP',
        payload: { type: 'FEEDBACK_REREVIEW_RESOLVED', requestId: id, decision },
      });
      await client.query(
        `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
         VALUES ($1, $2, 'feedback.rereview.resolve', 'feedback_request', $3, $4)`,
        [actor.orgId, actor.userId, id, `${decision}${note ? ':' + note : ''}`],
      );
      return out;
    });
  }
}

async function assertCycleOpenForFeedback(client:PoolClient,orgId:string,cycleId:string) {
  await lockResultCycle(client,cycleId);
  const cycle=(await client.query('SELECT status FROM cycles WHERE id=$1 AND org_id=$2',[cycleId,orgId])).rows[0];
  if(!cycle)throw new NotFoundException({code:'CYCLE_NOT_FOUND'});
  if(cycle.status==='ARCHIVED'||cycle.status==='CANCELLED')throw new ConflictException({code:'CYCLE_READ_ONLY'});
}

function requiredHandlingNote(note: unknown): string {
  if (typeof note !== 'string' || !note.trim()) {
    throw new BadRequestException({ code: 'FIELD_INVALID', field: 'note', detail: '请填写处理意见。' });
  }
  return note.trim();
}

// 状态机冲突：复用 Nest 的 ConflictException
class ConflictLikeException extends ConflictException {
  constructor(detail: string) {
    super({ code: 'FEEDBACK_NOT_PENDING', detail });
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
