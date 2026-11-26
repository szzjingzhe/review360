import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/current-user.decorator';
import { LlmProviderService } from './llm-provider.service';
import type { LlmProviderInput } from './llm-provider.service';

/** 系统设置 → 模型配置：管理组织可用的大模型服务与密钥。 */
@Controller('settings/llm')
@UseGuards(SessionGuard)
export class LlmProviderController {
  constructor(private readonly svc: LlmProviderService) {}

  @Get()
  async list(@CurrentUser() actor: AuthContext) {
    return { data: await this.svc.list(actor) };
  }

  @Post()
  async create(@CurrentUser() actor: AuthContext, @Body() body: LlmProviderInput) {
    return { data: await this.svc.create(actor, body ?? {}) };
  }

  @Put(':id')
  async update(
    @CurrentUser() actor: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LlmProviderInput,
  ) {
    return { data: await this.svc.update(actor, id, body ?? {}) };
  }

  @Delete(':id')
  async remove(@CurrentUser() actor: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.svc.remove(actor, id) };
  }

  @Post(':id/default')
  async setDefault(@CurrentUser() actor: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.svc.setDefault(actor, id) };
  }

  @Post(':id/test')
  async test(@CurrentUser() actor: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.svc.test(actor, id) };
  }
}
