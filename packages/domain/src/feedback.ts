/**
 * 反馈申诉闭环（技术文档 §13，呼应 D06）。
 *
 * 一级流程：被评人针对「自己」的已发布结果提交反馈/申诉申请（PENDING）
 *   → 获授权处理人（feedback.manage）审批：APPROVED→DONE（提供说明）/ REJECTED。
 * 窗口约束：发布后 3 个工作日（跳过周末）内可发起，逾期拒绝（D06）。
 * 按 (publication, applicant) 唯一（008 迁移），重复申请复用同一条。
 *
 * 二次申诉评审（M8）：一级结案（DONE / REJECTED）后，申请人可对「本人」记录发起
 *   二次申诉（REREVIEW_PENDING），由 feedback.manage 处理人二审：
 *   APPROVED→REREVIEW_DONE、REJECTED→REREVIEW_REJECTED（均为终态，不再可二次申诉）。
 *   二次申诉不另设窗口（其为一级结案后的升级复核）。
 */
import type { DbClient } from './db.js';

/** 反馈申诉窗口：发布后 N 个工作日（跳过周六周日）。 */
export function feedbackDeadline(publishedAt: Date, workingDays = 3): Date {
  const d = new Date(publishedAt.getTime());
  let added = 0;
  while (added < workingDays) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

/** 纯函数：给定发布时间与当前时间，是否仍在窗口内（含边界当天） */
export function isWithinFeedbackWindow(publishedAt: Date, now: Date, workingDays = 3): boolean {
  return now.getTime() <= feedbackDeadline(publishedAt, workingDays).getTime();
}

export interface CreateFeedbackInput {
  publicationId: string;
  applicantId: string;
  reason: string;
}

export async function createFeedbackRequest(
  client: DbClient,
  input: CreateFeedbackInput,
  now: Date = new Date(),
): Promise<{ id: string; status: string }> {
  const pub = await client.query<{
    cycle_id: string;
    target_id: string;
    org_id: string;
    published_at: Date;
  }>(
    `SELECT p.cycle_id, p.target_id, c.org_id, p.published_at
       FROM published_results p
       JOIN cycles c ON c.id = p.cycle_id
      WHERE p.id = $1`,
    [input.publicationId],
  );
  if (!pub.rowCount) throw new Error('publication_not_found');
  const p = pub.rows[0];

  // 只能对本人结果发起
  if (p.target_id !== input.applicantId) throw new Error('NOT_OWN_RESULT');

  // 窗口校验（D06：发布后 3 个工作日）
  if (!isWithinFeedbackWindow(new Date(p.published_at), now)) {
    throw new Error('FEEDBACK_WINDOW_CLOSED');
  }

  const ins = await client.query<{ id: string; status: string }>(
    `INSERT INTO feedback_requests (id, publication_id, org_id, applicant_id, reason, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PENDING')
     ON CONFLICT (publication_id, applicant_id) DO NOTHING
     RETURNING id, status`,
    [input.publicationId, p.org_id, input.applicantId, input.reason],
  );
  if (!ins.rowCount) throw new Error('FEEDBACK_DUPLICATED');
  return { id: ins.rows[0].id, status: ins.rows[0].status };
}

export interface FeedbackRequestRow {
  id: string;
  cycleId: string;
  targetId: string;
  reason: string;
  status: string;
  createdAt: string;
  handlerId: string | null;
  rereviewReason: string | null;
  rereviewOpenedAt: string | null;
  rereviewHandlerId: string | null;
  publicationId: string;
  publicationVersion: number;
  applicantName: string;
  departmentName: string | null;
  cycleTitle: string;
  cycleMonth: string;
  cycleOpenAt: string | null;
  cycleCloseAt: string | null;
  handlerNote: string | null;
  handlingRecords: Array<{
    stage: 'FIRST' | 'REREVIEW'; decision: string | null; note: string | null;
    handledAt: string; handlerId: string | null; handlerName: string | null;
  }>;
}

export async function listFeedbackRequests(
  client: DbClient,
  orgId: string,
  opts: { status?: string; applicantId?: string } = {},
): Promise<FeedbackRequestRow[]> {
  const params: unknown[] = [orgId];
  let where = 'fr.org_id = $1';
  if (opts.status) {
    params.push(opts.status);
    where += ` AND fr.status = $${params.length}`;
  }
  if (opts.applicantId) {
    params.push(opts.applicantId);
    where += ` AND fr.applicant_id = $${params.length}`;
  }
  const { rows } = await client.query<{
    id: string;
    cycle_id: string;
    target_id: string;
    reason: string;
    status: string;
    created_at: Date;
    handler_id: string | null;
    rereview_reason: string | null;
    rereview_opened_at: Date | null;
    rereview_handler_id: string | null;
    publication_id: string; publication_version: number;
    applicant_name: string; department_name: string | null;
    cycle_title: string; cycle_month: string; cycle_open_at: Date | null; cycle_close_at: Date | null;
    handling_events: Array<{ action: string; reason: string | null; createdAt: string; actorId: string | null; actorName: string | null }>;
  }>(
    `SELECT fr.id, p.cycle_id, fr.applicant_id AS target_id, fr.reason, fr.status,
            fr.created_at, fr.handler_id,
            fr.rereview_reason, fr.rereview_opened_at, fr.rereview_handler_id,
            p.id AS publication_id, p.publication_version, u.display_name AS applicant_name,
            COALESCE(d.name, membership.department_name) AS department_name,
            c.title AS cycle_title, to_char(c.month,'YYYY-MM') AS cycle_month,
            c.open_at AS cycle_open_at, c.close_at AS cycle_close_at,
            COALESCE(history.events,'[]'::json) AS handling_events
       FROM feedback_requests fr
       JOIN published_results p ON p.id=fr.publication_id AND p.org_id=fr.org_id AND p.target_id=fr.applicant_id
       JOIN cycles c ON c.id=p.cycle_id AND c.org_id=fr.org_id
       JOIN users u ON u.id=fr.applicant_id AND u.org_id=fr.org_id
       LEFT JOIN cycle_participants cp ON cp.cycle_id=c.id AND cp.user_id=u.id AND cp.org_id=fr.org_id
       LEFT JOIN departments d ON d.id=cp.dept_snapshot AND d.org_id=fr.org_id
       LEFT JOIN LATERAL (
         SELECT md.name AS department_name FROM department_memberships m
         JOIN departments md ON md.id=m.department_id AND md.org_id=fr.org_id
         WHERE m.user_id=u.id AND m.org_id=fr.org_id AND m.valid_to IS NULL
         ORDER BY m.valid_from DESC LIMIT 1
       ) membership ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('action',a.action,'reason',a.reason,'createdAt',a.created_at,
           'actorId',a.actor_id,'actorName',actor.display_name) ORDER BY a.created_at,a.id) AS events
         FROM audit_events a LEFT JOIN users actor ON actor.id=a.actor_id AND actor.org_id=fr.org_id
         WHERE a.org_id=fr.org_id AND a.resource_type='feedback_request' AND a.resource_id=fr.id::text
           AND a.action IN ('feedback.resolve','feedback.rereview.resolve')
       ) history ON true
      WHERE ${where}
      ORDER BY fr.created_at DESC`,
    params,
  );
  return rows.map((r) => {
    const handlingRecords = r.handling_events.map(event => {
      const match = /^(APPROVED|REJECTED)(?::([\s\S]*))?$/.exec(event.reason ?? '');
      return { stage: event.action === 'feedback.resolve' ? 'FIRST' as const : 'REREVIEW' as const,
        decision: match?.[1] ?? null, note: match?.[2] || null,
        handledAt: new Date(event.createdAt).toISOString(), handlerId: event.actorId, handlerName: event.actorName };
    });
    return {
    id: r.id,
    cycleId: r.cycle_id,
    targetId: r.target_id,
    reason: r.reason,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    handlerId: r.handler_id,
    rereviewReason: r.rereview_reason,
    rereviewOpenedAt: r.rereview_opened_at ? new Date(r.rereview_opened_at).toISOString() : null,
    rereviewHandlerId: r.rereview_handler_id,
    publicationId: r.publication_id, publicationVersion: r.publication_version,
    applicantName: r.applicant_name, departmentName: r.department_name,
    cycleTitle: r.cycle_title, cycleMonth: r.cycle_month,
    cycleOpenAt: r.cycle_open_at ? new Date(r.cycle_open_at).toISOString() : null,
    cycleCloseAt: r.cycle_close_at ? new Date(r.cycle_close_at).toISOString() : null,
    handlerNote: handlingRecords.at(-1)?.note ?? null, handlingRecords,
  };
  });
}

export type FeedbackDecision = 'APPROVED' | 'REJECTED';

export interface ResolveFeedbackInput {
  id: string;
  handlerId: string;
  decision: FeedbackDecision;
  note?: string;
}

/**
 * 处理人审批反馈申诉。
 * APPROVED → DONE（已提供说明，闭环完成），REJECTED → REJECTED。
 * 仅在 PENDING 状态可处理；非 PENDING 抛错（幂等/状态机保护）。
 */
export async function resolveFeedbackRequest(
  client: DbClient,
  input: ResolveFeedbackInput,
): Promise<{ id: string; status: string }> {
  const nextStatus = input.decision === 'APPROVED' ? 'DONE' : 'REJECTED';
  const upd = await client.query<{ id: string; status: string }>(
    `UPDATE feedback_requests
        SET status = $2, handler_id = $3
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, status`,
    [input.id, nextStatus, input.handlerId],
  );
  if (upd.rowCount === 0) {
    const cur = await client.query<{ status: string }>(
      `SELECT status FROM feedback_requests WHERE id = $1`,
      [input.id],
    );
    if (!cur.rowCount) throw new Error('feedback_request_not_found');
    if (cur.rows[0].status !== 'PENDING') {
      throw new Error(`FEEDBACK_NOT_PENDING:${cur.rows[0].status}`);
    }
  }
  // note 由调用方写 audit_events（此处不落列，避免改表）
  void input.note;
  return { id: input.id, status: nextStatus };
}

/**
 * 二次申诉状态机（M8）。
 * 一级结案状态（DONE / REJECTED）之后，申请人可对「本人」记录发起二次申诉。
 * 仅本人可发起（owner 校验），且仅当当前状态为 DONE / REJECTED 时可发起；
 * 其余状态（PENDING / 已处于任意 REREVIEW_*）抛错。
 */
export interface OpenRereviewInput {
  id: string;
  applicantId: string;
  reason: string;
}

export async function openRereview(
  client: DbClient,
  input: OpenRereviewInput,
  now: Date = new Date(),
): Promise<{ id: string; status: string }> {
  const cur = await client.query<{ applicant_id: string; status: string }>(
    `SELECT applicant_id, status FROM feedback_requests WHERE id = $1 FOR UPDATE`,
    [input.id],
  );
  if (!cur.rowCount) throw new Error('feedback_request_not_found');
  const row = cur.rows[0];
  if (row.applicant_id !== input.applicantId) throw new Error('NOT_OWN_RESULT');
  if (row.status !== 'DONE' && row.status !== 'REJECTED') {
    throw new Error(`REREVIEW_NOT_ALLOWED:${row.status}`);
  }
  const upd = await client.query<{ id: string; status: string }>(
    `UPDATE feedback_requests
        SET status = 'REREVIEW_PENDING',
            rereview_reason = $2,
            rereview_opened_at = $3
      WHERE id = $1 AND status IN ('DONE','REJECTED')
      RETURNING id, status`,
    [input.id, input.reason, now.toISOString()],
  );
  return { id: upd.rows[0].id, status: upd.rows[0].status };
}

export type RereviewDecision = 'APPROVED' | 'REJECTED';

export interface ResolveRereviewInput {
  id: string;
  handlerId: string;
  decision: RereviewDecision;
  note?: string;
}

/**
 * 处理人二审二次申诉。
 * APPROVED → REREVIEW_DONE（二次申诉被支持），REJECTED → REREVIEW_REJECTED（维持原结论）。
 * 仅在 REREVIEW_PENDING 状态可处理；非 REREVIEW_PENDING 抛错（状态机保护）。
 * 两者均为终态，不再可再次发起二次申诉。
 */
export async function resolveRereview(
  client: DbClient,
  input: ResolveRereviewInput,
): Promise<{ id: string; status: string }> {
  const nextStatus = input.decision === 'APPROVED' ? 'REREVIEW_DONE' : 'REREVIEW_REJECTED';
  const upd = await client.query<{ id: string; status: string }>(
    `UPDATE feedback_requests
        SET status = $2, rereview_handler_id = $3
      WHERE id = $1 AND status = 'REREVIEW_PENDING'
      RETURNING id, status`,
    [input.id, nextStatus, input.handlerId],
  );
  if (upd.rowCount === 0) {
    const cur = await client.query<{ status: string }>(
      `SELECT status FROM feedback_requests WHERE id = $1`,
      [input.id],
    );
    if (!cur.rowCount) throw new Error('feedback_request_not_found');
    if (cur.rows[0].status !== 'REREVIEW_PENDING') {
      throw new Error(`REREVIEW_NOT_PENDING:${cur.rows[0].status}`);
    }
  }
  void input.note;
  return { id: input.id, status: nextStatus };
}
