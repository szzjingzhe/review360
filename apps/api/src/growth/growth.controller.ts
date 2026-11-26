import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards, Res, Header } from '@nestjs/common';
import type {Response} from 'express';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser, type AuthContext } from '../auth/current-user.decorator';
import { GrowthService } from './growth.service';
@Controller()
@UseGuards(SessionGuard)
export class GrowthController {
  constructor(private readonly growth: GrowthService) {}
  @Get('me/growth-analyses')
  @Header('Cache-Control','private, no-store')
  async mine(@CurrentUser() actor: AuthContext) { return { data: await this.growth.mine(actor) }; }
  @Get('me/growth-analyses/:id/reports/:analysisId/pdf')
  async pdf(@CurrentUser() actor:AuthContext,@Param('id',ParseUUIDPipe) id:string,@Param('analysisId',ParseUUIDPipe) analysisId:string,@Res() response:Response) {
    const buffer=await this.growth.pdf(actor,id,analysisId);
    response.setHeader('Content-Type','application/pdf');response.setHeader('Cache-Control','private, no-store');
    response.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent('我的成长报告.pdf'));response.send(buffer);
  }
  @Get('departments/:departmentId/cycles/:cycleId/growth-analyses')
  async department(@CurrentUser() actor:AuthContext,@Param('departmentId',ParseUUIDPipe) departmentId:string,@Param('cycleId',ParseUUIDPipe) cycleId:string) {
    return {data:await this.growth.department(actor,cycleId,departmentId)};
  }
  @Get('management/publications/:id/growth')
  async list(@CurrentUser() actor: AuthContext, @Param('id',ParseUUIDPipe) id: string) { return { data: await this.growth.list(actor,id) }; }
  @Post('management/publications/:id/growth/generate')
  async generate(@CurrentUser() actor: AuthContext, @Param('id',ParseUUIDPipe) id: string) { return { data: await this.growth.generate(actor,id) }; }
  @Post('management/growth/:id/confirm')
  async confirm(@CurrentUser() actor: AuthContext, @Param('id',ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { data: await this.growth.confirm(actor,id,body) };
  }
}
