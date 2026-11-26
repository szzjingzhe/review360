import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import {
  buildMonthlyReport,
  saveMonthlyReport,
  listMonthlyReports,
  type MonthlyReportPayload,
} from '@360/domain';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';
import { MaterialsService } from './materials.service';

type UploadFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };

function decodeUploadName(name: string): string {
  // Some multipart clients send UTF-8 filename bytes decoded as latin1.
  // Repair that mojibake while leaving already-correct names untouched.
  if (/[ÃÂæåçèéêëìíîïðñòóôõö÷øùúûüýþ]/.test(name)) {
    try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { /* keep original */ }
  }
  return name;
}

/**
 * 月报生成（技术文档 §12）。
 * 月报为只读洞察：持有 report.view 的角色可对任意本组织周期聚合「已发布结果」，
 * 生成结果落 result_monthly_reports 快照（按 cycle_id+scope 幂等），供反复查看/导出。
 */
@Injectable()
export class ReportService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool, private readonly materials: MaterialsService) {}

  async generate(actor: AuthContext, cycleId: string): Promise<MonthlyReportPayload> {
    return withTx(this.db, async (client) => {
      const cyc = await client.query<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM cycles WHERE id = $1 AND org_id = $2`,
        [cycleId, actor.orgId],
      );
      if (!cyc.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });

      const payload = await buildMonthlyReport(client, cycleId, actor.orgId);
      await saveMonthlyReport(client, {
        cycleId,
        orgId: actor.orgId,
        generatedBy: actor.userId,
        payload,
      });
      return payload;
    });
  }

  async list(actor: AuthContext, cycleId: string): Promise<MonthlyReportPayload[]> {
    return withTx(this.db, async (client) => {
      const cyc = await client.query<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM cycles WHERE id = $1 AND org_id = $2`,
        [cycleId, actor.orgId],
      );
      if (!cyc.rowCount) throw new NotFoundException({ code: 'CYCLE_NOT_FOUND' });
      const rows = await listMonthlyReports(client, cycleId);
      return rows.map((r) => r.payload);
    });
  }

  async listFiles(actor: AuthContext, cycleId: string) {
    const { rows } = await this.db.query(
      `SELECT mr.id AS report_id, mr.active_version_id, mr.locked_at,
              rv.id, rv.version, rv.original_name, rv.size_bytes, rv.mime,
              rv.scan_status, rv.preview_status, rv.created_at
         FROM monthly_reports mr
         LEFT JOIN report_versions rv ON rv.report_id = mr.id
        WHERE mr.org_id = $1 AND mr.cycle_id = $2 AND mr.user_id = $3
        ORDER BY rv.version DESC NULLS LAST`,
      [actor.orgId, cycleId, actor.userId],
    );
    return rows.filter((r) => r.id).map((r) => ({
      id: r.id,
      reportId: r.report_id,
      version: r.version,
      fileName: r.original_name,
      sizeBytes: Number(r.size_bytes ?? 0),
      mime: r.mime,
      status: r.locked_at ? 'LOCKED' : r.preview_status === 'READY' && r.scan_status === 'PASSED' ? 'READY' : r.preview_status === 'FAILED' || r.scan_status === 'FAILED' ? 'FAILED' : 'PROCESSING',
      locked: Boolean(r.locked_at),
      createdAt: r.created_at,
    }));
  }

  async previewFile(actor: AuthContext, cycleId: string, fileId: string) {
    const result = await this.db.query<{ object_key: string; original_name: string; mime: string; org_id: string; cycle_id: string }>(
      `SELECT rv.object_key, rv.original_name, rv.mime, rv.org_id, mr.cycle_id
         FROM report_versions rv
         JOIN monthly_reports mr ON mr.id = rv.report_id
        WHERE rv.id = $1 AND rv.org_id = $2 AND mr.cycle_id = $3 AND mr.user_id = $4`,
      [fileId, actor.orgId, cycleId, actor.userId],
    );
    if (!result.rowCount) throw new NotFoundException({ code: 'REPORT_FILE_NOT_FOUND' });
    const row = result.rows[0];
    try {
      return { buffer: await readFile(row.object_key), fileName: row.original_name, mime: row.mime };
    } catch {
      throw new NotFoundException({ code: 'REPORT_FILE_NOT_FOUND' });
    }
  }

  async uploadFile(actor: AuthContext, cycleId: string, file: UploadFile) {
    await this.materials.submit(actor, cycleId, [file], [{name:decodeUploadName(file.originalname).slice(0,200),type:'MONTHLY_REPORT',note:''}], true);
    return (await this.listFiles(actor,cycleId))[0];
  }

  async lockFile(actor: AuthContext, cycleId: string) {
    return this.materials.lock(actor,cycleId);
  }
}

async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
