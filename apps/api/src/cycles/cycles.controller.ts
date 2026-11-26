import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, AuthContext } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapabilities, CapabilityResource } from '../authz/capability.guard';
import { CyclesService } from './cycles.service';
import { RulesetsService } from './rulesets.service';
import { AssignmentService } from './assignment.service';
import { DepartmentProgressService } from './department-progress.service';

/**
 * 周期与规则集 API（PRD §2 管理端 / 技术文档 5.2、§6 状态机）。
 * 读：任何已登录成员；写：cycle.manage / org.manage。
 */
@UseGuards(SessionGuard)
@Controller()
export class CyclesController {
  constructor(
    private readonly cycles: CyclesService,
    private readonly rulesets: RulesetsService,
    private readonly assignments: AssignmentService,
    private readonly deptProgress: DepartmentProgressService,
  ) {}

  // ---------- 规则集 ----------

  @Get('rulesets')
  async listRulesets(@CurrentUser() user: AuthContext) {
    return { data: await this.rulesets.listRulesets(user.orgId) };
  }

  @Get('rulesets/:id')
  async getRuleset(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return { data: await this.rulesets.getRuleset(user.orgId, id) };
  }

  @Post('rulesets')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('org.manage')
  @HttpCode(201)
  async createRuleset(@CurrentUser() user: AuthContext, @Body() body: Record<string, unknown>) {
    return { data: await this.rulesets.createRuleset(user, body) };
  }

  @Post('rulesets/:id/freeze')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('org.manage')
  @HttpCode(200)
  async freezeRuleset(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return { data: await this.rulesets.freezeRuleset(user, id) };
  }

  @Patch('rulesets/:id')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('org.manage')
  async updateRuleset(@CurrentUser() user:AuthContext,@Param('id') id:string,@Body() body:Record<string,unknown>){return {data:await this.rulesets.editDraft(user,id,body)};}
  @Delete('rulesets/:id')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('org.manage')
  async deleteRuleset(@CurrentUser() user:AuthContext,@Param('id') id:string){return {data:await this.rulesets.deleteDraft(user,id)};}
  @Get('cycles/:id/archive-preflight')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle','id')
  async archivePreflight(@CurrentUser() user:AuthContext,@Param('id') id:string){return {data:await this.cycles.archivePreflight(user,id)};}
  @Post('cycles/:id/archive')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle','id')
  async archive(@CurrentUser() user:AuthContext,@Param('id') id:string){return {data:await this.cycles.archiveCycle(user,id)};}

  // ---------- 周期 ----------

  @Get('cycles')
  async listCycles(@CurrentUser() user: AuthContext) {
    return { data: await this.cycles.listCycles(user.orgId) };
  }

  @Get('cycles/:id')
  async getCycle(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return { data: await this.cycles.getCycle(user.orgId, id) };
  }

  /** 部门级进度聚合（progress.read；对象范围由正式部门或 ORG 级授权判定） */
  @Get('cycles/:id/departments/:deptId/progress')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('progress.read')
  @CapabilityResource('department', 'id')
  async departmentProgress(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Param('deptId') deptId: string,
  ) {
    return { data: await this.deptProgress.get(user, id, deptId) };
  }

  @Post('cycles')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @HttpCode(201)
  async createCycle(@CurrentUser() user: AuthContext, @Body() body: Record<string, unknown>) {
    return { data: await this.cycles.createCycle(user, body) };
  }

  @Post('cycles/:id/participants/refresh')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async refreshParticipants(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return { data: await this.cycles.refreshParticipants(user, id) };
  }

  @Patch('cycles/:id')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  async updateCycle(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return { data: await this.cycles.updateCycle(user, id, body) };
  }

  /** 完整更新草稿周期；与 PATCH 保持同一服务实现，供客户端按 REST 约定使用。 */
  @Put('cycles/:id')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  async replaceCycle(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return { data: await this.cycles.updateCycle(user, id, body) };
  }

  @Delete('cycles/:id')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async deleteCycle(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return { data: await this.cycles.deleteCycle(user, id) };
  }

  @Post('cycles/:id/submit')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async submitCycle(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return { data: await this.cycles.submitCycle(user, id) };
  }

  @Post('cycles/:id/cancel')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async cancelCycle(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return { data: await this.cycles.cancelCycle(user, id, body.reason) };
  }

  @Post('cycles/:id/restore')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async restoreCycle(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return { data: await this.cycles.restoreCycle(user, id, body.reason) };
  }

  @Post('cycles/:id/pause')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async pauseCycle(@CurrentUser() user:AuthContext,@Param('id') id:string,@Body() body:Record<string,unknown>) {
    return {data:await this.cycles.pauseCycle(user,id,body.reason)};
  }

  @Post('cycles/:id/resume')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async resumeCycle(@CurrentUser() user:AuthContext,@Param('id') id:string,@Body() body:Record<string,unknown>) {
    return {data:await this.cycles.resumeCycle(user,id,body.reason)};
  }

  // ---------- 分配（M2.4：预检 / 开期锁定 / 替补） ----------
  @Get('cycles/:id/assignment/manual')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('assignment.manage')
  @CapabilityResource('collection')
  async manualRelations(@CurrentUser() user:AuthContext,@Param('id') id:string) {
    return {data:await this.assignments.manualRelations(user,id)};
  }

  @Post('cycles/:id/assignment/manual')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('assignment.manage')
  @CapabilityResource('collection')
  @HttpCode(200)
  async setManualRelation(@CurrentUser() user:AuthContext,@Param('id') id:string,@Body() body:Record<string,unknown>) {
    return {data:await this.assignments.setManualRelation(user,id,body)};
  }

  @Delete('cycles/:id/assignment/manual')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('assignment.manage')
  @CapabilityResource('collection')
  async removeManualRelation(@CurrentUser() user:AuthContext,@Param('id') id:string,@Body() body:Record<string,unknown>) {
    return {data:await this.assignments.setManualRelation(user,id,body,true)};
  }

  @Post('cycles/:id/assignment/preview')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('assignment.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async previewAssignment(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return { data: await this.assignments.previewRun(user, id) };
  }

  @Post('cycles/:id/assignment/confirm-preview')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('assignment.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async confirmAssignmentPreview(@CurrentUser() user:AuthContext,@Param('id') id:string,@Body() body:Record<string,unknown>) {
    return {data:await this.assignments.confirmPreview(user,id,body.run_id)};
  }

  @Get('cycles/:id/assignment/confirmed-preview')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('assignment.manage')
  @CapabilityResource('cycle', 'id')
  async confirmedAssignmentPreview(@CurrentUser() user:AuthContext,@Param('id') id:string) {
    return {data:await this.assignments.confirmedPreview(user,id)};
  }

  @Get('cycles/:id/assignment-runs')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('assignment.manage')
  @CapabilityResource('cycle', 'id')
  async listAssignmentRuns(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return { data: await this.assignments.listRuns(user.orgId, id) };
  }

  @Post('cycles/:id/open')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('cycle.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async openCycle(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const runId = typeof body?.run_id === 'string' && body.run_id ? body.run_id : undefined;
    return { data: await this.assignments.openCycle(user, id, runId) };
  }

  @Post('cycles/:id/assignments/:assignmentId/replace')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('assignment.manage')
  @CapabilityResource('cycle', 'id')
  @HttpCode(200)
  async replaceAssignment(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return { data: await this.assignments.replaceAssignment(user, id, assignmentId, body) };
  }
}
