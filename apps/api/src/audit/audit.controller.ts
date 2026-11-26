import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import { CapabilityGuard, RequireCapabilities } from '../authz/capability.guard';
import { toCsv, toPrintHtml } from '@360/domain';
import { AuditService, type AuditQueryInput } from './audit.service';
import type { AuthContext } from '../auth/current-user.decorator';

/**
 * 审计报表导出（技术文档 §??）。
 * 端点：
 *  - GET /audit/export?format=csv|pdf  导出文件流（audit.export 能力）
 *  - GET /audit/events                  列表预览（同能力，返回 JSON，供页面表格）
 * CSV 加 UTF-8 BOM 便于 Excel 直接打开；PDF 返回打印友好 HTML，浏览器 window.print() 另存。
 */
@Controller('audit')
@UseGuards(SessionGuard)
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Get('export')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('audit.export')
  async export(
    @CurrentUser() actor: AuthContext,
    @Query() q: AuditQueryInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.svc.query(actor, q);
    const stamp = new Date().toISOString().slice(0, 10);
    const format = (q.format ?? 'csv').toLowerCase();
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-events-${stamp}.html"`);
      res.send(toPrintHtml(rows));
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-events-${stamp}.csv"`);
    res.send('﻿' + toCsv(rows)); // BOM 标记，Excel 识别 UTF-8
  }

  @Get('events')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('audit.export')
  async list(@CurrentUser() actor: AuthContext, @Query() q: AuditQueryInput) {
    return { data: await this.svc.query(actor, q) };
  }
}
