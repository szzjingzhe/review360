import type { Response } from 'express';
import { ReviewMaterialsService } from './review-materials.service';
import {
  Res,
  ParseUUIDPipe,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, type AuthContext } from '../auth/current-user.decorator';
import { ReviewsService } from './reviews.service';
import { IdempotencyService } from './idempotency.service';

@Controller()
@UseGuards(SessionGuard)
export class ReviewsController {
  constructor(
    private readonly materials: ReviewMaterialsService,
    private readonly reviews: ReviewsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('cycles/:cycleId/assignments/me')
  async listMyTasks(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId') cycleId: string,
  ) {
    return { data: await this.reviews.listMyTasks(actor, cycleId) };
  }

  @Post('cycles/:cycleId/self-review')
  @HttpCode(201)
  async ensureSelfReview(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId') cycleId: string,
  ) {
    return { data: await this.reviews.ensureSelfReview(actor, cycleId) };
  }

  @Get('reviews/:reviewId')
  async getDetail(
    @CurrentUser() actor: AuthContext,
    @Param('reviewId') reviewId: string,
  ) {
    return { data: await this.reviews.getReviewDetail(actor, reviewId) };
  }

  @Get('reviews/:reviewId/materials')
  async listMaterials(@CurrentUser() actor:AuthContext,@Param('reviewId',ParseUUIDPipe) reviewId:string) {
    return {data:await this.materials.list(actor,reviewId)};
  }

  @Get('reviews/:reviewId/materials/:versionId/file')
  async materialFile(@CurrentUser() actor:AuthContext,@Param('reviewId',ParseUUIDPipe) reviewId:string,
    @Param('versionId',ParseUUIDPipe) versionId:string,@Res() response:Response) {
    const file=await this.materials.file(actor,reviewId,versionId);
    if('externalUrl' in file){response.redirect(302,file.externalUrl);return;}
    response.setHeader('Content-Type',file.mime);
    response.setHeader('Cache-Control','private, no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Content-Disposition',(file.mime==='application/pdf'?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(file.fileName));
    response.send(file.buffer);
  }

  @Put('reviews/:reviewId/draft')
  async saveDraft(
    @CurrentUser() actor: AuthContext,
    @Param('reviewId') reviewId: string,
    @Body() body: {
      items?: Array<{ itemId: string; score: number; reason?: string | null }>;
      overallReason?: string | null;
      comment?: string | null;
      nextPlan?: string | null;
      readConfirmed?: boolean;
      reportVersionId?: string | null;
    },
  ) {
    return { data: await this.reviews.saveDraft(actor, reviewId, body) };
  }

  @Post('reviews/:reviewId/submit')
  @HttpCode(200)
  async submit(
    @CurrentUser() actor: AuthContext,
    @Param('reviewId') reviewId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Body() body?: { force?: boolean; payload?: {
      items?: Array<{ itemId: string; score: number; reason?: string | null }>;
      overallReason?: string | null;
      comment?: string | null;
      nextPlan?: string | null;
      readConfirmed?: boolean;
    } },
  ) {
    // 带 Idempotency-Key 时重复提交直接回放上次结果（PRD A13）
    const result = await this.idempotency.run(
      actor.userId,
      `POST /reviews/${reviewId}/submit`,
      idempotencyKey,
      body ?? null,
      (client) => this.reviews.submitReview(actor, reviewId, body, client),
    );
    return { data: result };
  }

  /**
   * 提交更正修订版（PRD §9.1：更正必须由原评价人形成修订版，核验不提供直接改分）。
   * 需存在针对当前修订版、且要求原评价人处理（建议更正 / 退回补充）的 OPEN 核验项，且在修订窗口内。
   */
  @Post('reviews/:reviewId/revision')
  @HttpCode(200)
  async submitRevision(
    @CurrentUser() actor: AuthContext,
    @Param('reviewId') reviewId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Body() body?: { force?: boolean; payload?: {
      items?: Array<{ itemId: string; score: number; reason?: string | null }>;
      overallReason?: string | null;
      comment?: string | null;
      nextPlan?: string | null;
      readConfirmed?: boolean;
    } },
  ) {
    const result = await this.idempotency.run(
      actor.userId,
      `POST /reviews/${reviewId}/revision`,
      idempotencyKey,
      body ?? null,
      (client) => this.reviews.submitRevision(actor, reviewId, body, client),
    );
    return { data: result };
  }
}
