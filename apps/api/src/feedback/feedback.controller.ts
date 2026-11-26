import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, type AuthContext } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapabilities, CapabilityResource } from '../authz/capability.guard';
import { FeedbackService } from './feedback.service';
import { FeedbackContextService } from './feedback-context.service';

@Controller()
@UseGuards(SessionGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService, private readonly context: FeedbackContextService) {}

  @Get('feedback-requests/:id/context')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('feedback.manage')
  @CapabilityResource('feedback')
  async detailContext(@CurrentUser() actor: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.context.get(actor, id) };
  }

  @Post('published-results/:id/feedback-requests')
  async createRequest(@CurrentUser() actor: AuthContext, @Param('id') publicationId: string, @Body() body: { reason: string }) {
    return { data: await this.feedback.createRequest(actor, publicationId, body.reason) };
  }

  @Get('feedback-requests/mine')
  async listMine(@CurrentUser() actor: AuthContext) {
    return { data: await this.feedback.listMine(actor) };
  }

  @Get('feedback-requests')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('feedback.manage')
  @CapabilityResource('collection')
  async listRequests(@CurrentUser() actor: AuthContext, @Query('status') status?: string) {
    return { data: await this.feedback.listRequests(actor, status) };
  }

  @Post('feedback-requests/:id/resolve')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('feedback.manage')
  @CapabilityResource('feedback')
  async resolve(@CurrentUser() actor: AuthContext, @Param('id') id: string, @Body() body: { decision: string; note?: string }) {
    return { data: await this.feedback.resolve(actor, id, body.decision as 'APPROVED' | 'REJECTED', body.note) };
  }

  @Post('feedback-requests/:id/rereview')
  @HttpCode(200)
  async openRereview(@CurrentUser() actor: AuthContext, @Param('id') id: string, @Body() body: { reason: string }) {
    return { data: await this.feedback.openRereview(actor, id, body.reason) };
  }

  @Post('feedback-requests/:id/rereview/resolve')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('feedback.manage')
  @CapabilityResource('feedback')
  @HttpCode(200)
  async resolveRereview(@CurrentUser() actor: AuthContext, @Param('id') id: string, @Body() body: { decision: string; note?: string }) {
    return { data: await this.feedback.resolveRereview(actor, id, body.decision as 'APPROVED' | 'REJECTED', body.note) };
  }
}
