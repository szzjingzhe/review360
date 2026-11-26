import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { queryAuditEvents, type AuditEventRow, type AuditQuery } from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';

/**
 * 审计导出服务（技术文档 §??）。
 * 仅组织级只读聚合：orgId 取自当前操作人，避免越权查看其它组织；
 * 操作人/动作/时间筛选在前端透传，落库查询由 @360/domain 的 queryAuditEvents 完成。
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  async query(actor: AuthContext, q: AuditQueryInput): Promise<AuditEventRow[]> {
    const query: AuditQuery = {
      orgId: actor.orgId,
      from: q.from || undefined,
      to: q.to || undefined,
      action: q.action || undefined,
      actorId: q.actorId || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    };
    return queryAuditEvents(this.db, query);
  }
}

export interface AuditQueryInput {
  format?: string;
  from?: string;
  to?: string;
  action?: string;
  actorId?: string;
  limit?: string;
}
