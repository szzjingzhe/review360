import type {DbClient} from '../db.js';
import {generateAssignment,ALGORITHM_VERSION} from './engine.js';
import type {Participant,HistoryEdge,Edge} from './types.js';
import {lockResultCycle} from '../results/ops.js';
export interface AssignmentCycle {id:string;month:string;status:string;ruleset_id:string;}
export class AssignmentStateError extends Error {constructor(readonly detail:Record<string,unknown>){super(String(detail.code));}}
const SOURCE_TYPE_MAP:Record<Edge['sourceType'],string>={HEAD_TO_MEMBER:'HEAD',HEAD_LOOP:'PEER',PEER_SAME_DEPT:'PEER',PEER_CROSS_DEPT:'PEER',MEMBER_TO_HEAD:'UPWARD',SUPERVISOR:'SUPERVISOR',MANUAL:'PEER',REPLACEMENT:'REPLACEMENT'};
export async function loadAssignmentInput(db: DbClient, orgId: string, cycle: AssignmentCycle) {
    const { rows: participants } = await db.query<{user_id:string;dept_code:string|null;role_snapshot:string;display_name:string}>(
      `SELECT p.user_id, d.code AS dept_code, p.role_snapshot, p.station_snapshot,u.display_name
       FROM cycle_participants p
       JOIN users u ON u.id=p.user_id AND u.org_id=p.org_id
       LEFT JOIN departments d ON d.id = p.dept_snapshot
       WHERE p.cycle_id = $1 AND p.org_id=$2 AND p.eligibility = 'ELIGIBLE'`,
      [cycle.id,orgId],
    );
    if (participants.length === 0) {
      throw new AssignmentStateError({ code: 'NO_PARTICIPANTS' });
    }

    // 历史边：最近 rotation_window 个已开期周期的全部有效分配（去重复对）
    const { rows: rulesetRows } = await db.query(
      `SELECT config_json->'rotation_window' AS window FROM rulesets WHERE id = $1`,
      [cycle.ruleset_id],
    );
    const rotationWindow = Math.min(Math.max(Number(rulesetRows[0]?.window) || 3, 1), 12);

    const { rows: historyRows } = await db.query<{reviewer_id:string;target_id:string}>(
      `SELECT DISTINCT a.reviewer_id, a.target_id
       FROM assignments a
       JOIN cycles c ON c.id = a.cycle_id AND c.org_id = $1 AND c.month < $2
            AND c.id IN (SELECT id FROM cycles WHERE org_id=$1 AND month<$2 AND status IN ('REVIEWING','CALIBRATING','PARTIALLY_PUBLISHED','PUBLISHED','ARCHIVED') ORDER BY month DESC LIMIT $3)
       WHERE a.status <> 'CANCELLED'
       ORDER BY a.reviewer_id, a.target_id`,
      [orgId, cycle.month,rotationWindow],
    );

    const domainParticipants: Participant[] = participants.map((p) => ({
      userId: p.user_id,
      deptId: p.dept_code ?? 'EXT',
      role: p.role_snapshot as Participant['role'],
      displayName:p.display_name,
    }));
    const history: HistoryEdge[] = historyRows.map((h) => ({
      cycleMonth: '',
      reviewerId: h.reviewer_id,
      targetId: h.target_id,
    }));
    const manualEdges=(await db.query<{reviewerId:string;targetId:string}>(`SELECT reviewer_id AS "reviewerId",target_id AS "targetId" FROM assignment_manual_edges WHERE cycle_id=$1 AND org_id=$2 ORDER BY reviewer_id,target_id`,[cycle.id,orgId])).rows;
    return { domainParticipants, history, rotationWindow, manualEdges };
  }


export async function checkOpenPrerequisites(db:DbClient, orgId: string): Promise<{ blocking: string[]; warnings: string[] }> {
    const blocking: string[] = [];
    const warnings: string[] = [];

    const hasRole = async (role: string) => {
      const { rowCount } = await db.query(
        `SELECT 1 FROM appointments WHERE org_id = $1 AND role = $2 AND valid_to IS NULL LIMIT 1`,
        [orgId, role],
      );
      return (rowCount ?? 0) > 0;
    };
    const hasGrant = async (capability: string) => {
      const { rowCount } = await db.query(
        `SELECT 1 FROM effective_capability_grants
          WHERE org_id = $1 AND capability = $2 AND revoked_at IS NULL
            AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
          LIMIT 1`,
        [orgId, capability],
      );
      return (rowCount ?? 0) > 0;
    };

    if (!(await hasRole('SUPERVISOR'))) blocking.push('SUPERVISOR_NOT_CONFIGURED');
    if (!(await hasGrant('calibration.resolve'))) warnings.push('CALIBRATOR_NOT_CONFIGURED');
    if (!(await hasGrant('reminder.send'))) warnings.push('REMINDER_NOT_CONFIGURED');
    if (!(await hasGrant('calibration.read_raw'))) warnings.push('INDEPENDENT_REVIEWER_NOT_CONFIGURED');

    return { blocking, warnings };
  }


export async function openConfirmedCycle(client:DbClient,actor:{userId:string;orgId:string},cycleId:string,runId:string){
 await lockResultCycle(client,cycleId);
 const cycle=(await client.query<AssignmentCycle & {open_at:Date;close_at:Date;now:Date}>("SELECT id,org_id,to_char(month,'YYYY-MM-DD') AS month,status,ruleset_id,open_at,close_at,now() AS now FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE",[cycleId,actor.orgId])).rows[0];
 if(!cycle)throw new AssignmentStateError({code:'CYCLE_NOT_FOUND'});
 if(!cycle.open_at||cycle.now<cycle.open_at)throw new AssignmentStateError({code:'BEFORE_OPEN_TIME'});
 if(!cycle.close_at||cycle.now>=cycle.close_at)throw new AssignmentStateError({code:'OPEN_WINDOW_CLOSED'});
 const prereq=await checkOpenPrerequisites(client,actor.orgId);
 if(prereq.blocking.length)throw new AssignmentStateError({code:'OPEN_PREREQUISITE_MISSING',missing:prereq.blocking});
      await lockResultCycle(client,cycleId);
      const current=(await client.query('SELECT status FROM cycles WHERE id=$1 AND org_id=$2 FOR UPDATE',[cycleId,actor.orgId])).rows[0];
      if(current?.status!=='PENDING_OPEN')throw new AssignmentStateError({code:'CYCLE_ALREADY_OPEN'});
      if(!runId)throw new AssignmentStateError({code:'PREVIEW_CONFIRM_REQUIRED'});
      const {domainParticipants,history,manualEdges}=await loadAssignmentInput(client,actor.orgId,cycle);
      // 已锁定则拒绝重复开期
      const { rows: locked } = await client.query(
        `SELECT 1 FROM cycle_locks WHERE cycle_id = $1`,
        [cycleId],
      );
      if (locked[0]) throw new AssignmentStateError({ code: 'CYCLE_ALREADY_OPEN' });

      let runRow: { id: string; version: number };
      if (runId) {
        // 用指定预览 run 锁定
        const { rows } = await client.query<{id:string;version:number;status:string;input_hash:string}>(
          `SELECT id, version, status, input_hash FROM assignment_runs
           WHERE id = $1 AND cycle_id = $2 AND org_id = $3`,
          [runId, cycleId, actor.orgId],
        );
        if (!rows[0]) throw new AssignmentStateError({code:'RUN_NOT_FOUND'});
        if (rows[0].status !== 'FEASIBLE') {
          throw new AssignmentStateError({ code: 'RUN_NOT_FEASIBLE', status: rows[0].status });
        }
        runRow = rows[0];
      } else {
        // 未指定则重新生成最终 run（同输入确定性输出）
        runRow = { id: '', version: 0 };
      }

      // 统一以相同输入重跑保证确定性，并核验 input_hash 一致（若指定了 run）
      const result = generateAssignment({
        participants: domainParticipants,
        manualEdges,
        history,
        avoidPairs: [],
        seed: cycle.month,
        algorithmVersion: ALGORITHM_VERSION,
      });
      if (!result.feasible) {
        throw new AssignmentStateError({ code: 'ASSIGNMENT_INFEASIBLE', diagnostics: result.diagnostics });
      }
      if (runId && result.inputHash !== (runRow as { input_hash?: string }).input_hash) {
        throw new AssignmentStateError({ code: 'RUN_INPUT_CHANGED' });
      }

      const version = await Promise.resolve((await client.query('SELECT coalesce(max(version),0)+1 AS next FROM assignment_runs WHERE cycle_id=$1',[cycleId])).rows[0].next);
      const { rows: finalRun } = await client.query(
        `INSERT INTO assignment_runs (id, cycle_id, org_id, version, seed, algorithm_version, input_hash, cost, diagnostics, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'LOCKED')
         RETURNING id, version`,
        [
          cycleId,
          actor.orgId,
          version,
          cycle.month,
          result.algorithmVersion,
          result.inputHash,
          result.edges.length,
          JSON.stringify({ feasible: true, diagnostics: [] }),
        ],
      );
      // 指定预览 run 标记被取代
      if (runId) {
        await client.query(
          `UPDATE assignment_runs SET status = 'SUPERSEDED' WHERE id = $1 AND status = 'FEASIBLE'`,
          [runId],
        );
      }

      // 批量写入 assignments
      if (result.edges.length > 0) {
        const values: unknown[] = [];
        const tuples = result.edges.map((e, i) => {
          const b = i * 8;
          values.push(
            finalRun[0].id, cycleId, actor.orgId, e.reviewerId, e.targetId,
            SOURCE_TYPE_MAP[e.sourceType], e.isFixed, e.sourceType,
          );
          return `(gen_random_uuid(), $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
        });
        const inserted = await client.query<{ id: string; reviewer_id: string; target_id: string }>(
          `INSERT INTO assignments (id, run_id, cycle_id, org_id, reviewer_id, target_id, source_type, is_fixed, reason)
           VALUES ${tuples.join(', ')}
           RETURNING id, reviewer_id, target_id`,
          values,
        );
        // 为每个有效他评任务建一条 review 行（reviewer 端 M3 API 用）
        // 跳过 reviewer_id = target_id 的边（防御性，按 no_peer_self 已挡，但偶发兜底）
        for (const a of inserted.rows) {
          if (a.reviewer_id === a.target_id) continue;
          await client.query(
            `INSERT INTO reviews (id, cycle_id, org_id, assignment_id, reviewer_id, target_id, kind, status)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'PEER', 'DRAFT')
             ON CONFLICT (assignment_id) WHERE assignment_id IS NOT NULL DO NOTHING`,
            [cycleId, actor.orgId, a.id, a.reviewer_id, a.target_id],
          );
        }
      }

      // 周期锁定 + 状态流转 + 阶段落账
      await client.query(
        `INSERT INTO cycle_locks (cycle_id, locked_by, assignment_run_id) VALUES ($1, $2, $3)`,
        [cycleId, actor.userId, finalRun[0].id],
      );
      await client.query(
        `UPDATE cycles SET status = 'REVIEWING', row_version = row_version + 1
         WHERE id = $1 AND org_id = $2 AND status = 'PENDING_OPEN'`,
        [cycleId, actor.orgId],
      );
      await client.query(
        `INSERT INTO cycle_state_log (cycle_id, from_status, to_status, actor_id, reason)
         VALUES ($1, 'PENDING_OPEN', 'REVIEWING', $2, '开期锁定分配')`,
        [cycleId, actor.userId],
      );
      await client.query(
        `UPDATE cycle_phases SET actual_at = now() WHERE cycle_id = $1 AND phase = 'OPEN' AND actual_at IS NULL`,
        [cycleId],
      );

      return {
        cycle_id: cycleId,
        status: 'REVIEWING',
        assignment_run_id: finalRun[0].id,
        assignment_version: finalRun[0].version,
        edge_count: result.edges.length,
      };

}
