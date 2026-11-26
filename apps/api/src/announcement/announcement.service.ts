import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../database/database.module';
import { PolicyService } from '../authz/policy.service';
import type { AuthContext } from '../auth/current-user.decorator';

const TZ = 'Asia/Shanghai';

export interface AnnouncementTimelineItem {
  key: 'OPEN' | 'SELF' | 'PEER' | 'PUBLISH';
  label: string;
  at: string | null;
  state: 'done' | 'active' | 'upcoming' | 'missing';
  note: string;
}

export interface AnnouncementPayload {
  canEdit: boolean;
  cycle: {
    id: string;
    month: string;
    title: string;
    status: string;
    openAt: string | null;
    selfCloseAt: string | null;
    closeAt: string | null;
    publishAt: string | null;
  } | null;
  phaseLabel: string;
  timeline: AnnouncementTimelineItem[];
  announcement: {
    id: string | null;
    title: string;
    body: string;
    isPublished: boolean;
    updatedAt: string | null;
    customized: boolean;
  };
  /** 未写自定义正文时展示的默认文案（由周期时间节点生成） */
  autoBody: string;
  /** 「今日不再弹出」用的版本标识：公告更新或周期变更都会换新 */
  version: string;
}

type CycleRow = {
  id: string;
  month: Date;
  title: string;
  status: string;
  open_at: Date | null;
  self_close_at: Date | null;
  close_at: Date | null;
  publish_at: Date | null;
};

/**
 * 月评公告（个人端右上角）。
 * 学员只读：返回当前周期的时间节点 + 管理员维护的公告正文；
 * 管理端（management.access / cycle.manage）可写。
 */
@Injectable()
export class AnnouncementService {
  constructor(
    @Inject(DATABASE_POOL) private readonly db: Pool,
    private readonly policy: PolicyService,
  ) {}

  private fmt(value: Date | string | null): string {
    if (!value) return '待定';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '待定';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  }

  /** 周期月份统一展示成 2026-12，避免中文年月与标题风格不一致。 */
  private monthLabel(month: Date | string): string {
    const date = month instanceof Date ? month : new Date(month);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(date);
    const year = parts.find((p) => p.type === 'year')?.value ?? '';
    const mon = parts.find((p) => p.type === 'month')?.value ?? '';
    return year && mon ? `${year}-${mon}` : '';
  }

  private phaseLabel(cycle: CycleRow | null): string {
    if (!cycle) return '暂无进行中的月评';
    const now = Date.now();
    const at = (v: Date | null) => (v ? v.getTime() : null);
    switch (cycle.status) {
      case 'DRAFT':
      case 'PENDING_OPEN':
        return '月评未开始';
      case 'PAUSED':
        return '月评已暂停';
      case 'CALIBRATING':
        return '评分核验中';
      case 'PARTIALLY_PUBLISHED':
        return '结果陆续公布中';
      case 'PUBLISHED':
        return '结果已公布';
      case 'ARCHIVED':
        return '月评已归档';
      case 'REVIEWING': {
        const selfClose = at(cycle.self_close_at);
        const close = at(cycle.close_at);
        if (selfClose && now < selfClose) return '自评进行中';
        if (close && now < close) return '他评进行中';
        return '评价已截止，等待结果';
      }
      default:
        return cycle.status;
    }
  }

  private timeline(cycle: CycleRow): AnnouncementTimelineItem[] {
    const now = Date.now();
    /** 已过时间点 → done；上一节点已过且本节点未到 → active；否则 upcoming。 */
    const state = (value: Date | null, previous: Date | null): AnnouncementTimelineItem['state'] => {
      if (!value) return 'missing';
      if (value.getTime() <= now) return 'done';
      const previousPassed = previous ? previous.getTime() <= now : true;
      return previousPassed ? 'active' : 'upcoming';
    };
    const selfAt = cycle.self_close_at ?? cycle.close_at;
    return [
      {
        key: 'OPEN', label: '月评开始', at: cycle.open_at ? cycle.open_at.toISOString() : null,
        state: cycle.open_at ? (cycle.open_at.getTime() <= now ? 'done' : 'active') : 'missing',
        note: '开放材料上传与自评填写',
      },
      {
        key: 'SELF', label: '自评截止', at: selfAt ? selfAt.toISOString() : null,
        state: state(selfAt, cycle.open_at),
        note: '逾期不能再补交材料，也不能再修改自评',
      },
      {
        key: 'PEER', label: '他评截止', at: cycle.close_at ? cycle.close_at.toISOString() : null,
        state: state(cycle.close_at, selfAt),
        note: '自评截止后开放，对你分配到的同事完成评价',
      },
      {
        key: 'PUBLISH', label: '结果公布', at: cycle.publish_at ? cycle.publish_at.toISOString() : null,
        state: state(cycle.publish_at, cycle.close_at),
        note: '在「我的结果」查看本期得分与维度分析',
      },
    ];
  }

  private autoBody(cycle: CycleRow | null, timeline: AnnouncementTimelineItem[]): string {
    if (!cycle) return '当前没有进行中的月评周期，请等待管理员发起新的月度环评。';
    const at = (key: AnnouncementTimelineItem['key']) => this.fmt(timeline.find((t) => t.key === key)?.at ?? null);
    return [
      `${this.monthLabel(cycle.month)} 月度环评正在进行，请按下面的时间节点安排：`,
      '',
      `1. 月评开始：${at('OPEN')} 起可以上传本月材料、填写自评。`,
      `2. 自评截止：${at('SELF')} —— 逾期不能再补交材料，也不能再修改自评。`,
      `3. 他评截止：${at('PEER')} —— 自评截止后开放，请在此之前完成对你分配到的同事的评价。`,
      `4. 结果公布：${at('PUBLISH')} —— 公布后可在「我的结果」查看本期得分与维度分析。`,
      '',
      '几点提醒：',
      '· 材料入口在左侧「月报成果」，可以上传文件，也可以直接粘贴飞书云文档链接。',
      '· 材料锁定后最多可以解锁 2 次，请确认无误后再锁定。',
      '· 75—95 分之间的评分无需填写理由；低于 75 分或 96 分及以上需要说明原因。',
    ].join('\n');
  }

  private async canEdit(actor: AuthContext): Promise<boolean> {
    for (const capability of ['management.access', 'cycle.manage'] as const) {
      if (await this.policy.hasAnyCapability(actor.userId, actor.orgId, capability)) return true;
    }
    return false;
  }

  /**
   * 当前生效周期：
   * 同月可有多期（036），优先取「进行中」的那一期；没有进行中的，才取最近一期非取消周期。
   * 否则同月存在草稿时，学员看到的公告会错挂到未开期的草稿上。
   */
  private async activeCycle(orgId: string): Promise<CycleRow | null> {
    const result = await this.db.query<CycleRow>(
      `SELECT id, month, title, status, open_at, self_close_at, close_at, publish_at
         FROM cycles
        WHERE org_id = $1 AND status <> 'CANCELLED'
        ORDER BY
          CASE WHEN status IN ('PENDING_OPEN','REVIEWING','PAUSED','CALIBRATING','PARTIALLY_PUBLISHED') THEN 0 ELSE 1 END,
          month DESC, created_at DESC
        LIMIT 1`,
      [orgId],
    );
    return result.rows[0] ?? null;
  }

  private async load(orgId: string, cycleId: string | null) {
    const result = cycleId
      ? await this.db.query(
          `SELECT id, title, body, is_published, updated_at FROM announcements
            WHERE org_id = $1 AND cycle_id = $2`,
          [orgId, cycleId],
        )
      : { rows: [] as any[] };
    return result.rows[0] ?? null;
  }

  async active(actor: AuthContext): Promise<AnnouncementPayload> {
    const cycle = await this.activeCycle(actor.orgId);
    return this.compose(actor, cycle);
  }

  /** 管理端按周期读取公告（用于公告编辑页的周期切换）。 */
  async detail(actor: AuthContext, cycleId: string): Promise<AnnouncementPayload> {
    if (!(await this.canEdit(actor))) throw new ForbiddenException({ code: 'FORBIDDEN', capability: 'management.access' });
    const cycle = await this.cycleById(actor.orgId, cycleId);
    if (!cycle) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return this.compose(actor, cycle);
  }

  private async cycleById(orgId: string, cycleId: string): Promise<CycleRow | null> {
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if (!uuid.test(cycleId)) return null;
    const result = await this.db.query<CycleRow>(
      `SELECT id, month, title, status, open_at, self_close_at, close_at, publish_at
         FROM cycles WHERE id = $1 AND org_id = $2 AND status <> 'CANCELLED'`,
      [cycleId, orgId],
    );
    return result.rows[0] ?? null;
  }

  private async compose(actor: AuthContext, cycle: CycleRow | null): Promise<AnnouncementPayload> {
    const row = await this.load(actor.orgId, cycle?.id ?? null);
    const timeline = cycle ? this.timeline(cycle) : [];
    const body = typeof row?.body === 'string' ? row.body.trim() : '';
    const auto = this.autoBody(cycle, timeline);
    const versionBase = row?.updated_at ? new Date(row.updated_at).toISOString() : 'auto';
    return {
      canEdit: await this.canEdit(actor),
      cycle: cycle
        ? {
            id: cycle.id,
            month: this.monthLabel(cycle.month),
            title: cycle.title,
            status: cycle.status,
            openAt: cycle.open_at ? cycle.open_at.toISOString() : null,
            selfCloseAt: cycle.self_close_at ? cycle.self_close_at.toISOString() : null,
            closeAt: cycle.close_at ? cycle.close_at.toISOString() : null,
            publishAt: cycle.publish_at ? cycle.publish_at.toISOString() : null,
          }
        : null,
      phaseLabel: this.phaseLabel(cycle),
      timeline,
      announcement: {
        id: row?.id ?? null,
        title: row?.title ?? (cycle ? `${this.monthLabel(cycle.month)} 月评公告` : '月评公告'),
        body,
        isPublished: row ? row.is_published !== false : true,
        updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
        customized: body.length > 0,
      },
      autoBody: auto,
      version: `${cycle?.id ?? 'none'}:${versionBase}:${body.length}`,
    };
  }

  async save(actor: AuthContext, cycleId: string, input: { title?: unknown; body?: unknown; isPublished?: unknown }): Promise<AnnouncementPayload> {
    if (!(await this.canEdit(actor))) throw new ForbiddenException({ code: 'FORBIDDEN', capability: 'management.access' });
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if (!uuid.test(cycleId)) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    const cycle = await this.db.query<CycleRow>(
      `SELECT id, month, title, status, open_at, self_close_at, close_at, publish_at
         FROM cycles WHERE id = $1 AND org_id = $2 AND status <> 'CANCELLED'`,
      [cycleId, actor.orgId],
    );
    if (!cycle.rowCount) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    const cycleRow = cycle.rows[0];

    const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
    const rawBody = typeof input.body === 'string' ? input.body.trim() : '';
    if (rawTitle.length > 120) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'title' });
    if (rawBody.length > 4000) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'body' });
    const title = rawTitle || '月评公告';
    const isPublished = input.isPublished === undefined ? true : input.isPublished !== false;

    await this.db.query(
      `INSERT INTO announcements (org_id, cycle_id, title, body, is_published, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, cycle_id) WHERE cycle_id IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
                     is_published = EXCLUDED.is_published, updated_at = now()`,
      [actor.orgId, cycleId, title, rawBody, isPublished, actor.userId],
    );
    return this.compose(actor, cycleRow);
  }
}
