/**
 * 月评催办提醒：算出「此刻该发哪条提醒」，并落到 notification_outbox 由 worker 投递。
 * 纯计算与写库分开，API 手动测试与 worker 定时扫描共用同一套判断。
 */
export interface ReminderCycle {
  id: string;
  orgId: string;
  month: string;
  status: string;
  selfCloseAt: Date | null;
  closeAt: Date | null;
  publishAt: Date | null;
}

export interface ReminderStats {
  selfPending: number;
  selfTotal: number;
  peerPending: number;
  peerTotal: number;
}

export interface ReminderMessage {
  kind: 'SELF_24H' | 'SELF_2H' | 'PEER_24H' | 'PEER_2H' | 'PUBLISH_READY';
  text: string;
}

const HOUR = 3600 * 1000;

const fmt = (value: Date): string =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);

/** 只输出当前时间窗内、且确实有人没交的提醒。 */
export function buildCycleReminders(cycle: ReminderCycle, stats: ReminderStats, now: Date = new Date()): ReminderMessage[] {
  const out: ReminderMessage[] = [];
  const selfClose = cycle.selfCloseAt ? new Date(cycle.selfCloseAt) : null;
  const close = cycle.closeAt ? new Date(cycle.closeAt) : null;
  const publish = cycle.publishAt ? new Date(cycle.publishAt) : null;
  const at = (base: Date, hours: number) => new Date(base.getTime() - hours * HOUR);

  if (selfClose && stats.selfPending > 0) {
    if (now >= at(selfClose, 24) && now < at(selfClose, 2)) {
      out.push({
        kind: 'SELF_24H',
        text: `【月度环评·${cycle.month}】自评将于 ${fmt(selfClose)} 截止。目前还有 ${stats.selfPending} 份自评没有提交，请尽快完成自评并上传本月材料。材料入口在左侧「月度成果」。`,
      });
    }
    if (now >= at(selfClose, 2) && now < selfClose) {
      out.push({
        kind: 'SELF_2H',
        text: `【月度环评·${cycle.month}】自评还有不到 2 小时截止（${fmt(selfClose)}）。目前仍有 ${stats.selfPending} 份自评未提交，逾期需要联系管理员补交。`,
      });
    }
  }

  if (close && stats.peerPending > 0 && (!selfClose || now >= selfClose)) {
    if (now >= at(close, 24) && now < at(close, 2)) {
      out.push({
        kind: 'PEER_24H',
        text: `【月度环评·${cycle.month}】他评将于 ${fmt(close)} 截止。你分配到的评价里还有 ${stats.peerPending} 份没有提交，请到「待我评价」完成。75—95 分的指标可以不写理由。`,
      });
    }
    if (now >= at(close, 2) && now < close) {
      out.push({
        kind: 'PEER_2H',
        text: `【月度环评·${cycle.month}】他评还有不到 2 小时截止（${fmt(close)}）。目前仍有 ${stats.peerPending} 份未提交，截止后系统将按缺评处理。`,
      });
    }
  }

  if (publish && cycle.status === 'CALIBRATING' && now >= publish) {
    out.push({
      kind: 'PUBLISH_READY',
      text: `【月度环评·${cycle.month}】已到结果发布节点（${fmt(publish)}），本期还有 ${stats.peerPending} 份他评未提交、${stats.selfPending} 份自评未提交。请到「月评管理 → 结果与核验」核对后确认发布。`,
    });
  }

  return out;
}

export const reminderEventKey = (kind: string, cycleId: string, recipientId: string, month: string): string =>
  `remind:${kind}:${month}:${cycleId.slice(0, 8)}:${recipientId}`;
