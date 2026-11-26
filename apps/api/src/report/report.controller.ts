import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionGuard } from '../auth/session.guard';
import { CapabilityGuard, RequireCapabilities, CapabilityResource } from '../authz/capability.guard';
import { ReportService } from './report.service';
import { renderMaterialPreview } from './material-preview';
import { MaterialsService } from './materials.service';
import { PolicyService } from '../authz/policy.service';
import type { AuthContext } from '../auth/current-user.decorator';

type UploadFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };

@Controller('cycles')
@UseGuards(SessionGuard)
export class ReportController {
  constructor(private readonly svc: ReportService, private readonly materials: MaterialsService, private readonly policy: PolicyService) {}

  @Get(':cycleId/monthly-report/materials')
  async listMaterials(@CurrentUser() actor: AuthContext, @Param('cycleId', ParseUUIDPipe) cycleId: string) {
    return { data: await this.materials.list(actor, cycleId) };
  }

  /**
   * 管理端/部门端查看某成员材料：三个能力任一命中即可（任一都代表已获该成员可见范围）。
   * progress.read 支持部门范围，因此部长工作台（含被授权人）可直接查看本部门成员材料。
   */
  private async authorizeManagedMaterial(actor: AuthContext, cycleId: string, userId: string) {
    let denied: unknown = null;
    for (const capability of ['management.access','progress.read','report.view'] as const) {
      try {
        await this.policy.assertParticipant(actor,capability,cycleId,userId);
        await this.materials.assertEligibleParticipant(actor,cycleId,userId);
        return;
      } catch (error) { denied = error; }
    }
    throw denied ?? new ForbiddenException({ code: 'FORBIDDEN' });
  }

  @Get(':cycleId/participants/:userId/materials')
  async managedMaterials(@CurrentUser() actor: AuthContext, @Param('cycleId', ParseUUIDPipe) cycleId: string, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.authorizeManagedMaterial(actor,cycleId,userId);
    const result=await this.materials.list({...actor,userId},cycleId);
    return {data:result.materials.map(m=>({...m,versions:m.versions.filter(v=>v.isCurrent && v.ready)})).filter(m=>m.versions.length)};
  }

  @Get(':cycleId/participants/:userId/materials/:versionId/file')
  async managedMaterialFile(@CurrentUser() actor: AuthContext, @Param('cycleId', ParseUUIDPipe) cycleId: string, @Param('userId', ParseUUIDPipe) userId: string, @Param('versionId', ParseUUIDPipe) versionId: string, @Query('download') download: string | undefined, @Res() response: Response) {
    await this.authorizeManagedMaterial(actor,cycleId,userId);
    const check=await this.materials.list({...actor,userId},cycleId);
    if(!check.materials.some(m=>m.versions.some(v=>v.id===versionId && v.isCurrent && v.ready))) throw new BadRequestException({code:'MATERIAL_NOT_AVAILABLE'});
    const original=await this.materials.preview({...actor,userId},cycleId,versionId);
    if(original.kind==='link'){response.redirect(302,original.externalUrl);return;}
    // download=1 取原始文件；否则把 Office 文档转成 PDF 供在线预览
    const file=download==='1'?original:await renderMaterialPreview(original);
    response.setHeader('Content-Type',file.mime);
    response.setHeader('Cache-Control','private, no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    const inline=download!=='1'&&(file.mime==='application/pdf'||file.mime.startsWith('image/')||file.mime.startsWith('text/plain'));
    response.setHeader('Content-Disposition',(inline?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(file.fileName));
    response.setHeader('Content-Length',String(file.buffer.length));
    response.send(file.buffer);
  }

  @Post(':cycleId/monthly-report/materials')
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 50 * 1024 * 1024, files: 10, fields: 2, fieldSize: 64 * 1024 } }))
  async submitMaterials(@CurrentUser() actor: AuthContext, @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @UploadedFiles() files: UploadFile[] | undefined, @Body('metadata') metadata: unknown, @Body('requestId') requestId: unknown) {
    if (!files?.length) throw new BadRequestException({code:'FILE_REQUIRED'});
    if (typeof requestId !== 'string') throw new BadRequestException({code:'SUBMISSION_ID_REQUIRED'});
    return { data: await this.materials.submit(actor, cycleId, files, this.materials.parseMetadata(metadata, files.length), false, requestId) };
  }

  @Get(':cycleId/monthly-report/materials/versions/:versionId/file')
  async materialFile(@CurrentUser() actor: AuthContext, @Param('cycleId', ParseUUIDPipe) cycleId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string, @Query('preview') preview: string | undefined, @Res() response: Response) {
    const original = await this.materials.preview(actor, cycleId, versionId);
    if (original.kind === 'link') { response.redirect(302, original.externalUrl); return; }
    const file = preview === '1' ? await renderMaterialPreview(original) : original;
    response.setHeader('Content-Type', file.mime);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const disposition = file.mime === 'application/pdf' || file.mime.startsWith('image/') || file.mime.startsWith('text/plain') ? 'inline' : 'attachment';
    response.setHeader('Content-Disposition', disposition + "; filename*=UTF-8''" + encodeURIComponent(file.fileName));
    response.setHeader('Content-Length', String(file.buffer.length));
    response.send(file.buffer);
  }

  @Get(':cycleId/monthly-report')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('report.view')
  @CapabilityResource('cycle', 'cycleId')
  async generate(@CurrentUser() actor: AuthContext, @Param('cycleId') cycleId: string) {
    return { data: await this.svc.generate(actor, cycleId) };
  }

  @Get(':cycleId/monthly-reports')
  @UseGuards(CapabilityGuard)
  @RequireCapabilities('report.view')
  @CapabilityResource('cycle', 'cycleId')
  async list(@CurrentUser() actor: AuthContext, @Param('cycleId') cycleId: string) {
    return { data: await this.svc.list(actor, cycleId) };
  }

  @Get(':cycleId/monthly-report/files')
  async listFiles(@CurrentUser() actor: AuthContext, @Param('cycleId') cycleId: string) {
    return { data: await this.svc.listFiles(actor, cycleId) };
  }

  @Get(':cycleId/monthly-report/files/:fileId/preview')
  async previewFile(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId') cycleId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ) {
    const file = await this.svc.previewFile(actor, cycleId, fileId);
    response.setHeader('Content-Type', file.mime || 'application/octet-stream');
    const asciiName = file.fileName.replace(/[^\x20-\x7e]/g, '_');
    response.setHeader('Content-Disposition', `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    response.setHeader('Content-Length', String(file.buffer.length));
    response.send(file.buffer);
  }

  @Post(':cycleId/monthly-report/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async uploadFile(
    @CurrentUser() actor: AuthContext,
    @Param('cycleId') cycleId: string,
    @UploadedFile() file?: UploadFile,
  ) {
    if (!file) throw new BadRequestException({ code: 'FILE_REQUIRED' });
    return { data: await this.svc.uploadFile(actor, cycleId, file) };
  }

  @Post(':cycleId/monthly-report/files/lock')
  async lockFile(@CurrentUser() actor: AuthContext, @Param('cycleId') cycleId: string) {
    return { data: await this.svc.lockFile(actor, cycleId) };
  }

  /** 提交一条云文档链接材料（不入库文件，只存链接） */
  @Post(':cycleId/monthly-report/links')
  async submitLink(@CurrentUser() actor: AuthContext, @Param('cycleId', ParseUUIDPipe) cycleId: string, @Body() body: unknown) {
    return { data: await this.materials.submitLink(actor, cycleId, body) };
  }

  /** 解锁成果包（本人自助，最多锁定 2 次，第 2 次锁定后不可解锁） */
  @Post(':cycleId/monthly-report/unlock')
  async unlockFile(@CurrentUser() actor: AuthContext, @Param('cycleId', ParseUUIDPipe) cycleId: string) {
    return { data: await this.materials.unlock(actor, cycleId) };
  }
}
