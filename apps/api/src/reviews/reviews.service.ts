import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  checkRevisionSubmission,
  isRevisionRequested,
  parseReasonThresholds,
  validateSubmitReasons,
  ITEM_REASON_RULES,
  validateReviewItems, reviewScoreBp, ReviewValidationError, lockResultCycle, invalidateTargetBuilds, createTriggers, cycleThresholds, effectiveReviewSql,
} from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';
import { freezeReviewMaterials } from '../report/material-lock';

// ============================================================
// 类型
// ============================================================

/** 他评开放闸门：自评阶段与本人自评都完成后，才允许进入他评 */
type PeerGateReason = 'SELF_PHASE' | 'SELF_REVIEW_PENDING' | 'CYCLE_NOT_REVIEWING';
interface PeerGate {
  open: boolean;
  reason: PeerGateReason | null;
  selfCloseAt: Date | null;
  closeAt: Date | null;
}

interface MyTaskList {
  cycle: { id: string; month: string; title: string; status: string; close_at: Date | null; self_close_at: Date | null };
  peers: Array<{
    assignmentId: string;
    target: { id: string; displayName: string; department?: string | null };
    sourceType: string;
    review: { id: string; status: string; submittedAt: Date | null } | null;
  }>;
  self: { reviewId: string | null; status: string; submittedAt: Date | null };
  peerGate: PeerGate;
}

interface ReviewDetail {
  reasonRules: {lowExclusive:number;highInclusive:number;minChars:number;mode?:'legacy'|'prd';overallMinChars?:number;lowOverallMinChars?:number;lowScore?:number};
  review: {
    id: string;
    cycleId: string;
    kind: 'SELF' | 'PEER';
    status: string;
    target: { id: string; displayName: string };
  };
  template: {
    id: string;
    name: string;
    roleCode: string;
    items: Array<{ id: string; code: string; label: string; weight: number; position: number }>;
  };
  latestRevision: {
    id: string;
    revisionNo: number;
    items: Array<{itemId:string;score:number;reason:string|null}>;
    scoreBp: number | null;
    overallReason: string | null;
    comment: string | null;
    nextPlan: string | null;
    readConfirmed: boolean;
    submittedAt: Date | null;
  } | null;
  draft: {
    dataJson: DraftPayload;
    reportVersionId: string | null;
    rowVersion: number;
  };
  /** 核验要求原评价人更正/补充时的受控修订请求；null 表示无 */
  revisionRequest: {
    caseId: string;
    dueAt: Date | null;
    latestAction: string | null;
    reason: string | null;
    expired: boolean;
  } | null;
}

interface DraftPayload {
  items?: Array<{ itemId: string; score: number | null; reason?: string | null }>;
  overallReason?: string | null;
  comment?: string | null;
  nextPlan?: string | null;
  readConfirmed?: boolean;
}

interface DraftItemInput { itemId: string; score: number | null; reason?: string | null }
interface DraftBody {
  items?: DraftItemInput[];
  overallReason?: string | null;
  comment?: string | null;
  nextPlan?: string | null;
  readConfirmed?: boolean;
  reportVersionId?: string | null;
}
interface SubmitBody { force?: boolean; payload?: DraftPayload }

/** 提交/修订共用的评价归属行 */
interface OwnReviewRow {
  reviewer_id: string;
  target_id: string;
  cycle_id: string;
  org_id: string;
  kind: 'SELF' | 'PEER';
  assignment_id: string | null;
  status: string;
}

interface RevisionResult {
  revisionId: string;
  revisionNo: number;
  scoreBp: number;
}

function normalizeDraft(input: {
  items?: DraftItemInput[];
  overallReason?: string | null;
  comment?: string | null;
  nextPlan?: string | null;
  readConfirmed?: boolean;
}): DraftPayload {
  return {
    items: (input.items ?? []).map((it) => ({ itemId: it.itemId, score: it.score, reason: it.reason ?? null })),
    overallReason: input.overallReason ?? null,
    comment: input.comment ?? null,
    nextPlan: input.nextPlan ?? null,
    readConfirmed: input.readConfirmed ?? false,
  };
}

// ============================================================
// Service
// ============================================================

@Injectable()
export class ReviewsService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  // ------------------ 我在此周期的任务清单 ------------------

  async listMyTasks(actor: AuthContext, cycleId: string): Promise<MyTaskList> {
    const cyc = await this.db.query<{ id: string; month: string; title: string; status: string; close_at: Date | null; self_close_at: Date | null }>(
      `SELECT id, to_char(month,'YYYY-MM') AS month, title, status, close_at, self_close_at
       FROM cycles WHERE id = $1 AND org_id = $2`,
      [cycleId, actor.orgId],
    );
    if (!cyc.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });

    const peerRows = await this.db.query<{
      assignment_id: string;
      target_id: string;
      target_name: string;
      department: string | null;
      source_type: string;
      review_id: string | null;
      review_status: string | null;
      submitted_at: Date | null;
    }>(
      `SELECT a.id AS assignment_id, a.target_id, u.display_name AS target_name, d.name AS department,
              a.source_type,
              r.id AS review_id, r.status AS review_status,
              (SELECT submitted_at FROM review_revisions
                WHERE review_id = r.id ORDER BY revision_no DESC LIMIT 1) AS submitted_at
         FROM assignments a
         JOIN users u ON u.id = a.target_id
         LEFT JOIN cycle_participants cp ON cp.cycle_id=a.cycle_id AND cp.user_id=a.target_id
         LEFT JOIN departments d ON d.id=cp.dept_snapshot
         LEFT JOIN reviews r ON r.assignment_id = a.id AND r.kind = 'PEER'
        WHERE a.cycle_id = $1 AND a.reviewer_id = $2 AND a.status = 'ACTIVE'
        ORDER BY a.source_type, u.display_name`,
      [cycleId, actor.userId],
    );

    const selfRows = await this.db.query<{
      review_id: string;
      review_status: string | null;
      submitted_at: Date | null;
    }>(
      `SELECT r.id AS review_id, r.status AS review_status,
              (SELECT submitted_at FROM review_revisions
                WHERE review_id = r.id ORDER BY revision_no DESC LIMIT 1) AS submitted_at
         FROM reviews r
        WHERE r.cycle_id = $1 AND r.reviewer_id = $2 AND r.target_id = $2 AND r.kind = 'SELF'`,
      [cycleId, actor.userId],
    );

    const selfRow = selfRows.rowCount
      ? {
          reviewId: selfRows.rows[0].review_id,
          status: selfRows.rows[0].review_status ?? 'NOT_STARTED',
          submittedAt: selfRows.rows[0].submitted_at,
        }
      : { reviewId: null, status: 'NOT_STARTED', submittedAt: null };

    return {
      cycle: cyc.rows[0],
      peers: peerRows.rows.map((r) => ({
        assignmentId: r.assignment_id,
        target: { id: r.target_id, displayName: r.target_name, department:r.department },
        sourceType: r.source_type,
        review: r.review_id
          ? { id: r.review_id, status: r.review_status!, submittedAt: r.submitted_at }
          : null,
      })),
      self: selfRow,
      peerGate: this.buildPeerGate(cyc.rows[0], selfRow.status),
    };
  }

  /** 他评开放判定：先统一自评（含材料上传），本人自评提交后才允许看他人的月度材料并评价 */
  private buildPeerGate(
    cycle: { status: string; self_close_at?: Date | null; close_at?: Date | null },
    selfStatus: string,
  ): PeerGate {
    const selfCloseAt = cycle.self_close_at ?? null;
    const closeAt = cycle.close_at ?? null;
    if (cycle.status !== 'REVIEWING') return { open: false, reason: 'CYCLE_NOT_REVIEWING', selfCloseAt, closeAt };
    if (selfCloseAt && Date.now() < new Date(selfCloseAt).getTime()) {
      return { open: false, reason: 'SELF_PHASE', selfCloseAt, closeAt };
    }
    if (selfStatus !== 'SUBMITTED') return { open: false, reason: 'SELF_REVIEW_PENDING', selfCloseAt, closeAt };
    return { open: true, reason: null, selfCloseAt, closeAt };
  }

  private async peerGateFor(cycleId: string, actor: AuthContext): Promise<PeerGate> {
    const row = await this.db.query<{ status: string; self_close_at: Date | null; close_at: Date | null }>(
      `SELECT status, self_close_at, close_at FROM cycles WHERE id = $1 AND org_id = $2`,
      [cycleId, actor.orgId],
    );
    if (!row.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });
    const self = await this.db.query<{ status: string }>(
      `SELECT status FROM reviews
        WHERE cycle_id = $1 AND reviewer_id = $2 AND target_id = $2 AND kind = 'SELF' AND org_id = $3
        ORDER BY (status = 'SUBMITTED') DESC
        LIMIT 1`,
      [cycleId, actor.userId, actor.orgId],
    );
    return this.buildPeerGate(row.rows[0], self.rows[0]?.status ?? 'NOT_STARTED');
  }

  /** 写他评前必须过闸门；已提交的评价（含更正修订）不受影响 */
  private async assertPeerGate(actor: AuthContext, own: OwnReviewRow): Promise<void> {
    if (own.kind !== 'PEER' || own.status === 'SUBMITTED') return;
    const gate = await this.peerGateFor(own.cycle_id, actor);
    if (gate.open) return;
    throw new BadRequestException({
      code: gate.reason === 'SELF_PHASE' ? 'PEER_REVIEW_NOT_OPEN' : gate.reason === 'SELF_REVIEW_PENDING' ? 'PEER_REVIEW_LOCKED_SELF_PENDING' : 'REVIEW_PERIOD_CLOSED',
      detail: gate.reason ?? undefined,
    });
  }

  // ------------------ 创建或获取自评 ------------------

  async ensureSelfReview(actor: AuthContext, cycleId: string): Promise<{ reviewId: string }> {
    return withTx(this.db, async (client) => {
      const cyc = await client.query<{ id: string; status: string; close_at: Date | null }>(
        `SELECT id, status, close_at FROM cycles WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [cycleId, actor.orgId],
      );
      if (!cyc.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });

      const participant = await client.query(
        `SELECT 1 FROM cycle_participants
          WHERE cycle_id = $1 AND org_id = $2 AND user_id = $3 AND eligibility = 'ELIGIBLE'`,
        [cycleId, actor.orgId, actor.userId],
      );
      if (!participant.rowCount) throw new ForbiddenException({ code: 'NOT_CYCLE_PARTICIPANT' });

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM reviews WHERE cycle_id = $1 AND target_id = $2 AND kind = 'SELF'`,
        [cycleId, actor.userId],
      );
      if (existing.rowCount) return { reviewId: existing.rows[0].id };

      if (cyc.rows[0].status !== 'REVIEWING' || !cyc.rows[0].close_at || new Date(cyc.rows[0].close_at).getTime() <= Date.now()) {
        throw new BadRequestException({ code: 'REVIEW_PERIOD_CLOSED' });
      }

      const ins = await client.query<{ id: string }>(
        `INSERT INTO reviews (id, cycle_id, org_id, assignment_id, reviewer_id, target_id, kind, status)
         VALUES (gen_random_uuid(), $1, $2, NULL, $3, $3, 'SELF', 'DRAFT')
         RETURNING id`,
        [cycleId, actor.orgId, actor.userId],
      );
      return { reviewId: ins.rows[0].id };
    });
  }

  // ------------------ 详情 ------------------

  async getReviewDetail(actor: AuthContext, reviewId: string): Promise<ReviewDetail> {
    const r = await this.db.query<{
      id: string;
      cycle_id: string;
      target_id: string;
      target_name: string;
      reviewer_id: string;
      kind: 'SELF' | 'PEER';
      status: string;
      assignment_id: string | null;
      source_type: string | null;
    }>(
      `SELECT r.id, r.cycle_id, r.target_id, u.display_name AS target_name,
              r.reviewer_id, r.kind, r.status,
              r.assignment_id, a.source_type
         FROM reviews r
         JOIN users u ON u.id = r.target_id
         LEFT JOIN assignments a ON a.id = r.assignment_id
        WHERE r.id = $1 AND r.org_id = $2`,
      [reviewId, actor.orgId],
    );
    if (!r.rowCount) throw new NotFoundException({ code: 'REVIEW_NOT_FOUND' });
    const row = r.rows[0];
    if (row.reviewer_id !== actor.userId) throw new ForbiddenException({ code: 'NOT_REVIEW_OWNER' });
    if(row.kind==='PEER' && !(await this.db.query("SELECT id FROM assignments WHERE id=$1 AND org_id=$2 AND reviewer_id=$3 AND status='ACTIVE'",[row.assignment_id,actor.orgId,actor.userId])).rowCount)
      throw new ForbiddenException({code:'ASSIGNMENT_NOT_ACTIVE'});
    if (row.reviewer_id !== actor.userId) {
      throw new ForbiddenException({ code: 'NOT_REVIEW_OWNER' });
    }
    if (row.status !== 'DRAFT') {
      // 已 SUBMITTED 后仍允许查（看自己的提交），但拒绝改
    }
    // 他评需先完成统一自评：未开放时不允许进入评价页（其材料区会展示他人月报成果）
    if (row.kind === 'PEER' && row.status !== 'SUBMITTED') {
      const gate = await this.peerGateFor(row.cycle_id, actor);
      if (!gate.open) {
        throw new BadRequestException({
          code: gate.reason === 'SELF_PHASE' ? 'PEER_REVIEW_NOT_OPEN' : gate.reason === 'SELF_REVIEW_PENDING' ? 'PEER_REVIEW_LOCKED_SELF_PENDING' : 'REVIEW_PERIOD_CLOSED',
          detail: gate.reason ?? undefined,
        });
      }
    }

    const roleCode = row.kind === 'SELF' ? 'SELF' : 'TARGET_SNAPSHOT';
    const tpl = await this.db.query<{
      id: string;
      name: string;
      role_code: string;
      item_id: string;
      code: string;
      label: string;
      weight: number;
      position: number;
    }>(
      `SELECT tv.id, tv.name, tv.role_code,
              ti.id AS item_id, ti.code, ti.label, ti.weight, ti.position
         FROM template_versions tv
         JOIN rulesets rs ON rs.id = tv.ruleset_id
         JOIN cycles c ON c.ruleset_id = rs.id
         JOIN template_items ti ON ti.template_id = tv.id
        JOIN cycle_participants cp ON cp.cycle_id=c.id AND cp.user_id=$3 AND cp.org_id=tv.org_id
        WHERE c.id = $1 AND cp.eligibility='ELIGIBLE' AND (($2='SELF' AND tv.role_code='SELF') OR ($2='TARGET_SNAPSHOT' AND tv.id=cp.template_id))
        ORDER BY ti.position`,
      [row.cycle_id, roleCode,row.target_id],
    );
    if (!tpl.rowCount) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', role: roleCode });

    const template = {
      id: tpl.rows[0].id,
      name: tpl.rows[0].name,
      roleCode: tpl.rows[0].role_code,
      items: tpl.rows.map((x) => ({
        id: x.item_id, code: x.code, label: x.label, weight: x.weight, position: x.position,
      })),
    };

    const rev = await this.db.query<{
      id: string; revision_no: number; score_bp: number | null;
      overall_reason: string | null; comment: string | null; next_plan: string | null;
      read_confirmed: boolean; submitted_at: Date | null;
    }>(
      `SELECT id, revision_no, score_bp, overall_reason, comment, next_plan,
              read_confirmed, submitted_at
         FROM review_revisions WHERE review_id = $1
         ORDER BY revision_no DESC LIMIT 1`,
      [reviewId],
    );

    const draft = await this.db.query<{
      data_json: DraftPayload; report_version_id: string | null; row_version: number;
    }>(
      `SELECT data_json, report_version_id, row_version
         FROM review_drafts d
           JOIN reviews r ON r.cycle_id = d.cycle_id AND r.reviewer_id = d.reviewer_id
              AND r.target_id = d.target_id AND r.kind = d.kind
          WHERE r.id = $1`,
      [reviewId],
    );

    // 核验是否要求原评价人更正/补充（前端据此展示"提交修订版"入口与截止时间）
    const revCase = await this.db.query<{
      id: string; revision_due_at: Date | null; latest_action: string | null; reason: string | null;
    }>(
      `SELECT cc.id, cc.revision_due_at,
              (SELECT ca.action FROM calibration_actions ca
                WHERE ca.case_id = cc.id ORDER BY ca.created_at DESC, ca.id DESC LIMIT 1) AS latest_action,
              (SELECT ca.reason FROM calibration_actions ca
                WHERE ca.case_id = cc.id ORDER BY ca.created_at DESC, ca.id DESC LIMIT 1) AS reason
         FROM calibration_cases cc
         JOIN reviews r ON r.current_revision_id = cc.review_revision_id
        WHERE r.id = $1 AND cc.status = 'OPEN' AND cc.invalidated_at IS NULL`,
      [reviewId],
    );
    const revHit = revCase.rows.find((x) => isRevisionRequested(x.latest_action)) ?? null;
    const submittedItems = rev.rowCount ? await this.db.query<{itemId:string;score:number;reason:string|null}>('SELECT item_id AS "itemId",score,reason FROM review_item_scores WHERE revision_id=$1 AND org_id=$2',[rev.rows[0].id,actor.orgId]) : null;
    const revisionRequest = revHit
      ? {
          caseId: revHit.id,
          dueAt: revHit.revision_due_at,
          latestAction: revHit.latest_action,
          reason: revHit.reason,
          expired: !!revHit.revision_due_at && Date.now() > new Date(revHit.revision_due_at).getTime(),
        }
      : null;

    const ruleConfig=(await this.db.query(`SELECT rs.config_json FROM cycles c JOIN rulesets rs ON rs.id=c.ruleset_id AND rs.org_id=c.org_id WHERE c.id=$1 AND c.org_id=$2`,[row.cycle_id,actor.orgId])).rows[0]?.config_json;
    const reasonPolicy=parseReasonThresholds(ruleConfig);
    return {
      reasonRules: reasonPolicy.policy==='prd'?{mode:'prd' as const,lowExclusive:reasonPolicy.lowBp/100,highInclusive:reasonPolicy.highBp/100,minChars:reasonPolicy.itemMinChars,overallMinChars:reasonPolicy.overallMinChars,lowOverallMinChars:reasonPolicy.lowOverallMinChars,lowScore:reasonPolicy.lowBp/100}:ITEM_REASON_RULES,
      review: {
        id: row.id, cycleId: row.cycle_id, kind: row.kind, status: row.status,
        target: { id: row.target_id, displayName: row.target_name },
      },
      template,
      latestRevision: rev.rowCount
        ? {
            id: rev.rows[0].id,
            revisionNo: rev.rows[0].revision_no,
            items: submittedItems?.rows ?? [],
            scoreBp: rev.rows[0].score_bp,
            overallReason: rev.rows[0].overall_reason,
            comment: rev.rows[0].comment,
            nextPlan: rev.rows[0].next_plan,
            readConfirmed: rev.rows[0].read_confirmed,
            submittedAt: rev.rows[0].submitted_at,
          }
        : null,
      draft: draft.rowCount
        ? {
            dataJson: draft.rows[0].data_json,
            reportVersionId: draft.rows[0].report_version_id,
            rowVersion: draft.rows[0].row_version,
          }
        : { dataJson: { items: [], overallReason: null, comment: null, nextPlan: null, readConfirmed: false },
            reportVersionId: null, rowVersion: 0 },
      revisionRequest,
    };
  }

  private async lockResultForReview(client:PoolClient,actor:AuthContext,reviewId:string) {
    const row=(await client.query('SELECT cycle_id FROM reviews WHERE id=$1 AND org_id=$2',[reviewId,actor.orgId])).rows[0];
    if(!row)throw new NotFoundException({code:'REVIEW_NOT_FOUND'});
    await lockResultCycle(client,row.cycle_id);
  }
  private async effectiveTemplate(client:PoolClient,review:OwnReviewRow) {
    const result=await client.query<{id:string;weight:number;template_id:string}>(`SELECT ti.id,ti.weight,tv.id AS template_id
      FROM cycles c JOIN cycle_participants cp ON cp.cycle_id=c.id AND cp.org_id=c.org_id AND cp.user_id=$2
      JOIN template_versions tv ON tv.ruleset_id=c.ruleset_id AND tv.org_id=c.org_id
      JOIN template_items ti ON ti.template_id=tv.id AND ti.org_id=tv.org_id
      WHERE c.id=$1 AND c.org_id=$3 AND cp.eligibility='ELIGIBLE'
        AND (($4='SELF' AND tv.role_code='SELF') OR ($4='PEER' AND tv.id=cp.template_id)) ORDER BY ti.position`,[review.cycle_id,review.target_id,review.org_id,review.kind]);
    if(!result.rowCount)throw new BadRequestException({code:'TEMPLATE_NOT_FOUND'});
    return result.rows;
  }
  private checkedItems(template:Array<{id:string;weight:number}>,items:unknown,complete:boolean) {
    try{return validateReviewItems(template,items,complete);}
    catch(error){if(error instanceof ReviewValidationError)throw new BadRequestException({code:error.code,itemId:error.itemId});throw error;}
  }

  // ------------------ 保存草稿 ------------------

  async saveDraft(
    actor: AuthContext,
    reviewId: string,
    body: DraftBody,
  ): Promise<{ rowVersion: number }> {
    return withTx(this.db, async (client) => {
      await this.lockResultForReview(client,actor,reviewId);
      const own = await client.query<OwnReviewRow>(
        `SELECT reviewer_id, target_id, cycle_id, org_id, kind, assignment_id, status
           FROM reviews WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [reviewId, actor.orgId],
      );
      if (!own.rowCount) throw new NotFoundException({ code: 'REVIEW_NOT_FOUND' });
      const ownRow = own.rows[0];
      if (ownRow.kind === 'PEER') {
        const assignment=await client.query("SELECT id FROM assignments WHERE id=$1 AND org_id=$2 AND reviewer_id=$3 AND cycle_id=$4 AND target_id=$5 AND status='ACTIVE' FOR SHARE",[ownRow.assignment_id,actor.orgId,actor.userId,ownRow.cycle_id,ownRow.target_id]);
        if (!assignment.rowCount) throw new ForbiddenException({code:'ASSIGNMENT_NOT_ACTIVE'});
      }
      if (ownRow.reviewer_id !== actor.userId) {
        throw new ForbiddenException({ code: 'NOT_REVIEW_OWNER' });
      }
      if (ownRow.status === 'WITHDRAWN') throw new ForbiddenException({code:'REVIEW_WITHDRAWN'});
      await this.assertPeerGate(actor, ownRow);
      if (ownRow.status === 'SUBMITTED') {
        // 已提交后原则上不再可改；但核验要求更正/退回补充时，原评价人需要能先改草稿再提交修订版
        const rev = await this.resolveRevisionRequest(client, actor, reviewId, ownRow);
        if (!rev.ok) {
          throw new BadRequestException({ code: 'REVIEW_ALREADY_SUBMITTED' });
        }
      }

      const template=await this.effectiveTemplate(client,ownRow);
      if((body as {templateId?:string}).templateId && (body as {templateId?:string}).templateId!==template[0].template_id)throw new BadRequestException({code:'TEMPLATE_MISMATCH'});
      const items=this.checkedItems(template,body.items??[],false);
      const dataJson: DraftPayload = {
        items: items.map((it) => ({ itemId: it.itemId, score: it.score, reason: it.reason ?? null })),
        overallReason: body.overallReason ?? null,
        comment: body.comment ?? null,
        nextPlan: body.nextPlan ?? null,
        readConfirmed: body.readConfirmed ?? false,
      };
      const upsert = await client.query<{ row_version: number }>(
        `INSERT INTO review_drafts
           (id, cycle_id, org_id, reviewer_id, target_id, kind, data_json, report_version_id, row_version)
         SELECT gen_random_uuid(), r.cycle_id, r.org_id, r.reviewer_id, r.target_id, r.kind,
                $2::jsonb, $3, 1
           FROM reviews r WHERE r.id = $1
         ON CONFLICT (cycle_id, reviewer_id, target_id, kind) DO UPDATE
           SET data_json = EXCLUDED.data_json,
               report_version_id = COALESCE(EXCLUDED.report_version_id, review_drafts.report_version_id),
               row_version = review_drafts.row_version + 1,
               updated_at = now()
         RETURNING row_version`,
        [reviewId, JSON.stringify(dataJson), body.reportVersionId ?? null],
      );
      return { rowVersion: upsert.rows[0].row_version };
    });
  }

  // ------------------ 提交 ------------------

  /** 首次提交（PRD §8.1） */
  async submitReview(
    actor: AuthContext,
    reviewId: string,
    body: SubmitBody | undefined,
    transactionClient?: PoolClient,
  ): Promise<RevisionResult> {
    const execute=async (client:PoolClient) => {
      const ownRow = await this.lockOwnReview(client, actor, reviewId);
      if (ownRow.status === 'SUBMITTED') {
        throw new BadRequestException({ code: 'REVIEW_ALREADY_SUBMITTED' });
      }
      return this.writeRevision(client, actor, reviewId, ownRow, body, null);
    };
    return transactionClient?execute(transactionClient):withTx(this.db,execute);
  }

  /**
   * 提交更正修订版（PRD §9.1：核验不提供直接改分，更正必须由**原评价人**形成修订版）。
   *
   * 前置条件：针对该评价「当前修订版」存在 OPEN 核验项，且其最新动作是要求原评价人处理
   * （SUGGEST_REVISION 建议更正 / REQUEST_SUPPLEMENT 退回补充），并在独立修订窗口内。
   * 修订不受周期 close_at 限制（校准期通常在截止之后），改由 revision_due_at 约束。
   */
  async submitRevision(
    actor: AuthContext,
    reviewId: string,
    body: SubmitBody | undefined,
    transactionClient?: PoolClient,
  ): Promise<RevisionResult> {
    const execute=async (client:PoolClient) => {
      const ownRow = await this.lockOwnReview(client, actor, reviewId);
      if (ownRow.status !== 'SUBMITTED') {
        throw new BadRequestException({ code: 'REVISION_NOT_REQUESTED', detail: 'review not submitted yet' });
      }
      const openCase = await this.resolveRevisionRequest(client, actor, reviewId, ownRow);
      if (!openCase.ok) throw new BadRequestException({ code: openCase.reason });
      return this.writeRevision(client, actor, reviewId, ownRow, body, {
        caseId: openCase.caseId,
        dueAt: openCase.dueAt,
      });
    };
    return transactionClient?execute(transactionClient):withTx(this.db,execute);
  }

  /** 锁定评价并校验归属（两种提交路径共用） */
  private async lockOwnReview(
    client: PoolClient,
    actor: AuthContext,
    reviewId: string,
  ): Promise<OwnReviewRow> {
    await this.lockResultForReview(client,actor,reviewId);
    const own = await client.query<OwnReviewRow>(
      `SELECT reviewer_id, target_id, cycle_id, org_id, kind, assignment_id, status
         FROM reviews WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [reviewId, actor.orgId],
    );
    if (!own.rowCount) throw new NotFoundException({ code: 'REVIEW_NOT_FOUND' });
    const ownRow = own.rows[0];
    if (ownRow.reviewer_id !== actor.userId) {
      throw new ForbiddenException({ code: 'NOT_REVIEW_OWNER' });
    }
    if (ownRow.kind === 'PEER') {
      const assignment=await client.query("SELECT id FROM assignments WHERE id=$1 AND org_id=$2 AND reviewer_id=$3 AND cycle_id=$4 AND target_id=$5 AND status='ACTIVE' FOR SHARE",[ownRow.assignment_id,actor.orgId,actor.userId,ownRow.cycle_id,ownRow.target_id]);
      if (!assignment.rowCount) throw new ForbiddenException({code:'ASSIGNMENT_NOT_ACTIVE'});
    }
    if(ownRow.status==='WITHDRAWN')throw new ForbiddenException({code:'REVIEW_WITHDRAWN'});
    return ownRow;
  }

  /**
   * 解析该评价当前是否存在「等原评价人处理」的修订请求。
   * 返回判别式结果而非抛错，便于两处调用方给出各自的语义：
   *  - 提交修订版：失败即报精确原因（无请求 / 非原作者 / 越权 / 窗口已过）
   *  - 保存草稿：失败时沿用历史错误码 REVIEW_ALREADY_SUBMITTED，避免破坏既有契约
   */
  private async resolveRevisionRequest(
    client: PoolClient,
    actor: AuthContext,
    reviewId: string,
    ownRow: OwnReviewRow,
  ): Promise<{ ok: true; caseId: string; dueAt: Date | null } | { ok: false; reason: string }> {
    const { rows } = await client.query<{
      id: string;
      revision_due_at: Date | null;
      latest_action: string | null;
    }>(
      `SELECT cc.id, cc.revision_due_at,
              (SELECT ca.action FROM calibration_actions ca
                WHERE ca.case_id = cc.id
                ORDER BY ca.created_at DESC, ca.id DESC
                LIMIT 1) AS latest_action
         FROM calibration_cases cc
         JOIN reviews r ON r.current_revision_id = cc.review_revision_id
        WHERE r.id = $1 AND cc.status = 'OPEN' AND cc.invalidated_at IS NULL`,
      [reviewId],
    );
    const hit = rows.find((x) => isRevisionRequested(x.latest_action));
    if (!hit) return { ok: false, reason: 'REVISION_NOT_REQUESTED' };

    const blocked = checkRevisionSubmission({
      latestAction: hit.latest_action,
      dueAt: hit.revision_due_at,
      now: new Date(),
      actorId: actor.userId,
      reviewerId: ownRow.reviewer_id,
      targetId: ownRow.target_id,
      kind: ownRow.kind,
    });
    if (blocked) return { ok: false, reason: blocked };
    return { ok: true, caseId: hit.id, dueAt: hit.revision_due_at };
  }

  /** 共享写入：校验 + 落一条新修订版（首次提交与更正修订共用） */
  private async writeRevision(
    client: PoolClient,
    actor: AuthContext,
    reviewId: string,
    ownRow: OwnReviewRow,
    body: SubmitBody | undefined,
    revisionCase: { caseId: string; dueAt: Date | null } | null,
  ): Promise<RevisionResult> {
      const isRevision = revisionCase !== null;
      if (!isRevision) await this.assertPeerGate(actor, ownRow);
      // Serialize with uploads and freeze this exact package in the same transaction.
      // If evaluation validation fails, both the lock and snapshot roll back.
      const materialSnapshot = await freezeReviewMaterials(client, ownRow.org_id, ownRow.cycle_id, ownRow.target_id);

      const template=await this.effectiveTemplate(client,ownRow);
      // 取草稿（review_drafts 按 cycle+reviewer+target+kind 索引，无 review_id 列）
      const draft = await client.query<{ data_json: DraftPayload; report_version_id: string | null }>(
        `SELECT d.data_json, d.report_version_id FROM review_drafts d
           JOIN reviews r ON r.cycle_id = d.cycle_id AND r.reviewer_id = d.reviewer_id
              AND r.target_id = d.target_id AND r.kind = d.kind
          WHERE r.id = $1`,
        [reviewId],
      );
      const payload: DraftPayload = draft.rowCount
        ? draft.rows[0].data_json
        : (body?.payload ?? { items: [], overallReason: null, comment: null, nextPlan: null, readConfirmed: false });
      if (!payload.readConfirmed) {
        throw new BadRequestException({ code: 'READ_CONFIRM_REQUIRED' });
      }
      if((payload as {templateId?:string}).templateId && (payload as {templateId?:string}).templateId!==template[0].template_id)throw new BadRequestException({code:'TEMPLATE_MISMATCH'});
      const items=this.checkedItems(template,payload.items,true);
      const scoreBp=reviewScoreBp(template,items);

      // ---- PRD §8.1：评价截止后不可提交（草稿仍可保存）----
      // 更正修订走独立窗口（校准期一般在 close_at 之后），不受周期截止约束
      if (isRevision) {
        const state=await client.query('SELECT status FROM cycles WHERE id=$1 AND org_id=$2',[ownRow.cycle_id,actor.orgId]);
        if (!state.rowCount || ['PAUSED','CANCELLED'].includes(state.rows[0].status)) throw new BadRequestException({code:'REVIEW_PERIOD_CLOSED'});
      }
      if (!isRevision) {
        const cyc = await client.query<{ status: string; close_at: Date | null; self_close_at: Date | null }>(
          `SELECT status, close_at, self_close_at FROM cycles WHERE id = $1`,
          [ownRow.cycle_id],
        );
        const cycleRow = cyc.rows[0];
        const supplemental=ownRow.kind==='PEER'&&(await client.query(`SELECT 1 FROM assignments a
          JOIN users authorizer ON authorizer.id=a.supplement_authorized_by AND authorizer.org_id=a.org_id
          WHERE a.id=$1 AND a.org_id=$2 AND a.cycle_id=$3 AND a.reviewer_id=$4 AND a.target_id=$5
            AND a.status='ACTIVE' AND a.source_type='REPLACEMENT' AND a.replaces_id IS NOT NULL
            AND a.supplement_authorized_by IS NOT NULL AND a.supplement_due_at>now()`,
          [ownRow.assignment_id,actor.orgId,ownRow.cycle_id,actor.userId,ownRow.target_id])).rowCount;
        if (!cycleRow || (!supplemental && cycleRow.status !== 'REVIEWING') || (supplemental && !['REVIEWING','CALIBRATING','PARTIALLY_PUBLISHED'].includes(cycleRow.status))) {
          throw new BadRequestException({
            code: 'REVIEW_PERIOD_CLOSED',
            detail: `cycle status is ${cycleRow?.status ?? 'UNKNOWN'}`,
          });
        }
        if (!supplemental && cycleRow.close_at && Date.now() >= new Date(cycleRow.close_at).getTime()) {
          throw new BadRequestException({ code: 'REVIEW_PERIOD_CLOSED', detail: 'close_at passed' });
        }
        // ---- 自评/他评双窗口（PRD：先完成统一自评，再开放他评）----
        // self_close_at 为空时退回单窗口旧行为
        if (!supplemental && cycleRow.self_close_at) {
          const selfClose = new Date(cycleRow.self_close_at).getTime();
          if (ownRow.kind === 'SELF' && Date.now() >= selfClose) {
            throw new BadRequestException({ code: 'REVIEW_PERIOD_CLOSED', detail: 'self_close_at passed' });
          }
          if (ownRow.kind === 'PEER' && Date.now() < selfClose) {
            throw new BadRequestException({ code: 'PEER_REVIEW_NOT_OPEN', detail: 'self review phase in progress' });
          }
        }
      }

      // ---- PRD §8.3：高低分理由与字数/比例校验 ----
      const rs = await client.query<{ config_json: unknown }>(
        `SELECT r.config_json FROM rulesets r
           JOIN cycles c ON c.ruleset_id = r.id
          WHERE c.id = $1`,
        [ownRow.cycle_id],
      );
      const thresholds = parseReasonThresholds(rs.rows[0]?.config_json);
      if(thresholds.policy==='prd'&&scoreBp>=thresholds.highBp){
        const versionId=materialSnapshot?.primaryVersionId;
        const valid=versionId?await client.query(`SELECT 1 FROM report_versions WHERE id=$1 AND org_id=$2 AND scan_status='PASSED' AND preview_status='READY'`,[versionId,ownRow.org_id]):null;
        if(!valid?.rowCount)throw new BadRequestException({code:'HIGH_SCORE_REPORT_REQUIRED'});
      }
      // 高分比例只算他评，且必须**包含本次拟提交记录**（PRD §8.3）
      // 排除本评价自身：修订时它的旧版本仍在 SUBMITTED 状态，不应参与比例
      let peerScoresIncludingThis: number[] = [];
      if (ownRow.kind === 'PEER') {
        const hist = await client.query<{ score_bp: number }>(
          `SELECT rv.score_bp
             FROM reviews r
             JOIN review_revisions rv ON rv.id = r.current_revision_id
            WHERE r.cycle_id = $1 AND r.reviewer_id = $2 AND r.id <> $3
              AND r.kind = 'PEER' AND ${effectiveReviewSql('r','rv')}`,
          [ownRow.cycle_id, actor.userId, reviewId],
        );
        peerScoresIncludingThis = [...hist.rows.map((x) => x.score_bp), scoreBp];
      }
      const reasonViolations = validateSubmitReasons(
        {
          kind: ownRow.kind,
          items: items.map((it) => ({ itemId: it.itemId, score: it.score!, reason: it.reason ?? null })),
          overallReason: payload.overallReason ?? null,
          scoreBp,
          peerScoreBpIncludingThis: peerScoresIncludingThis,
        },
        thresholds,
      );
      if (reasonViolations.length) {
        throw new BadRequestException({
          code: reasonViolations[0].code,
          violations: reasonViolations,
        });
      }

      const maxRev = await client.query<{ max: number | null }>(
        `SELECT MAX(revision_no) AS max FROM review_revisions WHERE review_id = $1`,
        [reviewId],
      );
      const nextNo = (maxRev.rows[0].max ?? 0) + 1;

      const insRev = await client.query<{ id: string }>(
        `INSERT INTO review_revisions
           (id, org_id, review_id, revision_no, report_version_id, template_id, score_bp,
            overall_reason, comment, next_plan, read_confirmed, submitted_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, now())
         RETURNING id`,
        [
          ownRow.org_id, reviewId, nextNo,
          materialSnapshot?.primaryVersionId ?? (draft.rowCount ? draft.rows[0].report_version_id : null),
          template[0].template_id, // Every new revision records its exact template.
          scoreBp, payload.overallReason, payload.comment, payload.nextPlan,
        ],
      );
      const revisionId = insRev.rows[0].id;
      if (materialSnapshot) {
        await client.query('INSERT INTO review_material_snapshots(revision_id,report_id,versions_json) VALUES($1,$2,$3::jsonb)',
          [revisionId,materialSnapshot.reportId,JSON.stringify(materialSnapshot.versions)]);
      }

      for (const it of items) {
        await client.query(
          `INSERT INTO review_item_scores (id, revision_id, org_id, item_id, score, reason)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [revisionId, ownRow.org_id, it.itemId, it.score, it.reason ?? null],
        );
      }

      await client.query(
        `UPDATE reviews SET status = 'SUBMITTED', current_revision_id = $1 WHERE id = $2`,
        [revisionId, reviewId],
      );
      await client.query(
        `DELETE FROM review_drafts d USING reviews r
          WHERE r.id = $1 AND d.cycle_id = r.cycle_id AND d.reviewer_id = r.reviewer_id
            AND d.target_id = r.target_id AND d.kind = r.kind`,
        [reviewId],
      );

      // reviewer_cycle_stats 累计（仅首次提交；修订不新增有效份数）
      // 注：该表是 denormalized 缓存，高分比例校验以 reviews/review_revisions 实时计算为准
      if (!isRevision) {
        await client.query(
          `INSERT INTO reviewer_cycle_stats (id, cycle_id, org_id, reviewer_id, effective_count, high_count)
           VALUES (gen_random_uuid(), $1, $2, $3, 1, $4)
           ON CONFLICT (cycle_id, reviewer_id) DO UPDATE
             SET effective_count = reviewer_cycle_stats.effective_count + 1,
                 high_count = reviewer_cycle_stats.high_count + EXCLUDED.high_count,
                 updated_at = now()`,
          [ownRow.cycle_id, ownRow.org_id, actor.userId, scoreBp >= thresholds.highBp ? 1 : 0],
        );
      }

      // 更正修订：关掉该核验项并留痕（核验扫描若仍触发，会对新修订版重新开项）
      if (revisionCase) {
        await client.query(
          `INSERT INTO calibration_actions (id, case_id, org_id, actor_id, action, reason)
           VALUES (gen_random_uuid(), $1, $2, $3, 'REVISION_SUBMITTED', $4)`,
          [revisionCase.caseId, ownRow.org_id, actor.userId, `原评价人提交第 ${nextNo} 版修订`],
        );
        await client.query(
          `UPDATE calibration_cases SET status = 'RESOLVED' WHERE id = $1`,
          [revisionCase.caseId],
        );
        await client.query(
          `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
           VALUES ($1, $2, 'review.revise', 'review', $3, $4)`,
          [ownRow.org_id, actor.userId, reviewId, `revision_no=${nextNo}`],
        );
      }

      await invalidateTargetBuilds(client,ownRow.cycle_id,ownRow.target_id);
      const scan=await cycleThresholds(client,ownRow.cycle_id);
      await createTriggers(client,ownRow.cycle_id,ownRow.org_id,scan.thresholds);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason)
        VALUES($1,$2,'review.submit','review',$3,$4)`,[ownRow.org_id,actor.userId,reviewId,`revision_no=${nextNo}`]);
      return { revisionId, revisionNo: nextNo, scoreBp };
  }
}

// ============================================================
// helpers
// ============================================================

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
