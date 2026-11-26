import { effectiveReviewSql } from '../effective-review.js';
import { reviewScoreBp } from '../review-score.js';
import { createTriggers, cycleThresholds } from '../calibration/scan.js';
/**
 * 结果构建/发布的数据库操作（api results 模块与 worker 相位共用）。
 * 只接收 DbClient，不自行开事务；纯算法在 build.ts。
 */

import type { DbClient } from '../db.js';
import { buildResult, RESULT_FORMULA_VERSION, type ResultSourceReview } from './build.js';

export interface BuildOutcome {
  targetId: string;
  status: 'BUILT' | 'REUSED';
  buildId: string;
  exactScore: number | null;
  selfScore: number | null;
  warnings: string[];
}

export interface BuildInputs {
  rulesetChecksum: string;
  assignmentVersion: number;
  reportVersionId: string | null;
  feedbackVersion: number;
  peers: ResultSourceReview[];
  self: ResultSourceReview | null;
  blockingReasons: string[];
}

/** Acquire before review/case/build row locks; material writers retain their package lock. */
export async function lockResultCycle(client:DbClient,cycleId:string):Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('review-results:' || $1,0))",[cycleId]);
}
export async function invalidateTargetBuilds(client:DbClient,cycleId:string,targetId:string):Promise<void> {
  await client.query("UPDATE result_builds SET status='STALE' WHERE cycle_id=$1 AND target_id=$2 AND status IN ('BUILT','APPROVED')",[cycleId,targetId]);
}
export async function scanResultCycle(client:DbClient,cycleId:string,orgId:string) {
  const config=await cycleThresholds(client,cycleId);
  return createTriggers(client,cycleId,orgId,config.thresholds);
}
export class ResultNotReadyError extends Error {
  constructor(readonly reasons:string[]){super('RESULT_INCOMPLETE');}
}

/** 锁周期行（防并发状态迁移）；返回 { id, status, ruleset_id, org_id } */
export async function lockCycle(
  client: DbClient,
  cycleId: string,
): Promise<{ id: string; status: string; ruleset_id: string; org_id: string }> {
  await lockResultCycle(client,cycleId);
  const { rows } = await client.query<{ id: string; status: string; ruleset_id: string; org_id: string }>(
    `SELECT id, status, ruleset_id, org_id FROM cycles WHERE id = $1 FOR UPDATE`,
    [cycleId],
  );
  if (!rows[0]) throw new Error(`cycle_not_found:${cycleId}`);
  return rows[0];
}

/**
 * 完整性检查（PRD §9.2）：返回原因列表，空数组表示完整。
 *   - 全部 ACTIVE assignment 都有 SUBMITTED 他评
 *   - 自评已提交
 *   - 该目标相关核验项无 OPEN
 */
export async function completenessCheck(
  client: DbClient,
  cycleId: string,
  targetId: string,
): Promise<string[]> {
  const reasons:string[]=[];
  const participant=await client.query("SELECT user_id FROM cycle_participants WHERE cycle_id=$1 AND user_id=$2 AND eligibility='ELIGIBLE'",[cycleId,targetId]);
  if(!participant.rowCount)return ['TARGET_NOT_ELIGIBLE'];
  const missing=await client.query<{n:string}>(`SELECT count(*) AS n FROM assignments a
    WHERE a.cycle_id=$1 AND a.target_id=$2 AND a.status='ACTIVE' AND NOT EXISTS (
      SELECT 1 FROM reviews r JOIN review_revisions rr ON rr.id=r.current_revision_id
      WHERE r.assignment_id=a.id AND ${effectiveReviewSql('r','rr')})`,[cycleId,targetId]);
  if(Number(missing.rows[0].n)>0)reasons.push(`MISSING_PEER_REVIEWS:${missing.rows[0].n}`);
  const inputs=await collectBuildInputs(client,cycleId,targetId);
  reasons.push(...inputs.blockingReasons);
  if(!inputs.peers.length)reasons.push('NO_PEER_REVIEWS');
  // Preserve the existing self-submission readiness rule without using self as a score weight.
  if(!inputs.self)reasons.push('SELF_REVIEW_NOT_SUBMITTED');
  const open=await client.query<{n:string}>(`SELECT count(*) AS n FROM calibration_cases cc
    JOIN review_revisions rr ON rr.id=cc.review_revision_id JOIN reviews r ON r.id=rr.review_id
    WHERE cc.cycle_id=$1 AND r.target_id=$2 AND r.current_revision_id=rr.id AND cc.status='OPEN' AND cc.invalidated_at IS NULL`,[cycleId,targetId]);
  if(Number(open.rows[0].n)>0)reasons.push(`OPEN_CALIBRATION_CASES:${open.rows[0].n}`);
  return [...new Set(reasons)];
}

/** 收集构建输入（build 与 hash 重验共用同一查询，保证一致） */
export async function collectBuildInputs(
  client: DbClient,
  cycleId: string,
  targetId: string,
): Promise<BuildInputs> {
  const cyc = await client.query<{ ruleset_checksum: string; assignment_version: number | null }>(
    `SELECT r.checksum AS ruleset_checksum, c.assignment_version
       FROM cycles c JOIN rulesets r ON r.id = c.ruleset_id WHERE c.id = $1`,
    [cycleId],
  );
  if (!cyc.rowCount) throw new Error(`cycle_not_found:${cycleId}`);

  const report = await client.query<{ id: string }>(
    `SELECT rv.id FROM report_versions rv
       JOIN monthly_reports mr ON mr.id = rv.report_id
      WHERE mr.cycle_id = $1 AND mr.user_id = $2
      ORDER BY rv.created_at DESC LIMIT 1`,
    [cycleId, targetId],
  );

  const feedback = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM result_feedback f
       JOIN result_builds b ON b.id = f.result_build_id
      WHERE b.cycle_id = $1 AND b.target_id = $2`,
    [cycleId, targetId],
  );

  const revisions=await client.query<{
    revision_id:string;score_bp:number;kind:'SELF'|'PEER';template_id:string|null;expected_template_id:string|null;
    items:Array<{itemId:string;score:number}>|null;template_items:Array<{id:string;weight:number}>|null;
  }>(`SELECT rr.id AS revision_id,rr.score_bp,r.kind,rr.template_id,tv.id AS expected_template_id,
      (SELECT json_agg(json_build_object('itemId',s.item_id,'score',s.score)) FROM review_item_scores s WHERE s.revision_id=rr.id) AS items,
      (SELECT json_agg(json_build_object('id',ti.id,'weight',ti.weight)) FROM template_items ti WHERE ti.template_id=tv.id) AS template_items
    FROM reviews r JOIN review_revisions rr ON rr.id=r.current_revision_id AND rr.org_id=r.org_id
    JOIN cycle_participants cp ON cp.cycle_id=r.cycle_id AND cp.user_id=r.target_id AND cp.org_id=r.org_id AND cp.eligibility='ELIGIBLE'
    JOIN cycles c ON c.id=r.cycle_id AND c.org_id=r.org_id
    LEFT JOIN template_versions tv ON tv.ruleset_id=c.ruleset_id AND tv.org_id=c.org_id
      AND ((r.kind='SELF' AND tv.role_code='SELF') OR (r.kind='PEER' AND tv.id=cp.template_id))
    WHERE r.cycle_id=$1 AND r.target_id=$2 AND ${effectiveReviewSql('r','rr')}`, [cycleId,targetId]);
  const peers:ResultSourceReview[]=[];let self:ResultSourceReview|null=null;
  const blockingReasons:string[]=[];
  for(const r of revisions.rows){
    try {
      if(!r.expected_template_id || r.template_id && r.template_id!==r.expected_template_id)throw new Error('TEMPLATE_MISMATCH');
      if(reviewScoreBp(r.template_items??[],r.items)!==r.score_bp)throw new Error('SCORE_MISMATCH');
      const src={revisionId:r.revision_id,scoreBp:r.score_bp,items:r.items??[]};
      if(r.kind==='SELF')self=src;else peers.push(src);
    } catch {blockingReasons.push(`INVALID_REVIEW:${r.revision_id}`);}
  }

  return {
    rulesetChecksum: cyc.rows[0].ruleset_checksum,
    assignmentVersion: cyc.rows[0].assignment_version ?? 1,
    reportVersionId: report.rowCount ? report.rows[0].id : null,
    feedbackVersion: Number(feedback.rows[0].n),
    peers,
    self,
    blockingReasons,
  };
}

/** 构建单个 target 的 result_build（调用方负责锁周期与完整性检查） */
export async function buildOne(
  client: DbClient,
  cycleId: string,
  orgId: string,
  targetId: string,
): Promise<BuildOutcome> {
  await lockResultCycle(client,cycleId);
  const reasons=await completenessCheck(client,cycleId,targetId);
  if(reasons.length)throw new ResultNotReadyError(reasons);
  const inputs = await collectBuildInputs(client, cycleId, targetId);
  const draft = buildResult({ cycleId, targetId, ...inputs });

  // 旧 APPROVED build 输入已变：新 build 建立时旧的批准即失效（技术文档 §10）
  await client.query(
    `UPDATE result_builds SET status = 'STALE'
      WHERE cycle_id = $1 AND target_id = $2 AND status IN ('BUILT','APPROVED') AND input_hash <> $3`,
    [cycleId, targetId, draft.inputHash],
  );

  // xmax=0 表示新插入；冲突更新走 xmax<>0（复用）
  const ins = await client.query<{ id: string; inserted: boolean }>(
    `INSERT INTO result_builds
       (id, cycle_id, org_id, target_id, input_hash, formula_version, exact_score, dimension_json, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'BUILT')
     ON CONFLICT (cycle_id, target_id, input_hash) DO UPDATE
       SET status = CASE WHEN result_builds.status IN ('APPROVED','PUBLISHED') THEN result_builds.status ELSE 'BUILT' END
     RETURNING id, (xmax = 0) AS inserted`,
    [cycleId, orgId, targetId, draft.inputHash, draft.formulaVersion, draft.exactScore,
      JSON.stringify({...draft.dimensionJson,selfScore:draft.selfScore,precision:{individualScoreDecimals:2,aggregateDecimals:4,displayDecimals:2,rounding:'HALF_UP'}})],
  );
  const buildId = ins.rows[0].id;
  const reused = !ins.rows[0].inserted;

  for (const revId of draft.sourceRevisionIds) {
    await client.query(
      `INSERT INTO result_source_reviews (id, result_build_id, review_revision_id)
       VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT (result_build_id, review_revision_id) DO NOTHING`,
      [buildId, revId],
    );
  }

  return {
    targetId,
    status: reused ? 'REUSED' : 'BUILT',
    buildId,
    exactScore: draft.exactScore,
    selfScore: draft.selfScore,
    warnings: draft.warnings,
  };
}

/** 重算当前输入 hash（审批/发布事务内重验；技术文档 §10） */
export async function currentInputHash(
  client: DbClient,
  cycleId: string,
  targetId: string,
  recordedFormulaVersion: string,
): Promise<string | null> {
  if(recordedFormulaVersion!==RESULT_FORMULA_VERSION)return null;
  const inputs=await collectBuildInputs(client,cycleId,targetId);
  if(inputs.blockingReasons.length||!inputs.peers.length)return null;
  return buildResult({cycleId,targetId,...inputs}).inputHash;
}

/**
 * 发布核心（api publish 端点与 worker PUBLISH 相位共用）。
 * 前置：build 已有 APPROVED 批准；本函数重验 input_hash 后写 published_results
 * 与 outbox，并推进周期发布状态。返回 null 表示输入已变（RESULT_STALE）。
 */
export async function publishBuildTx(
  client: DbClient,
  orgId: string,
  buildId: string,
): Promise<{ publicationId: string; targetId: string; publicationVersion: number; exactScore: number | null } | null> {
  const ref=await client.query<{cycle_id:string}>('SELECT cycle_id FROM result_builds WHERE id=$1 AND org_id=$2',[buildId,orgId]);
  if(!ref.rowCount)throw new Error(`build_not_found:${buildId}`);
  await lockResultCycle(client,ref.rows[0].cycle_id);
  const b = await client.query<{
    id: string; cycle_id: string; target_id: string; input_hash: string;
    formula_version: string; exact_score: string | null; dimension_json: unknown; status: string;
  }>(
    `SELECT id, cycle_id, target_id, input_hash, formula_version, exact_score, dimension_json, status
       FROM result_builds WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [buildId, orgId],
  );
  if (!b.rowCount) throw new Error(`build_not_found:${buildId}`);
  const build = b.rows[0];
  if (build.status === 'PUBLISHED') throw new Error('already_published');
  if (build.status !== 'APPROVED') throw new Error('approval_required');

  const approval=await client.query<{decision:string;approver_id:string}>(`SELECT decision,approver_id FROM result_approvals WHERE result_build_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[buildId]);
  if(approval.rows[0]?.decision!=='APPROVED'||approval.rows[0]?.approver_id===build.target_id)throw new Error('approval_required');
  await scanResultCycle(client,build.cycle_id,orgId);
  const reasons=await completenessCheck(client,build.cycle_id,build.target_id);
  const hash=await currentInputHash(client,build.cycle_id,build.target_id,build.formula_version);
  if(reasons.length || hash===null || hash!==build.input_hash || build.formula_version!==RESULT_FORMULA_VERSION || build.exact_score===null){
    await client.query("UPDATE result_builds SET status='STALE' WHERE id=$1 AND status<>'PUBLISHED'",[buildId]);
    return null;
  }

  const dim = (build.dimension_json ?? {}) as {
    peerItems?: Array<{ itemId: string; avgScore: number }>;
    selfItems?: Array<{ itemId: string; avgScore: number }>;
    peerCount?: number;
    selfPresent?: boolean;
    selfScore?: number|null;
  };
  const items = await itemLabels(client, build.cycle_id);
  const payload = {
    month: await cycleMonth(client, build.cycle_id),
    self_score: dim.selfScore ?? null,
    precision: {aggregate_decimals:4,display_decimals:2,rounding:'HALF_UP'},
    final_score: build.exact_score === null ? null : Number(build.exact_score),
    peer_items: (dim.peerItems ?? []).map((i) => ({
      label: items.get(i.itemId) ?? i.itemId,
      avg_score: i.avgScore,
    })),
    self_items: (dim.selfItems ?? []).map((i) => ({
      label: items.get(i.itemId) ?? i.itemId,
      avg_score: i.avgScore,
    })),
    peer_count: dim.peerCount ?? 0,
    self_present: dim.selfPresent ?? false,
    formula_version: build.formula_version,
  };

  const prev = await client.query<{ id: string; v: number }>(
    `SELECT id, publication_version AS v FROM published_results
      WHERE cycle_id = $1 AND target_id = $2
      ORDER BY publication_version DESC LIMIT 1`,
    [build.cycle_id, build.target_id],
  );
  const nextVersion = prev.rowCount ? prev.rows[0].v + 1 : 1;

  const ins = await client.query<{ id: string }>(
    `INSERT INTO published_results
       (id, cycle_id, org_id, target_id, publication_version, result_build_id, payload_json, supersedes_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [build.cycle_id, orgId, build.target_id, nextVersion, buildId,
      JSON.stringify(payload), prev.rowCount ? prev.rows[0].id : null],
  );

  await client.query(`UPDATE result_builds SET status = 'PUBLISHED' WHERE id = $1`, [buildId]);
  await client.query(
    `INSERT INTO notification_outbox (id, org_id, event_key, recipient_id, channel, payload_json)
     VALUES (gen_random_uuid(), $1, $2, $3, 'IN_APP', $4)
     ON CONFLICT (event_key, recipient_id, channel) DO NOTHING`,
    [orgId, `result.published:${build.cycle_id}:${build.target_id}:v${nextVersion}`, build.target_id,
      JSON.stringify({ type: 'RESULT_PUBLISHED', cycle_id: build.cycle_id })],
  );

  await refreshCyclePublishState(client, build.cycle_id);

  return {
    publicationId: ins.rows[0].id,
    targetId: build.target_id,
    publicationVersion: nextVersion,
    exactScore: build.exact_score === null ? null : Number(build.exact_score),
  };
}

/** 分批发布状态推进：全部 participant 均有发布记录 → PUBLISHED（PRD §9.2） */
export async function refreshCyclePublishState(client: DbClient, cycleId: string): Promise<void> {
  const current=(await client.query<{status:string}>('SELECT status FROM cycles WHERE id=$1 FOR UPDATE',[cycleId])).rows[0];
  if(!current||!['CALIBRATING','PARTIALLY_PUBLISHED','PUBLISHED'].includes(current.status))return;
  const updated=await client.query<{status:string}>(`UPDATE cycles SET status=CASE WHEN NOT EXISTS (
    SELECT 1 FROM cycle_participants cp WHERE cp.cycle_id=$1 AND cp.eligibility='ELIGIBLE' AND NOT EXISTS (
      SELECT 1 FROM published_results p WHERE p.cycle_id=$1 AND p.target_id=cp.user_id)) THEN 'PUBLISHED' ELSE 'PARTIALLY_PUBLISHED' END,
    row_version=row_version+1 WHERE id=$1 AND EXISTS(SELECT 1 FROM published_results p WHERE p.cycle_id=$1) RETURNING status`,[cycleId]);
  if(updated.rows[0]&&updated.rows[0].status!==current.status)await client.query(`INSERT INTO cycle_state_log(cycle_id,from_status,to_status,actor_id,reason)
    VALUES($1,$2,$3,NULL,'publication: refreshed eligible participant completion')`,[cycleId,current.status,updated.rows[0].status]);
}

async function itemLabels(client: DbClient, cycleId: string): Promise<Map<string, string>> {
  const { rows } = await client.query<{ item_id: string; label: string }>(
    `SELECT ti.id AS item_id, ti.label
       FROM template_items ti
       JOIN template_versions tv ON tv.id = ti.template_id
       JOIN cycles c ON c.ruleset_id = tv.ruleset_id
      WHERE c.id = $1`,
    [cycleId],
  );
  return new Map(rows.map((r: { item_id: string; label: string }) => [r.item_id, r.label]));
}

async function cycleMonth(client: DbClient, cycleId: string): Promise<string> {
  const { rows } = await client.query<{ m: string }>(
    `SELECT to_char(month, 'YYYY-MM') AS m FROM cycles WHERE id = $1`,
    [cycleId],
  );
  return rows[0].m;
}
