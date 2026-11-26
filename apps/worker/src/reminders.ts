import type { Pool } from 'pg';
import { buildCycleReminders, reminderEventKey, type ReminderStats } from '@360/domain';

/**
 * 月评催办扫描。
 * 测试期只发给 REMIND_TEST_USER_ID 指定的账号（默认即管理员本人），验证文案与时机后再放开给全员。
 */
export async function dispatchCycleReminders(pool: Pool, now: Date = new Date()): Promise<number> {
  const recipient = String(process.env.REMIND_TEST_USER_ID ?? '').trim();
  if (!recipient) return 0;

  const cycles = (await pool.query<{
    id: string; org_id: string; month: string; status: string;
    self_close_at: Date | null; close_at: Date | null; publish_at: Date | null;
  }>(
    `SELECT id, org_id, to_char(month, 'YYYY-MM') AS month, status, self_close_at, close_at, publish_at
       FROM cycles
      WHERE status IN ('REVIEWING', 'CALIBRATING')`,
  )).rows;
  if (!cycles.length) return 0;

  let queued = 0;
  for (const row of cycles) {
    const stats: ReminderStats = (await pool.query(
      `SELECT
         (SELECT count(*)::int FROM reviews WHERE cycle_id = $1 AND kind = 'SELF' AND status <> 'SUBMITTED') AS "selfPending",
         (SELECT count(*)::int FROM reviews WHERE cycle_id = $1 AND kind = 'SELF') AS "selfTotal",
         (SELECT count(*)::int FROM reviews WHERE cycle_id = $1 AND kind = 'PEER' AND status <> 'SUBMITTED') AS "peerPending",
         (SELECT count(*)::int FROM reviews WHERE cycle_id = $1 AND kind = 'PEER') AS "peerTotal"`,
      [row.id],
    )).rows[0];

    const messages = buildCycleReminders(
      {
        id: row.id, orgId: row.org_id, month: row.month, status: row.status,
        selfCloseAt: row.self_close_at, closeAt: row.close_at, publishAt: row.publish_at,
      },
      stats,
      now,
    );

    for (const message of messages) {
      const key = reminderEventKey(message.kind, row.id, recipient, row.month);
      const exists = await pool.query('SELECT 1 FROM notification_outbox WHERE event_key = $1', [key]);
      if (exists.rowCount) continue;
      await pool.query(
        `INSERT INTO notification_outbox (id, org_id, event_key, recipient_id, channel, payload_json)
         VALUES (gen_random_uuid(), $1, $2, $3, 'FEISHU', $4::jsonb)`,
        [row.org_id, key, recipient, JSON.stringify({ type: 'CYCLE_REMIND', text: message.text })],
      );
      queued += 1;
    }
  }
  return queued;
}
