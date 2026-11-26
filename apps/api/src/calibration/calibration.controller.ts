import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, type AuthContext } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapabilities, CapabilityResource } from '../authz/capability.guard';
import { CalibrationService } from './calibration.service';

/**
 * 核验与校准 API（PRD §9、技术文档 §9.3）。
 * 读原始评分需最强能力 calibration.read_raw（最小授权）；处置需 calibration.resolve。
 * 本人隔离在 SQL 谓词与领域规则双层把关，不依赖前端隐藏。
 */
@Controller()
@UseGuards(SessionGuard)
export class CalibrationController {
  constructor(private readonly calibration: CalibrationService) {}

  @Get('calibration-cases')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('calibration.read_raw')
  @CapabilityResource('collection')
  async listCases(
    @CurrentUser() actor: AuthContext,
    @Query('cycle_id') cycleId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const data = await this.calibration.listCases(actor, {
      cycleId,
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
    return {
      data: data.items,
      page: data.page,
      page_size: data.pageSize,
      total: data.total,
    };
  }

  @Post('calibration-cases/:id/actions')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('calibration.resolve')
  @CapabilityResource('case')
  @HttpCode(200)
  async actOnCase(
    @CurrentUser() actor: AuthContext,
    @Param('id') id: string,
    @Body() body: { action?: string; reason?: string; assigneeId?: string | null },
  ) {
    return { data: await this.calibration.actOnCase(actor, id, body) };
  }

  /** 运维补偿：按期扫描并建立核验项（正常路径由 worker 在 CLOSE 相位执行） */
  @Post('cycles/:cycleId/calibration-scan')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('calibration.resolve')
  @CapabilityResource('cycle', 'cycleId')
  @HttpCode(200)
  async scanCycle(@CurrentUser() actor: AuthContext, @Param('cycleId') cycleId: string) {
    return { data: await this.calibration.scanCycle(actor, cycleId) };
  }
}
