import { effectiveReviewSql } from '../effective-review.js';
/**
 * 核验扫描的数据库操作（api 手动补偿端点与 worker CLOSE 相位共用）。
 *
 * 这些函数只接收 DbClient、不自行开事务：调用方负责事务边界与重试。
 * 纯判定逻辑在 triggers.ts；这里是 SQL 编排。
 */

import { detectCalibrationTriggers, type CalibrationThresholds } from './triggers.js';
import type { DbClient } from '../db.js';
import { createHash } from 'node:crypto';
import { assessSelfPeerDifference } from './difference.js';
import { parseReasonThresholds, validateSubmitReasons } from '../reason-rules.js';

/** 为周期内每份已提交他评建立核验项（PRD §8.3 全期扫描口径）。
 *  只看 PEER（高分比例只计他评）；UNIQUE(review_revision_id, reason_code) 保证幂等。 */
export async function createTriggers(
  client: DbClient,
  cycleId: string,
  orgId: string,
  thresholds: CalibrationThresholds,
): Promise<{ created: number; skipped: number }> {
  const highBp = thresholds.highBp;

  const rows = await client.query<{
    revision_id: string;
    score_bp: number | null;
    reviewer_id: string;
    kind:'SELF'|'PEER';
    overall_reason:string|null;
    items: Array<{ itemId: string; score: number; reason: string | null }> | null;
    reviewer_peer_count: string;
    reviewer_high_count: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (rr.review_id) rr.id AS revision_id, rr.review_id,
              rr.score_bp, rr.overall_reason, rv.reviewer_id, rv.kind
         FROM review_revisions rr
         JOIN reviews rv ON rv.id = rr.review_id AND rv.kind IN ('SELF','PEER')
        WHERE rv.cycle_id = $1 AND rv.org_id=$3 AND ${effectiveReviewSql('rv','rr')}
        ORDER BY rr.review_id, rr.revision_no DESC
     )
     SELECT l.revision_id, l.score_bp, l.overall_reason, l.reviewer_id, l.kind,
            (SELECT json_agg(json_build_object('itemId', s.item_id, 'score', s.score, 'reason', s.reason))
               FROM review_item_scores s WHERE s.revision_id = l.revision_id) AS items,
            (SELECT count(*) FROM latest l2 WHERE l2.reviewer_id = l.reviewer_id AND l2.kind='PEER') AS reviewer_peer_count,
            (SELECT count(*) FROM latest l3
              WHERE l3.reviewer_id = l.reviewer_id AND l3.kind='PEER' AND l3.score_bp >= $2) AS reviewer_high_count
       FROM latest l`,
    [cycleId, highBp,orgId],
  );

  let created = 0;
  let skipped = 0;
  const ruleRow=(await client.query<{config:unknown}>(`SELECT r.config_json AS config FROM cycles c JOIN rulesets r ON r.id=c.ruleset_id AND r.org_id=c.org_id WHERE c.id=$1 AND c.org_id=$2`,[cycleId,orgId])).rows[0];
  const reasonThresholds=parseReasonThresholds(ruleRow?.config);
  for (const r of rows.rows) {
    if(r.kind==='SELF'&&reasonThresholds.policy!=='prd')continue;
    if (r.score_bp === null) {
      skipped++;
      continue;
    }
    const triggers = detectCalibrationTriggers({
      scoreBp: r.score_bp,
      includeItemExcellent:reasonThresholds.policy==='prd',
      itemScores: r.items ?? [],
      reviewerCyclePeerCount: r.kind==='PEER'?Number(r.reviewer_peer_count):0,
      reviewerCycleHighCount: r.kind==='PEER'?Number(r.reviewer_high_count):0,
      thresholds,
    });
    if(reasonThresholds.policy==='prd'){
      const violations=validateSubmitReasons({kind:r.kind,items:r.items??[],scoreBp:r.score_bp,overallReason:r.overall_reason},reasonThresholds);
      if(violations.length)triggers.push({reasonCode:'MISSING_REASON',detail:violations.map(v=>`${v.itemId??'整体评价'}: ${v.detail}`).join('；')});
    }
    for (const t of triggers) {
      const ins = await client.query(
        `INSERT INTO calibration_cases
           (id, cycle_id, org_id, review_revision_id, reason_code, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'OPEN')
         ON CONFLICT (review_revision_id, reason_code) WHERE reason_code <> 'SELF_PEER_DIFF' DO NOTHING
         RETURNING id`,
        [cycleId, orgId, r.revision_id, t.reasonCode],
      );
      if (ins.rowCount) {
        created++;
        await client.query(
          `INSERT INTO calibration_actions (id, case_id, org_id, actor_id, action, reason)
           VALUES (gen_random_uuid(), $1, $2, $3, 'OPEN', $4)`,
          [ins.rows[0].id, orgId, r.reviewer_id, t.detail],
        );
      } else {
        skipped++;
      }
    }
  }
  const config=(await client.query<{config: {calibration_difference?: {min_reviews?:number; medium_points?:number; high_points?:number}}}>(`SELECT r.config_json AS config FROM cycles c JOIN rulesets r ON r.id=c.ruleset_id AND r.org_id=c.org_id WHERE c.id=$1 AND c.org_id=$2`,[cycleId,orgId])).rows[0]?.config?.calibration_difference;
  const diffRule=config&&typeof config.min_reviews==='number'&&typeof config.medium_points==='number'&&typeof config.high_points==='number'?{minReviews:config.min_reviews,mediumPoints:config.medium_points,highPoints:config.high_points}:undefined;
  await client.query(`UPDATE calibration_cases c SET invalidated_at=now() FROM review_revisions v JOIN reviews r ON r.id=v.review_id WHERE c.review_revision_id=v.id AND c.cycle_id=$1 AND c.org_id=$2 AND c.invalidated_at IS NULL AND NOT (${effectiveReviewSql('r','v')})`,[cycleId,orgId]);
  const inputs=await client.query<{target_id:string;self_revision:string;self_bp:number;peer_ids:string[];peer_scores:number[]}>(`SELECT self.target_id,sv.id AS self_revision,sv.score_bp AS self_bp,
      array_agg(pv.id ORDER BY pv.id) FILTER (WHERE pv.id IS NOT NULL) AS peer_ids,
      array_agg(pv.score_bp ORDER BY pv.id) FILTER (WHERE pv.id IS NOT NULL) AS peer_scores
    FROM reviews self JOIN review_revisions sv ON sv.id=self.current_revision_id
    LEFT JOIN reviews peer ON peer.cycle_id=self.cycle_id AND peer.org_id=self.org_id AND peer.target_id=self.target_id AND peer.kind='PEER'
    LEFT JOIN review_revisions pv ON pv.id=peer.current_revision_id AND ${effectiveReviewSql('peer','pv')}
    WHERE self.cycle_id=$1 AND self.org_id=$2 AND self.kind='SELF' AND ${effectiveReviewSql('self','sv')}
    GROUP BY self.target_id,sv.id,sv.score_bp`,[cycleId,orgId]);
  for(const input of inputs.rows){
    const ids=input.peer_ids??[],scores=(input.peer_scores??[]).map(Number);
    const result=assessSelfPeerDifference(Number(input.self_bp),scores,diffRule);
    const hash=createHash('sha256').update(JSON.stringify({self:input.self_revision,peers:ids,rule:diffRule})).digest('hex');
    await client.query(`UPDATE calibration_cases c SET invalidated_at=now() FROM review_revisions v JOIN reviews r ON r.id=v.review_id WHERE c.review_revision_id=v.id AND c.cycle_id=$1 AND c.org_id=$2 AND c.reason_code='SELF_PEER_DIFF' AND r.target_id=$3 AND c.invalidated_at IS NULL AND (c.input_hash<>$4 OR $5::boolean)`,[cycleId,orgId,input.target_id,hash,result.status!=='TRIGGERED']);
    if(result.status!=='TRIGGERED')continue;
    const evidence={selfBp:Number(input.self_bp),peerAverageBp:result.peerAverageBp,peerCount:result.count,differencePoints:result.differencePoints,rule:diffRule,peerRevisionIds:ids};
    const inserted=await client.query(`INSERT INTO calibration_cases(id,cycle_id,org_id,review_revision_id,reason_code,status,severity,evidence_json,input_hash) VALUES(gen_random_uuid(),$1,$2,$3,'SELF_PEER_DIFF','OPEN',$4,$5::jsonb,$6) ON CONFLICT (cycle_id,review_revision_id,input_hash) WHERE reason_code='SELF_PEER_DIFF' DO NOTHING RETURNING id`,[cycleId,orgId,input.self_revision,result.severity,JSON.stringify(evidence),hash]);
    if(inserted.rowCount){created++;await client.query(`INSERT INTO calibration_actions(id,case_id,org_id,actor_id,action,reason) VALUES(gen_random_uuid(),$1,$2,$3,'OPEN',$4)`,[inserted.rows[0].id,orgId,input.target_id,'自评与有效他评平均分差异达到配置阈值']);}else skipped++;
  }
  return { created, skipped };
}

/** 从 ruleset.config_json 解析核验阈值，缺项落默认值。
 *  注意：config 中 score 三项全部是基点（low_bp=6000 即 60 分），lowScore 转为 0—100 分口径。 */
export function thresholdsFrom(config: unknown): CalibrationThresholds {
  const c = (config ?? {}) as {
    score?: { high_bp?: number; excellent_bp?: number; low_bp?: number };
    ratio?: { threshold_pct?: number; min_reviews?: number };
  };
  return {
    highBp: c.score?.high_bp ?? 9000,
    excellentBp: c.score?.excellent_bp ?? 9500,
    lowScore: (c.score?.low_bp ?? 6000) / 100,
    ratioThresholdPct: c.ratio?.threshold_pct ?? 50,
    ratioMinReviews: c.ratio?.min_reviews ?? 4,
  };
}

/** 取周期的规则集校验和与核验阈值 */
export async function cycleThresholds(
  client: DbClient,
  cycleId: string,
): Promise<{ checksum: string; thresholds: CalibrationThresholds }> {
  const { rows } = await client.query<{ checksum: string; config: unknown }>(
    `SELECT r.checksum, r.config_json AS config
       FROM cycles c JOIN rulesets r ON r.id = c.ruleset_id WHERE c.id = $1`,
    [cycleId],
  );
  if (!rows[0]) throw new Error(`cycle ${cycleId} not found`);
  return { checksum: rows[0].checksum, thresholds: thresholdsFrom(rows[0].config) };
}
