import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, type AuthContext } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapabilities, CapabilityResource } from '../authz/capability.guard';
import type { AwardDecision as AwardDecisionValue } from '@360/domain';
import { AwardService } from './award.service';

/**
 * 评优决策 API（技术文档 §11）。
 * 候选排名见 results.controller 的 GET /cycles/:cycleId/award-candidates（M4 已落地）。
 * 本模块仅负责「保存人工评定决定」（award.manage）。
 */
@Controller()
@UseGuards(SessionGuard)
export class AwardController {
  constructor(private readonly award: AwardService) {}

  @Post('awards')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('award.manage')
  @CapabilityResource('participant')
  async saveDecision(
    @CurrentUser() actor: AuthContext,
    @Body() body: {
      cycleId: string;
      targetId: string;
      category?: string;
      decision: AwardDecisionValue;
      reason?: string;
    },
  ) {
    return { data: await this.award.saveDecision(actor, body) };
  }

  /** 某周期已有评优决定（供前端回显；award.manage） */
  @Get('cycles/:cycleId/award-decisions')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('award.manage')
  @CapabilityResource('cycle', 'cycleId')
  async listDecisions(@CurrentUser() actor: AuthContext, @Param('cycleId') cycleId: string) {
    return { data: await this.award.listDecisions(actor, cycleId) };
  }
}
