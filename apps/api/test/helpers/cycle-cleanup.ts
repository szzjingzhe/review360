import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

/**
 * 按依赖顺序（子表在前）删除指定月份的所有周期及其附属数据。
 *
 * 为什么要单独抽出来：
 * 1. 引用 cycles 的表有 16 张，其中 8 张没有 cycle_id（只能通过父表间接定位）；
 *    手写删除顺序极易漏表，漏了以后 DELETE cycles 会被外键挡住。
 * 2. 以前的写法用 `.catch(() => undefined)` 吞掉错误，导致残留周期被静默保留，
 *    下一次运行 createCycle 返回 400 CYCLE_MONTH_EXISTS，表现为「偶发失败」。
 *    这里一律不吞错误：失败时抛出并带上表名，下一个阻塞点立刻可见。
 */
const CYCLES_OF_MONTHS = 'cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[]))';
const BUILDS_OF_MONTHS =
  'result_build_id IN (SELECT id FROM result_builds WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[])))';

const DELETES: Array<{ table: string; where: string }> = [
  { table: 'assignment_manual_edges', where: CYCLES_OF_MONTHS },
  { table: 'material_submission_batches', where: CYCLES_OF_MONTHS },
  { table: 'review_material_snapshots', where: 'report_id IN (SELECT id FROM monthly_reports WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[])))' },
  { table: 'monthly_material_versions', where: 'material_id IN (SELECT id FROM monthly_materials WHERE report_id IN (SELECT id FROM monthly_reports WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[]))))' },
  { table: 'monthly_materials', where: 'report_id IN (SELECT id FROM monthly_reports WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[])))' },
  // 孙表（无 cycle_id，只能通过父表定位）
  { table: 'result_source_reviews', where: BUILDS_OF_MONTHS }, // 也引用 review_revisions，须先于它删除
  { table: 'result_approvals', where: BUILDS_OF_MONTHS },
  { table: 'result_feedback', where: BUILDS_OF_MONTHS },
  // 校准（calibration_cases 引用 review_revisions，必须先于它删除）
  {
    table: 'calibration_actions',
    where: 'case_id IN (SELECT id FROM calibration_cases WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[])))',
  },
  { table: 'calibration_cases', where: CYCLES_OF_MONTHS },
  {
    table: 'review_revisions',
    where: 'review_id IN (SELECT id FROM reviews WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[])))',
  },
  // 分配（assignments.replaces_id 自引用，单条 DELETE 即可一并清掉）
  { table: 'reviews', where: CYCLES_OF_MONTHS },
  { table: 'assignments', where: CYCLES_OF_MONTHS },
  { table: 'cycle_locks', where: CYCLES_OF_MONTHS },
  { table: 'cycle_open_confirmations', where: CYCLES_OF_MONTHS },
  { table: 'assignment_runs', where: CYCLES_OF_MONTHS },
  // 结果
  {
    table: 'feedback_requests',
    where: 'publication_id IN (SELECT id FROM published_results WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[])))',
  },
  // 通知 outbox（无 cycle_id；event_key 约定含 cycle id，按模糊匹配定位）
  {
    table: 'notification_outbox',
    where: `EXISTS (SELECT 1 FROM cycles c
              WHERE c.month = ANY($1::date[]) AND notification_outbox.event_key LIKE '%' || c.id::text || '%')`,
  },
  { table: 'published_results', where: CYCLES_OF_MONTHS },
  { table: 'result_builds', where: CYCLES_OF_MONTHS },
  // 月报（M6 快照，按 cycle_id 直接挂依赖）
  { table: 'result_monthly_reports', where: CYCLES_OF_MONTHS },
  // 旧报告模型（迁移 004 遗留孤儿表，仍随周期清理以保持 harness 幂等）
  {
    table: 'report_versions',
    where: 'report_id IN (SELECT id FROM monthly_reports WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[])))',
  },
  {
    table: 'upload_sessions',
    where: 'report_id IN (SELECT id FROM monthly_reports WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[])))',
  },
  { table: 'monthly_reports', where: CYCLES_OF_MONTHS },
  // 其余直接挂 cycle 的表
  { table: 'reviewer_statements', where: CYCLES_OF_MONTHS },
  { table: 'reviewer_cycle_stats', where: CYCLES_OF_MONTHS },
  { table: 'review_drafts', where: CYCLES_OF_MONTHS },
  { table: 'award_decisions', where: CYCLES_OF_MONTHS },
  { table: 'scheduled_jobs', where: CYCLES_OF_MONTHS },
  { table: 'cycle_phases', where: CYCLES_OF_MONTHS },
  { table: 'cycle_state_log', where: CYCLES_OF_MONTHS },
  { table: 'cycle_participants', where: CYCLES_OF_MONTHS },
  // 最后才是周期本身
  { table: 'cycles', where: 'month = ANY($1::date[])' },
];

/**
 * @param months 形如 ['2031-05-01', '2031-06-01'] 的月份（当月 1 号）
 */
export async function purgeCycles(db: Pool, months: string[]): Promise<void> {
  await createRequire(resolve(process.cwd(),'package.json'))('../../scripts/test-db-safety.cjs').verifyTestConnection(db);
  await db.query(`UPDATE monthly_reports SET active_version_id=NULL WHERE ${CYCLES_OF_MONTHS}`, [months]);
  await db.query(`UPDATE review_drafts SET report_version_id=NULL WHERE ${CYCLES_OF_MONTHS}`, [months]);
  // 先清掉 reviews.current_revision_id 指向即将被删的 review_revisions 的引用
  await db.query(
    `UPDATE reviews SET current_revision_id = NULL
      WHERE cycle_id IN (SELECT id FROM cycles WHERE month = ANY($1::date[]))`,
    [months],
  );
  for (const { table, where } of DELETES) {
    try {
      await db.query(`DELETE FROM ${table} WHERE ${where}`, [months]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`清理 ${table} 失败（测试数据残留会污染后续运行）：${msg}`);
    }
  }
}
