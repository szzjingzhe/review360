import { describe, it, expect } from 'vitest';
import { toCsv, toPrintHtml, type AuditEventRow } from '../src/audit.js';

function row(over: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: 'ae-1', orgId: 'org-360', actorId: 'u-admin', actorName: '示例成员01',
    action: 'result.publish', resourceType: 'published_result', resourceId: 'pr-1',
    reason: 'v1', requestId: 'r-1', createdAt: '2026-07-06T09:30:00',
    ...over,
  };
}

describe('toCsv (M7 审计导出)', () => {
  it('含中文表头且按 CRLF 换行', () => {
    const csv = toCsv([row()]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('序号,时间,操作人,操作,资源类型,资源ID,原因,请求ID');
    expect(lines).toHaveLength(2);
  });

  it('字段含逗号/引号/换行时按 RFC4180 转义', () => {
    const csv = toCsv([row({ reason: '含,逗号与"引号"' })]);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain('"含,逗号与""引号"""');
  });

  it('空数据时仅输出表头', () => {
    expect(toCsv([])).toBe('序号,时间,操作人,操作,资源类型,资源ID,原因,请求ID');
  });

  it('序号递增且 actorName 缺失时回退 actorId', () => {
    const csv = toCsv([row({ actorName: null }), row({ id: 'ae-2' })]);
    const lines = csv.split('\r\n');
    const c1 = lines[1].split(',')[0];
    const c2 = lines[2].split(',')[0];
    expect(c1).toBe('1');
    expect(c2).toBe('2');
    expect(lines[1]).toContain('u-admin');
  });
});

describe('toPrintHtml (M7 审计导出 PDF)', () => {
  it('生成含表头与打印样式的 HTML', () => {
    const html = toPrintHtml([row()]);
    expect(html).toContain('<table');
    expect(html).toContain('审计事件导出');
    expect(html).toContain('@media print');
    expect(html).toContain('result.publish');
  });
});
