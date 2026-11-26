import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/current-user.decorator';
import { AnnouncementService } from './announcement.service';

/**
 * 月评公告。所有登录用户可读（个人端右上角），管理端可写。
 */
@Controller()
@UseGuards(SessionGuard)
export class AnnouncementController {
  constructor(private readonly svc: AnnouncementService) {}

  @Get('announcements/active')
  async active(@CurrentUser() actor: AuthContext) {
    return { data: await this.svc.active(actor) };
  }

  @Get('cycles/:cycleId/announcement')
  async detail(@CurrentUser() actor: AuthContext, @Param('cycleId', ParseUUIDPipe) cycleId: string) {
    return { data: await this.svc.detail(actor, cycleId) };
  }

  @Put('cycles/:cycleId/announcement')
  async save(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @Body() body: { title?: string; body?: string; isPublished?: boolean },
  ) {
    return { data: await this.svc.save(actor, cycleId, body ?? {}) };
  }
}
