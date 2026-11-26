/**
 * 月报生成（技术文档 §12 组织洞察 / 月报）。
 *
 * 月报由「已发布结果」实时聚合并落快照（result_monthly_reports）。
 * - aggregateReport：纯函数，对 (deptId, deptName, finalScore) 列表做统计，不依赖 DB 类型，便于单测。
 * - buildMonthlyReport：取数（最新一版已发布结果 + 部门 + 计数）→ 调 aggregateReport → 组装 payload。
 * - saveMonthlyReport：按 (cycle_id, scope) 幂等 upsert 快照。
 * 分数单位：final_score 来自 M4 result_builds.exact_score = round(score_bp)/100，为百分制（0–100）。
 * 档位阈值与基点语义对齐：优秀 >=95 / 良好 >=90 / 合格 >=60。
 */
import type { DbClient } from './db.js';

// final_score 为百分制（M4 exact_score = round(score_bp)/100），档位阈值与基点语义对齐。
export const EXCELLENT = 95;
export const GOOD = 90;
export const QUALIFIED = 60;

export interface ReportRow {
  deptId: string;
  deptName: string | null;
  finalScore: number;
}

export interface ScoreDistribution {
  excellent: number;
  good: number;
  qualified: number;
  low: number;
}

export interface ReportDeptSummary {
  deptId: string;
  deptName: string;
  count: number;
  avgScore: number;
  maxScore: number;
  minScore: number;
}

export interface ReportOrgSummary {
  participantCount: number;
  publishedCount: number;
  avgScore: number;
  distribution: ScoreDistribution;
  awardedCount: number;
  feedbackCount: number;
  feedbackResolved: number;
}

export interface MonthlyReportPayload {
  cycleId: string;
  orgId: string;
  generatedAt: string;
  org: ReportOrgSummary;
  departments: ReportDeptSummary[];
}

function bucket(score: number): keyof ScoreDistribution {
  if (score >= EXCELLENT) return 'excellent';
  if (score >= GOOD) return 'good';
  if (score >= QUALIFIED) return 'qualified';
  return 'low';
}

/**
 * 纯聚合：输入每个被评人的 (部门, 分数)，输出组织均分/分布 + 各部门汇总。
 * 不读 DB，便于在单元测试中直接验证统计逻辑。
 */
export function aggregateReport(rows: ReportRow[]): {
  avgScore: number;
  distribution: ScoreDistribution;
  departments: ReportDeptSummary[];
} {
  const distribution: ScoreDistribution = { excellent: 0, good: 0, qualified: 0, low: 0 };
  for (const r of rows) distribution[bucket(r.finalScore)] += 1;

  const avgScore = rows.length
    ? Math.round(rows.reduce((s, r) => s + r.finalScore, 0) / rows.length)
    : 0;

  const byDept = new Map<string, { deptId: string; deptName: string; scores: number[] }>();
  for (const r of rows) {
    const key = r.deptId;
    const cur = byDept.get(key) ?? { deptId: r.deptId, deptName: r.deptName ?? '未分配', scores: [] };
    cur.scores.push(r.finalScore);
    byDept.set(key, cur);
  }
  const departments: ReportDeptSummary[] = [...byDept.values()].map((d) => ({
    deptId: d.deptId,
    deptName: d.deptName,
    count: d.scores.length,
    avgScore: Math.round(d.scores.reduce((s, x) => s + x, 0) / d.scores.length),
    maxScore: Math.max(...d.scores),
    minScore: Math.min(...d.scores),
  }));
  departments.sort((a, b) => b.avgScore - a.avgScore);

  return { avgScore, distribution, departments };
}

/**
 * 取数 + 聚合 + 组装 payload。部门归属取自 cycle_participants.dept_snapshot。
 */
export async function buildMonthlyReport(
  client: DbClient,
  cycleId: string,
  orgId: string,
): Promise<MonthlyReportPayload> {
  const { rows } = await client.query<{ dept_id: string; dept_name: string | null; final_score: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (pr.target_id) pr.target_id, pr.payload_json
         FROM published_results pr
        WHERE pr.cycle_id = $1
        ORDER BY pr.target_id, pr.publication_version DESC
     )
     SELECT cp.dept_snapshot AS dept_id, d.name AS dept_name,
            (latest.payload_json->>'final_score')::numeric AS final_score
       FROM latest
       JOIN cycle_participants cp ON cp.cycle_id = $1 AND cp.user_id = latest.target_id
       LEFT JOIN departments d ON d.id = cp.dept_snapshot`,
    [cycleId],
  );
  const reportRows: ReportRow[] = rows.map((r) => ({
    deptId: r.dept_id,
    deptName: r.dept_name,
    finalScore: Number(r.final_score),
  }));

  const counts = await client.query<{
    participant_count: string; published_count: string; awarded_count: string;
    feedback_count: string; feedback_resolved: string;
  }>(
    `SELECT
       (SELECT count(*) FROM cycle_participants WHERE cycle_id = $1 AND eligibility='ELIGIBLE') AS participant_count,
       (SELECT count(DISTINCT target_id) FROM published_results WHERE cycle_id = $1) AS published_count,
       (SELECT count(*) FROM award_decisions WHERE cycle_id = $1 AND decision = 'AWARDED') AS awarded_count,
       (SELECT count(*) FROM feedback_requests fr
          JOIN published_results pr ON pr.id = fr.publication_id
         WHERE pr.cycle_id = $1) AS feedback_count,
       (SELECT count(*) FROM feedback_requests fr
          JOIN published_results pr ON pr.id = fr.publication_id
         WHERE pr.cycle_id = $1 AND fr.status IN ('APPROVED','REJECTED','DONE')) AS feedback_resolved`,
    [cycleId],
  );
  const c = counts.rows[0];

  const agg = aggregateReport(reportRows);
  const payload: MonthlyReportPayload = {
    cycleId,
    orgId,
    generatedAt: new Date().toISOString(),
    org: {
      participantCount: Number(c.participant_count),
      publishedCount: Number(c.published_count),
      avgScore: agg.avgScore,
      distribution: agg.distribution,
      awardedCount: Number(c.awarded_count),
      feedbackCount: Number(c.feedback_count),
      feedbackResolved: Number(c.feedback_resolved),
    },
    departments: agg.departments,
  };
  return payload;
}

/**
 * 幂等生成/更新快照：按 (cycle_id, scope) upsert。
 */
export async function saveMonthlyReport(
  client: DbClient,
  input: { cycleId: string; orgId: string; scope?: 'ORG' | 'DEPT'; generatedBy?: string | null; payload: MonthlyReportPayload },
): Promise<{ id: string }> {
  const scope = input.scope ?? 'ORG';
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO result_monthly_reports (cycle_id, org_id, scope, payload_json, generated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (cycle_id, scope) DO UPDATE
       SET payload_json = EXCLUDED.payload_json,
           generated_by = EXCLUDED.generated_by,
           generated_at = now()
     RETURNING id`,
    [input.cycleId, input.orgId, scope, JSON.stringify(input.payload), input.generatedBy ?? null],
  );
  return { id: rows[0].id };
}

export async function listMonthlyReports(
  client: DbClient,
  cycleId: string,
): Promise<Array<{ id: string; scope: string; generatedAt: string; payload: MonthlyReportPayload }>> {
  const { rows } = await client.query<{
    id: string; scope: string; generated_at: string; payload_json: MonthlyReportPayload;
  }>(
    `SELECT id, scope, generated_at, payload_json FROM result_monthly_reports WHERE cycle_id = $1 ORDER BY scope`,
    [cycleId],
  );
  return rows.map((r) => ({ id: r.id, scope: r.scope, generatedAt: r.generated_at, payload: r.payload_json }));
}
