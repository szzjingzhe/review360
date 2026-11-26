import { Body, Controller, Inject, Param, ParseUUIDPipe, Post, UseGuards, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { buildCycleReminders, reminderEventKey, type ReminderStats } from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/current-user.decorator';
import { PolicyService } from '../authz/policy.service';

/**
 * 催办提醒的人工触达：管理员点一下，立刻把「本期还差什么」推到自己的飞书。
 * 用于验证文案与通道，避免直接群发给全员。
 */
@Controller('cycles')
@UseGuards(SessionGuard)
export class ReminderController {
  constructor(
    @Inject(DATABASE_POOL) private readonly db: Pool,
    private readonly policy: PolicyService,
  ) {}

  @Post(':cycleId/remind-me')
  async remindMe(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @Body() body: { recipientId?: string },
  ) {
    if (!(await this.policy.hasCapability(actor.userId, actor.orgId, 'cycle.manage'))) {
      throw new ForbiddenException({ code: 'FORBIDDEN' });
    }
    const cycle = (await this.db.query(
      `SELECT id, org_id, to_char(month, 'YYYY-MM') AS month, status, self_close_at, close_at, publish_at
         FROM cycles WHERE id = $1 AND org_id = $2`,
      [cycleId, actor.orgId],
    )).rows[0];
    if (!cycle) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });

    const stats: ReminderStats = (await this.db.query(
      `SELECT
         (SELECT count(*)::int FROM reviews WHERE cycle_id = $1 AND kind = 'SELF' AND status <> 'SUBMITTED') AS "selfPending",
         (SELECT count(*)::int FROM reviews WHERE cycle_id = $1 AND kind = 'SELF') AS "selfTotal",
         (SELECT count(*)::int FROM reviews WHERE cycle_id = $1 AND kind = 'PEER' AND status <> 'SUBMITTED') AS "peerPending",
         (SELECT count(*)::int FROM reviews WHERE cycle_id = $1 AND kind = 'PEER') AS "peerTotal"`,
      [cycleId],
    )).rows[0];

    const now = new Date();
    const due = buildCycleReminders(
      {
        id: cycle.id, orgId: cycle.org_id, month: cycle.month, status: cycle.status,
        selfCloseAt: cycle.self_close_at, closeAt: cycle.close_at, publishAt: cycle.publish_at,
      },
      stats,
      now,
    );
    const messages = due.length
      ? due
      : [{
          kind: 'MANUAL_TEST' as const,
          text: `【月度环评·${cycle.month}】当前进度：自评未提交 ${stats.selfPending}/${stats.selfTotal} 份，他评未提交 ${stats.peerPending}/${stats.peerTotal} 份。这条是催办通道的自测消息，用于确认飞书推送是否正常。`,
        }];

    const recipient = String(body?.recipientId ?? '').trim() || actor.userId;
    const bound = await this.db.query(
      `SELECT 1 FROM external_identities e JOIN users u ON u.id = e.user_id
        WHERE e.user_id = $1 AND u.org_id = $2 AND e.provider = 'FEISHU' AND e.approved`,
      [recipient, actor.orgId],
    );
    if (!bound.rowCount) return { data: { queued: 0, reason: 'RECIPIENT_NOT_BOUND', hint: '该账号还没有绑定飞书，无法接收推送。' } };

    let queued = 0;
    for (const message of messages) {
      const key = reminderEventKey(message.kind, cycle.id, recipient, cycle.month);
      const exists = await this.db.query('SELECT 1 FROM notification_outbox WHERE event_key = $1', [key]);
      if (exists.rowCount) continue;
      await this.db.query(
        `INSERT INTO notification_outbox (id, org_id, event_key, recipient_id, channel, payload_json)
         VALUES (gen_random_uuid(), $1, $2, $3, 'FEISHU', $4::jsonb)`,
        [actor.orgId, key, recipient, JSON.stringify({ type: 'CYCLE_REMIND', text: message.text })],
      );
      queued += 1;
    }
    return { data: { queued, kind: messages[0].kind, text: messages[0].text } };
  }
}
