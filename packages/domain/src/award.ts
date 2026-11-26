/**
 * 评优决策（技术文档 §11，呼应 D07）。
 *
 * 设计：系统**不自动授奖**，仅提供
 *   1) 候选名单：从已发布结果按 final_score 降序排名（按部门分组），供管理角色查看；
 *   2) 决策落库：人工提名/评定（AWARDED / NOMINATED / NONE），按 (cycle,target,category) 幂等覆盖。
 * 全部为纯 SQL 编排，接收 DbClient，由 api / worker 共用。
 */
import type { DbClient } from './db.js';

export interface AwardCandidateRow {
  userId: string;
  displayName: string;
  deptName: string;
  finalScore: number;
  cycleId: string;
  month: string;
  publicationVersion: number;
}

/**
 * 仅从已发布、最新一版结果计算，按 final_score 降序排名。
 * 部门取主职（department_memberships.is_primary）。
 */
export async function listAwardCandidates(
  client: DbClient,
  cycleId: string,
): Promise<AwardCandidateRow[]> {
  const { rows } = await client.query<{
    user_id: string;
    display_name: string;
    dept_name: string | null;
    final_score: string | null;
    month: string;
    publication_version: number;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (p.target_id) p.target_id, p.payload_json, p.publication_version, c.month
         FROM published_results p
         JOIN cycles c ON c.id = p.cycle_id
        WHERE p.cycle_id = $1
        ORDER BY p.target_id, p.publication_version DESC
     )
     SELECT l.target_id AS user_id,
            u.display_name,
            d.name AS dept_name,
            (l.payload_json->>'final_score')::numeric AS final_score,
            to_char(l.month,'YYYY-MM') AS month,
            l.publication_version
       FROM latest l
       JOIN users u ON u.id = l.target_id
       JOIN cycle_participants cp ON cp.cycle_id=$1 AND cp.user_id=u.id AND cp.org_id=u.org_id
       LEFT JOIN departments d ON d.id = cp.dept_snapshot AND d.org_id=cp.org_id
      WHERE (l.payload_json->>'final_score') IS NOT NULL
      ORDER BY (l.payload_json->>'final_score')::numeric DESC, u.display_name`,
    [cycleId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    deptName: r.dept_name ?? '未分配部门',
    finalScore: r.final_score === null ? 0 : Number(r.final_score),
    cycleId,
    month: r.month,
    publicationVersion: r.publication_version,
  }));
}

export type AwardDecision = 'AWARDED' | 'NOMINATED' | 'NONE';

export interface AwardDecisionInput {
  cycleId: string;
  orgId: string;
  targetId: string;
  category: string;
  decision: AwardDecision;
  reason?: string;
  actorId: string;
  resultVersion: number;
}

/**
 * 保存评优决定（按 cycle+target+category 唯一覆盖；uq_award_decision 由 008 迁移建立）。
 * 返回落库行 id。
 */
export async function saveAwardDecision(
  client: DbClient,
  input: AwardDecisionInput,
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO award_decisions
       (id, cycle_id, org_id, target_id, category, decision, reason, result_version)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (cycle_id, target_id, category) DO UPDATE
       SET decision = EXCLUDED.decision,
           reason = EXCLUDED.reason,
           result_version = EXCLUDED.result_version,
           created_at = now()
     RETURNING id`,
    [
      input.cycleId,
      input.orgId,
      input.targetId,
      input.category,
      input.decision,
      input.reason ?? null,
      input.resultVersion,
    ],
  );
  // actorId 仅用于审计上下文，调用方负责写 audit_events
  void input.actorId;
  return { id: rows[0].id };
}

/** 查询某周期已有评优决定（供前端回显） */
export async function listAwardDecisions(
  client: DbClient,
  cycleId: string,
): Promise<
  Array<{
    targetId: string;
    category: string;
    decision: AwardDecision;
    reason: string | null;
    resultVersion: number;
  }>
> {
  const { rows } = await client.query<{
    target_id: string;
    category: string;
    decision: AwardDecision;
    reason: string | null;
    result_version: number;
  }>(
    `SELECT target_id, category, decision, reason, result_version
       FROM award_decisions WHERE cycle_id = $1 ORDER BY category, target_id`,
    [cycleId],
  );
  return rows.map((r) => ({
    targetId: r.target_id,
    category: r.category,
    decision: r.decision,
    reason: r.reason,
    resultVersion: r.result_version,
  }));
}
