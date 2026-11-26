/**
 * 审计报表导出（技术文档 §??，与 M6 月报呼应成「洞察 + 合规」闭环）。
 *
 * - queryAuditEvents：取数（JOIN users 取操作人姓名）+ 按时间/操作/操作人筛选。
 * - toCsv：纯函数，生成 RFC4180 CSV（含表头 + 字段转义），便于单测与直接落盘。
 * - toPrintHtml：纯函数，生成打印友好 HTML（含 @media print 样式），前端 window.print() 另存为 PDF。
 * 分数/结果单位与 M4 一致：审计只记录动作元数据，不涉及分数换算。
 */
import type { DbClient } from './db.js';

export interface AuditEventRow {
  id: string;
  orgId: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  requestId: string | null;
  createdAt: string | Date;
}

export interface AuditQuery {
  orgId: string;
  from?: string; // 起始时间（含），ISO 或日期串
  to?: string; // 结束时间（含）
  action?: string;
  actorId?: string;
  limit?: number;
}

const CSV_COLUMNS = ['序号', '时间', '操作人', '操作', '资源类型', '资源ID', '原因', '请求ID'];

/** 单字段 CSV 转义：含逗号/引号/换行时用双引号包裹，内部引号转义为两个引号 */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function fmtTime(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace('T', ' ').slice(0, 19); // UTC yyyy-MM-dd HH:mm:ss
}

/** 取数 + 筛选。参数占位符从 $1(org_id) 起顺序追加，无 SQL 注入风险。 */
export async function queryAuditEvents(
  client: DbClient,
  q: AuditQuery,
): Promise<AuditEventRow[]> {
  const where: string[] = ['e.org_id = $1'];
  const params: unknown[] = [q.orgId];
  let idx = 2;
  if (q.from) {
    where.push(`e.created_at >= $${idx++}`);
    params.push(q.from);
  }
  if (q.to) {
    where.push(`e.created_at <= $${idx++}`);
    params.push(q.to);
  }
  if (q.action) {
    where.push(`e.action = $${idx++}`);
    params.push(q.action);
  }
  if (q.actorId) {
    where.push(`e.actor_id = $${idx++}`);
    params.push(q.actorId);
  }
  const limit = Math.min(Math.max(q.limit ?? 500, 1), 2000);
  params.push(limit);

  const { rows } = await client.query<AuditEventRow>(
    `SELECT e.id, e.org_id AS "orgId", e.actor_id AS "actorId",
            u.display_name AS "actorName", e.action, e.resource_type AS "resourceType",
            e.resource_id AS "resourceId", e.reason, e.request_id AS "requestId",
            e.created_at AS "createdAt"
       FROM audit_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC
      LIMIT $${idx}`,
    params,
  );
  return rows;
}

/** 生成 RFC4180 CSV 文本（CRLF 换行、含表头）。 */
export function toCsv(rows: AuditEventRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  rows.forEach((r, i) => {
    const cells = [
      String(i + 1),
      fmtTime(r.createdAt),
      r.actorName ?? r.actorId ?? '',
      r.action,
      r.resourceType,
      r.resourceId ?? '',
      r.reason ?? '',
      r.requestId ?? '',
    ].map(csvCell);
    lines.push(cells.join(','));
  });
  return lines.join('\r\n');
}

/** 生成打印友好 HTML（含 @media print 样式），浏览器打印可另存为 PDF。 */
export function toPrintHtml(rows: AuditEventRow[]): string {
  const body = rows
    .map((r, i) => {
      const td = (v: string) => `<td>${escapeHtml(v)}</td>`;
      return `<tr>${td(String(i + 1))}${td(fmtTime(r.createdAt))}${td(
        r.actorName ?? r.actorId ?? '',
      )}${td(r.action)}${td(r.resourceType)}${td(r.resourceId ?? '')}${td(
        r.reason ?? '',
      )}${td(r.requestId ?? '')}</tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>审计事件导出</title>
<style>
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; color: #1f2937; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; }
  th { background: #f3f4f6; }
  @media print {
    body { padding: 0; }
    .no-print { display: none; }
    @page { margin: 16mm; }
  }
</style>
</head>
<body>
  <h1>360° 环评系统 · 审计事件导出</h1>
  <div class="meta">共 ${rows.length} 条记录 · 生成于 ${new Date().toISOString()}</div>
  <button class="no-print" onclick="window.print()">打印 / 另存为 PDF</button>
  <table>
    <thead><tr>${CSV_COLUMNS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
