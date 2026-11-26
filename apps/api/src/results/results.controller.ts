import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, type AuthContext } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapabilities, CapabilityResource } from '../authz/capability.guard';
import { ResultsService } from './results.service';
import { PublishedDirectoryService } from './published-directory.service';
import { PublishService } from './publish.service';

/**
 * 结果构建 / 审批 / 发布 / 个人结果 API（技术文档 §10、§11）。
 * 构建需 calibration.resolve（校准期动作）；审批 result.confirm；
 * 发布 result.publish；评优 award.manage。本人隔离在服务层。
 */
@Controller()
@UseGuards(SessionGuard)
export class ResultsController {
  constructor(
    private readonly results: ResultsService,
    private readonly publish: PublishService,
    private readonly directory: PublishedDirectoryService,
  ) {}

  @Post('cycles/:cycleId/results/build')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('calibration.resolve')
  @CapabilityResource('cycle', 'cycleId')
  @HttpCode(200)
  async buildResults(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId') cycleId: string,
    @Body() body?: { targetId?: string },
  ) {
    return { data: await this.results.buildResults(actor, cycleId, body) };
  }

  @Get('cycles/:cycleId/result-builds')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('result.read_aggregate')
  @CapabilityResource('collection')
  async listBuilds(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId') cycleId: string,
    @Query('status') status?: string,
    @Query('target_id') targetId?: string,
  ) {
    return {
      data: await this.results.listBuilds(actor, cycleId, { status, targetId }),
    };
  }

  @Get('cycles/:cycleId/review-scores')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('calibration.read_raw')
  @CapabilityResource('collection')
  async reviewScores(@CurrentUser() actor: AuthContext, @Param('cycleId') cycleId: string) {
    return { data: await this.results.listReviewScores(actor, cycleId) };
  }

  @Post('result-builds/:id/approve')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('result.confirm')
  @CapabilityResource('build')
  @HttpCode(200)
  async approve(
    @CurrentUser() actor: AuthContext,
    @Param('id') id: string,
    @Body() body: { decision?: string; reason?: string },
  ) {
    return { data: await this.results.approveBuild(actor, id, body) };
  }

  @Post('result-builds/:id/publish')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('result.publish')
  @CapabilityResource('build')
  @HttpCode(200)
  async publishBuild(@CurrentUser() actor: AuthContext, @Param('id') id: string) {
    return { data: await this.publish.publishBuild(actor, id) };
  }

  @Get('published-results')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('result.read_published')
  @CapabilityResource('collection')
  async publishedResults(@CurrentUser() actor: AuthContext) {
    return { data: await this.directory.list(actor) };
  }

  @Get('me/results')
  async myResults(@CurrentUser() actor: AuthContext) {
    return { data: await this.publish.listMyResults(actor) };
  }

  @Get('cycles/:cycleId/award-candidates')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('award.manage')
  @CapabilityResource('cycle', 'cycleId')
  async awardCandidates(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId') cycleId: string,
  ) {
    return { data: await this.publish.awardCandidates(actor, cycleId) };
  }
}
