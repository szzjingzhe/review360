import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PolicyService } from '../authz/policy.service';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';

export interface DepartmentMemberProgress {
  userId: string;
  displayName: string;
  roleSnapshot: string | null;
  selfStatus: 'SUBMITTED' | 'DRAFT' | 'NOT_STARTED';
  peerExpected: number;
  peerReceived: number;
  /** 材料状态：READY=已上传且可预览；PROCESSING=已上传但校验/转换未完成；MISSING=未上传 */
  materialStatus: 'READY' | 'PROCESSING' | 'MISSING';
  materialCount: number;
}

export interface DepartmentProgress {
  cycleId: string;
  departmentId: string;
  departmentCode: string | null;
  departmentName: string | null;
  memberCount: number;
  selfDone: number;
  peerReceived: number;
  peerExpected: number;
  missingSelf: { userId: string; displayName: string }[];
  /** 已上传并通过文件状态检查的本期月报人数（按参评成员去重） */
  materialsAvailable: true;
  materialsSubmitted: number;
  members: DepartmentMemberProgress[];
}

/**
 * 部门级进度聚合（部门端与首页部门视角）。
 * 只返回进度与缺交名单，**不返回**任何原始单份评分、评价者身份或排名（PRD §4 边界）。
 * 对象范围：需 progress.read；正式部门授权或 ORG 级授权可见。
 */
@Injectable()
export class DepartmentProgressService {
  constructor(
    @Inject(DATABASE_POOL) private readonly db: Pool,
    private readonly policy: PolicyService,
  ) {}

  async get(actor: AuthContext, cycleId: string, departmentId: string): Promise<DepartmentProgress> {
    await this.policy.assertResource(actor,'progress.read','cycle',cycleId,departmentId);

    // 2) 部门归属校验（必须属于本组织）
    const dept = await this.db.query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM departments WHERE id = $1 AND org_id = $2`,
      [departmentId, actor.orgId],
    );
    if (!dept.rowCount) throw new NotFoundException({ code: 'DEPARTMENT_NOT_FOUND' });

    // 3) 周期存在性
    const cycle = await this.db.query<{ id: string }>(
      `SELECT id FROM cycles WHERE id = $1 AND org_id = $2`,
      [cycleId, actor.orgId],
    );
    if (!cycle.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });

    // 4) 成员进度：自评状态 + 他评应收/实收（只取状态计数，不含任何分值与评价者）
    const { rows } = await this.db.query<{
      user_id: string;
      display_name: string;
      role_snapshot: string | null;
      self_status: string | null;
      peer_expected: number;
      peer_received: number;
      has_material: boolean;
      has_report: boolean;
      material_count: number;
    }>(
      `SELECT p.user_id,
              u.display_name,
              p.role_snapshot,
              self_r.status AS self_status,
              COALESCE(peer.expected, 0)::int AS peer_expected,
              COALESCE(peer.received, 0)::int AS peer_received,
              COALESCE(material.has_ready, false) AS has_material,
              COALESCE(material.has_report, false) AS has_report,
              COALESCE(material.material_count, 0)::int AS material_count
         FROM cycle_participants p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN LATERAL (
           SELECT r.status
             FROM reviews r
            WHERE r.cycle_id = p.cycle_id AND r.target_id = p.user_id AND r.kind = 'SELF'
            ORDER BY (r.status = 'SUBMITTED') DESC
            LIMIT 1
         ) self_r ON true
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE a.status = 'ACTIVE') AS expected,
                  count(*) FILTER (WHERE a.status = 'ACTIVE' AND rv.status = 'SUBMITTED') AS received
             FROM assignments a
             LEFT JOIN reviews rv ON rv.assignment_id = a.id
            WHERE a.cycle_id = p.cycle_id
              AND a.target_id = p.user_id
              AND a.source_type <> 'SELF'
         ) peer ON true
         LEFT JOIN LATERAL (
           SELECT
             EXISTS (
               SELECT 1
                 FROM monthly_reports mr
                 JOIN report_versions rv ON rv.id = mr.active_version_id
                WHERE mr.cycle_id = p.cycle_id
                  AND mr.user_id = p.user_id
                  AND mr.org_id = $3
                  AND rv.scan_status = 'PASSED'
                  AND rv.preview_status = 'READY'
             ) AS has_ready,
             EXISTS (
               SELECT 1 FROM monthly_reports mr
                WHERE mr.cycle_id = p.cycle_id AND mr.user_id = p.user_id AND mr.org_id = $3
             ) AS has_report,
             (
               SELECT count(*)
                 FROM monthly_materials mm
                 JOIN monthly_reports mr ON mr.id = mm.report_id
                WHERE mr.cycle_id = p.cycle_id AND mr.user_id = p.user_id AND mr.org_id = $3
             ) AS material_count
         ) material ON true
        WHERE p.cycle_id = $1 AND p.dept_snapshot = $2 AND p.eligibility = 'ELIGIBLE'
        ORDER BY (p.role_snapshot='HEAD') DESC,u.display_name`,
      [cycleId, departmentId, actor.orgId],
    );

    const members: DepartmentMemberProgress[] = rows
      // 部门端只看本部门正式成员
      .filter((r) => r.role_snapshot !== 'EXTERNAL')
      .map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        roleSnapshot: r.role_snapshot,
        selfStatus: (r.self_status as DepartmentMemberProgress['selfStatus']) ?? 'NOT_STARTED',
        peerExpected: r.peer_expected,
        peerReceived: r.peer_received,
        materialStatus: r.has_material ? 'READY' : r.has_report ? 'PROCESSING' : 'MISSING',
        materialCount: r.material_count,
      }));

    const missingSelf = members
      .filter((m) => m.selfStatus !== 'SUBMITTED')
      .map((m) => ({ userId: m.userId, displayName: m.displayName }));

    return {
      cycleId,
      departmentId,
      departmentCode: dept.rows[0].code,
      departmentName: dept.rows[0].name,
      memberCount: members.length,
      selfDone: members.filter((m) => m.selfStatus === 'SUBMITTED').length,
      peerReceived: members.reduce((sum, m) => sum + m.peerReceived, 0),
      peerExpected: members.reduce((sum, m) => sum + m.peerExpected, 0),
      missingSelf,
      materialsAvailable: true,
      materialsSubmitted: rows.filter((r) => r.role_snapshot !== 'EXTERNAL' && r.has_material).length,
      members,
    };
  }
}
