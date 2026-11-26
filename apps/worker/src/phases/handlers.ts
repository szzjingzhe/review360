import type { PoolClient } from 'pg';
import { withTx } from '../db.js';
import {
  buildOne,
  lockResultCycle, scanResultCycle,
  completenessCheck,
  openConfirmedCycle, AssignmentStateError,
  type BuildOutcome,
} from '@360/domain';

/**
 * Phase 处理结果：告诉调度器这条 phase 是否被实际执行。
 * SKIPPED 表示状态机前置条件不满足（例如周期已被取消），不会写入 actual_at，下次扫描可重试。
 */
export type PhaseOutcome =
  | { kind: 'EXECUTED'; fromStatus: string; toStatus: string; reason?: string }
  | { kind: 'SKIPPED'; fromStatus: string; reason: string }
  | { kind: 'ALREADY'; reason: string };

export type PhaseHandler = (
  client: PoolClient,
  cycleId: string,
  plannedAt: Date,
) => Promise<PhaseOutcome>;

// ----- CLOSE：到点关闭评审，并为全体 participant 自动构建结果 -----
// REVIEWING + now >= close_at  → CALIBRATING（附结果预构建）
export const handleClose: PhaseHandler = async (client, cycleId) => {
  await lockResultCycle(client,cycleId);
  const { rows } = await client.query<{
    id: string;
    status: string;
    close_at: Date | null;
    now: Date;
  }>(
    `SELECT id, status, close_at, now() AS now FROM cycles WHERE id = $1 FOR UPDATE`,
    [cycleId],
  );
  const row = rows[0];
  if (!row) return { kind: 'SKIPPED', fromStatus: 'UNKNOWN', reason: 'cycle_not_found' };
  if (row.status !== 'REVIEWING') {
    return { kind: 'SKIPPED', fromStatus: row.status, reason: `cycle_in_status_${row.status}` };
  }
  if (!row.close_at) {
    return { kind: 'SKIPPED', fromStatus: row.status, reason: 'close_at_missing' };
  }
  if (row.now < row.close_at) {
    return { kind: 'SKIPPED', fromStatus: row.status, reason: 'before_planned_time' };
  }
  const orgRow = await client.query<{ org_id: string }>(
    `SELECT org_id FROM cycles WHERE id = $1`,
    [cycleId],
  );
  await client.query(
    `UPDATE cycles SET status = 'CALIBRATING',row_version=row_version+1 WHERE id = $1 AND status = 'REVIEWING'`,
    [cycleId],
  );
  await client.query(
    `INSERT INTO cycle_state_log (cycle_id, from_status, to_status, actor_id, reason)
     VALUES ($1, 'REVIEWING', 'CALIBRATING', NULL, 'worker: auto-close at close_at')`,
    [cycleId],
  );

  await scanResultCycle(client,cycleId,orgRow.rows[0].org_id);
  await client.query('UPDATE monthly_reports SET locked_at=coalesce(locked_at,now()),updated_at=now() WHERE cycle_id=$1 AND org_id=$2',[cycleId,orgRow.rows[0].org_id]);

  // 为全体 participant 预构建 result_builds（完整性不满足者跳过，等人工/替补流程后由 API 补建）
  const built: BuildOutcome[] = [];
  const skipped: Array<{ targetId: string; reasons: string[] }> = [];
  const participants = await client.query<{ user_id: string }>(
    `SELECT user_id FROM cycle_participants WHERE cycle_id = $1 AND eligibility='ELIGIBLE'`,
    [cycleId],
  );
  for (const p of participants.rows) {
    const reasons = await completenessCheck(client, cycleId, p.user_id);
    if (reasons.length > 0) {
      skipped.push({ targetId: p.user_id, reasons });
      continue;
    }
    built.push(await buildOne(client, cycleId, orgRow.rows[0].org_id, p.user_id));
  }

  return {
    kind: 'EXECUTED',
    fromStatus: 'REVIEWING',
    toStatus: 'CALIBRATING',
    reason: `built=${built.length} skipped=${skipped.length}`,
  };
};

// Publishing always requires a fresh, authorized API operation; the worker never publishes.
export const handlePublish:PhaseHandler=async(_client,_cycleId)=>({kind:'SKIPPED',fromStatus:'N/A',reason:'manual_publication_required'});

export const handleOpen:PhaseHandler=async(client,cycleId)=>{
 await lockResultCycle(client,cycleId);
 const cycle=(await client.query('SELECT status,org_id FROM cycles WHERE id=$1 FOR UPDATE',[cycleId])).rows[0];
 if(!cycle)return {kind:'SKIPPED',fromStatus:'UNKNOWN',reason:'cycle_not_found'};
 if(cycle.status!=='PENDING_OPEN')return {kind:'SKIPPED',fromStatus:cycle.status,reason:'open_state_not_ready'};
 const confirmed=(await client.query("SELECT f.run_id,f.confirmed_by FROM cycle_open_confirmations f JOIN users u ON u.id=f.confirmed_by AND u.org_id=f.org_id AND u.status='ACTIVE' WHERE f.cycle_id=$1 AND f.org_id=$2 AND EXISTS(SELECT 1 FROM effective_capability_grants g WHERE g.user_id=u.id AND g.org_id=f.org_id AND g.capability='cycle.manage' AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_to IS NULL OR g.valid_to>now()) AND (g.scope_type='ORG' OR (g.scope_type='CYCLE' AND g.scope_id=f.cycle_id)))",[cycleId,cycle.org_id])).rows[0];
 if(!confirmed)return {kind:'SKIPPED',fromStatus:cycle.status,reason:'preview_confirmation_required'};
 try{await openConfirmedCycle(client,{userId:confirmed.confirmed_by,orgId:cycle.org_id},cycleId,confirmed.run_id);return {kind:'EXECUTED',fromStatus:'PENDING_OPEN',toStatus:'REVIEWING'};}
 catch(error){if(error instanceof AssignmentStateError)return {kind:'SKIPPED',fromStatus:cycle.status,reason:String(error.detail.code)};throw error;}
};

// ----- REMIND：到点发提醒（基础设施未到位前只记日志）-----
export const handleRemind: PhaseHandler = async (_client, _cycleId) => {
  return { kind: 'SKIPPED', fromStatus: 'N/A', reason: 'remind_transport_not_configured' };
};

// ----- ARCHIVE：发布后归档（M3 再启用，预留 handler）-----
export const handleArchive: PhaseHandler = async (_client, _cycleId) => {
  return { kind: 'SKIPPED', fromStatus: 'N/A', reason: 'archive_policy_pending_m3' };
};

export const HANDLERS = {
  OPEN: handleOpen,
  CLOSE: handleClose,
  PUBLISH: handlePublish,
  REMIND: handleRemind,
  ARCHIVE: handleArchive,
} as const;

export type PhaseName = keyof typeof HANDLERS;

export async function executePhase(phase:PhaseName,cycleId:string,_plannedAt:Date):Promise<PhaseOutcome>{
 const handler=HANDLERS[phase];if(!handler)throw new Error('unsupported_phase:'+phase);
 return withTx(async client=>{
  // Same lock ordering as API open/close avoids phase-row/cycle deadlocks.
  await lockResultCycle(client,cycleId);
  const row=(await client.query('SELECT planned_at,actual_at,now() AS now FROM cycle_phases WHERE cycle_id=$1 AND phase=$2 FOR UPDATE',[cycleId,phase])).rows[0];
  if(!row||row.actual_at)return {kind:'ALREADY',reason:'phase_already_completed_or_missing'};
  if(row.planned_at>row.now)return {kind:'SKIPPED',fromStatus:'N/A',reason:'before_planned_time'};
  const outcome=await handler(client,cycleId,row.planned_at);
  if(outcome.kind==='EXECUTED')await client.query('UPDATE cycle_phases SET actual_at=now() WHERE cycle_id=$1 AND phase=$2',[cycleId,phase]);
  return outcome;
 });
}
