import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

export const SESSION_COOKIE = 's360_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionUser {
  sessionIdHash: string;
  userId: string;
  orgId: string;
  displayName: string;
  status: string;
  isGuidance?: boolean;
  isResultViewer?: boolean;
  /** 是否拥有管理端入口能力（management.access）：拥有则不受指导组只读白名单限制 */
  isManager?: boolean;
}

export interface SessionInfo extends SessionUser {
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class SessionService {
  constructor(@Inject('DATABASE_POOL') private readonly db: Pool) {}

  /** 创建会话，返回明文令牌（仅此一次出现，库中只存哈希） */
  async createSession(userId: string, orgId: string, userAgent?: string, client?: PoolClient): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const created=await (client??this.db).query(
      `INSERT INTO sessions (id_hash, user_id, org_id, expires_at, user_agent)
       SELECT $1,u.id,u.org_id,now()+($4 || ' milliseconds')::interval,$5 FROM users u WHERE u.id=$2 AND u.org_id=$3 AND u.status='ACTIVE' RETURNING id_hash`,
      [hashToken(token), userId, orgId, SESSION_TTL_MS, userAgent ?? null],
    );
    if(!created.rowCount)throw new UnauthorizedException({code:'USER_NOT_ACTIVE'});
    return token;
  }

  /** 按令牌解析有效会话（未撤销、未过期、用户未被停用） */
  async resolveSession(token: string): Promise<SessionInfo | null> {
    const { rows } = await this.db.query<SessionInfo & { status: string }>(
      `SELECT s.id_hash AS "sessionIdHash", s.expires_at AS "expiresAt",
              u.id AS "userId", u.org_id AS "orgId", u.display_name AS "displayName", u.status,u.result_view_only AS "isResultViewer",
              EXISTS(SELECT 1 FROM department_memberships m JOIN departments d ON d.id=m.department_id AND d.org_id=m.org_id
                WHERE m.user_id=u.id AND m.org_id=u.org_id AND d.code IN ('GUIDE','GUIDANCE') AND m.valid_from<=current_date
                  AND (m.valid_to IS NULL OR m.valid_to>current_date)) AS "isGuidance",
              EXISTS(SELECT 1 FROM effective_capability_grants g
                WHERE g.user_id=u.id AND g.org_id=u.org_id AND g.capability='management.access') AS "isManager"
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.org_id=s.org_id
       WHERE s.id_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND u.status = 'ACTIVE'`,
      [hashToken(token)],
    );
    return rows[0] ?? null;
  }

  async revokeSession(token: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }

  async writeAudit(
    actorId: string | null,
    orgId: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    reason?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events (org_id, actor_id, action, resource_type, resource_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, actorId, action, resourceType, resourceId, reason ?? null],
    );
  }
}
