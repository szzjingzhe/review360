import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';
import { validateMaterialFile } from './material-format';
import { lockMaterialPackage } from './material-lock';

export type MaterialFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };
export type MaterialMeta = { name: string; type: string; note?: string; materialId?: string };
export type MaterialLinkInput = { name: string; type: string; url: string; note?: string; materialId?: string };
const TYPES = ['MONTHLY_REPORT','PROJECT','COMPETITION','WORK_PROOF','PRESENTATION','OTHER'];
const LINK_TYPES = ['PROJECT','COMPETITION','WORK_PROOF','PRESENTATION','OTHER'];
const LINK_HOSTS = ['feishu.cn','larksuite.com','feishu.net','feishu-boe.cn','larkoffice.com'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LOCK_COUNT = 2;
export type MaterialPreview = { kind:'link'; externalUrl:string; fileName:string; mime:string } | { kind:'file'; buffer:Buffer; fileName:string; mime:string };

@Injectable()
export class MaterialsService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  async assertEligibleParticipant(actor: AuthContext, cycleId: string, userId: string) {
    const row=await this.db.query("SELECT 1 FROM cycle_participants WHERE org_id=$1 AND cycle_id=$2 AND user_id=$3 AND eligibility='ELIGIBLE'",[actor.orgId,cycleId,userId]);
    if(!row.rowCount) throw new NotFoundException({code:'RESOURCE_NOT_FOUND'});
  }

  async list(actor: AuthContext, cycleId: string) {
    const cyc = await this.db.query('SELECT status,close_at,self_close_at FROM cycles WHERE id=$1 AND org_id=$2', [cycleId,actor.orgId]);
    if (!cyc.rowCount) throw new NotFoundException({code:'CYCLE_NOT_FOUND'});
    // 材料上传属于自评阶段：自评截止优先于周期截止
    const uploadDeadline = cyc.rows[0].self_close_at ?? cyc.rows[0].close_at;
    const pkg = await this.db.query(`SELECT mr.*,
      EXISTS(SELECT 1 FROM reviews r WHERE r.org_id=mr.org_id AND r.cycle_id=mr.cycle_id AND r.target_id=mr.user_id AND r.status='SUBMITTED') AS evaluated
      FROM monthly_reports mr WHERE mr.org_id=$1 AND mr.cycle_id=$2 AND mr.user_id=$3`, [actor.orgId,cycleId,actor.userId]);
    const report = pkg.rows[0];
    const materialLocked = !!(report?.locked_at || report?.manual_locked_at || report?.evaluated);
    const lockReason = report?.manual_locked_at ? 'MANUAL_LOCKED'
      : report?.locked_at ? 'LOCKED'
      : report?.evaluated ? 'EVALUATED'
      : cyc.rows[0].status !== 'REVIEWING' || uploadDeadline && Date.now()>=new Date(uploadDeadline).getTime() ? 'CYCLE_CLOSED'
      : null;
    const lockCount = Number(report?.lock_count ?? 0);
    const canUnlock = !!(report?.manual_locked_at);
    const lockSummary = { lockCount, maxLockCount: MAX_LOCK_COUNT, canUnlock, manualLocked: !!report?.manual_locked_at, unlockedAt: report?.unlocked_at ?? null };
    if (!report) return {materials:[],locked:!!lockReason,lockReason,...lockSummary};
    const materials = await this.db.query('SELECT id,name,material_type FROM monthly_materials WHERE report_id=$1 AND org_id=$2 ORDER BY (material_type=\'MONTHLY_REPORT\') DESC,created_at,id', [report.id,actor.orgId]);
    const rows = await this.db.query(`
      SELECT m.id AS material_id,v.id,v.version,v.original_name,v.size_bytes,v.mime,v.version_note,v.created_at,
        coalesce(u.display_name,owner.display_name) AS uploader,
        CASE WHEN v.preview_status='FAILED' OR v.scan_status='FAILED' THEN 'FAILED'
          WHEN v.preview_status='READY' AND v.scan_status='PASSED' THEN 'READY' ELSE 'PROCESSING' END AS status,
        v.id=$2 AS is_current, NULL::text AS external_url
      FROM monthly_materials m JOIN report_versions v ON v.report_id=m.report_id
      JOIN users owner ON owner.id=$3 LEFT JOIN users u ON u.id=v.uploaded_by
      WHERE m.report_id=$1 AND m.material_type='MONTHLY_REPORT'
      UNION ALL
      SELECT m.id,v.id,v.version,coalesce(v.original_name,'云文档'),v.size_bytes,v.mime,v.version_note,v.created_at,u.display_name,'READY',
        v.version=(SELECT max(version) FROM monthly_material_versions WHERE material_id=m.id),v.external_url
      FROM monthly_materials m JOIN monthly_material_versions v ON v.material_id=m.id
      JOIN users u ON u.id=v.uploaded_by WHERE m.report_id=$1 AND m.material_type<>'MONTHLY_REPORT'
      ORDER BY version DESC`, [report.id,report.active_version_id,actor.userId]);
    return {locked:!!lockReason,lockReason,...lockSummary,materials:materials.rows.map(m=>({id:m.id,name:m.name,type:m.material_type,isPrimary:m.material_type==='MONTHLY_REPORT',versions:rows.rows.filter(v=>v.material_id===m.id).map(v=>({
      id:v.id,version:v.version,fileName:v.original_name,sizeBytes:Number(v.size_bytes),mime:v.mime,note:v.version_note,
      createdAt:v.created_at,uploadedBy:v.uploader,isCurrent:v.is_current,ready:v.status==='READY',status:materialLocked?'LOCKED':v.status,
      externalUrl:v.external_url ?? null,isLink:!!v.external_url,
    }))}))};
  }

  parseMetadata(value: unknown, count: number): MaterialMeta[] {
    let data: unknown;
    try { data=typeof value==='string'?JSON.parse(value):value; } catch { throw new BadRequestException({code:'INVALID_MATERIAL_METADATA'}); }
    if (!Array.isArray(data) || data.length!==count || !count || count>10) throw new BadRequestException({code:'INVALID_MATERIAL_METADATA'});
    return data.map(item=>{
      if (!item || typeof item.name!=='string' || !item.name.trim() || item.name.trim().length>200 || !TYPES.includes(item.type)
        || (item.note!==undefined && (typeof item.note!=='string'||item.note.length>300))
        || (item.materialId!==undefined && (typeof item.materialId!=='string'||!UUID.test(item.materialId)))) throw new BadRequestException({code:'INVALID_MATERIAL_METADATA'});
      return {name:item.name.trim(),type:item.type,note:item.note??'',materialId:item.materialId};
    });
  }

  parseLinkInput(value: unknown): MaterialLinkInput {
    const item=(value??{}) as Partial<MaterialLinkInput>;
    if (typeof item.name!=='string' || !item.name.trim() || item.name.trim().length>200) throw new BadRequestException({code:'INVALID_MATERIAL_METADATA'});
    if (typeof item.type!=='string' || !LINK_TYPES.includes(item.type)) throw new BadRequestException({code:'INVALID_LINK_TYPE'});
    if (typeof item.url!=='string' || !item.url.trim()) throw new BadRequestException({code:'INVALID_LINK_URL'});
    if (item.note!==undefined && (typeof item.note!=='string' || item.note.length>300)) throw new BadRequestException({code:'INVALID_MATERIAL_METADATA'});
    if (item.materialId!==undefined && (typeof item.materialId!=='string' || !UUID.test(item.materialId))) throw new BadRequestException({code:'INVALID_MATERIAL_METADATA'});
    return {name:item.name.trim(),type:item.type,url:this.normalizeLink(item.url),note:item.note??'',materialId:item.materialId};
  }

  private normalizeLink(raw: string): string {
    let url: URL;
    try { url=new URL(raw.trim()); } catch { throw new BadRequestException({code:'INVALID_LINK_URL'}); }
    if (url.protocol!=='https:') throw new BadRequestException({code:'INVALID_LINK_URL'});
    const host=url.hostname.toLowerCase();
    if (!LINK_HOSTS.some(d=>host===d||host.endsWith('.'+d))) throw new BadRequestException({code:'LINK_DOMAIN_NOT_SUPPORTED'});
    if (url.toString().length>1000) throw new BadRequestException({code:'INVALID_LINK_URL'});
    return url.toString();
  }

  async submit(actor: AuthContext, cycleId: string, files: MaterialFile[], metadata: MaterialMeta[], legacyUpdate = false, requestId?: string) {
    metadata=this.parseMetadata(metadata,files.length);
    const formats=files.map(file=>validateMaterialFile(file));
    if (requestId && !UUID.test(requestId)) throw new BadRequestException({code:'INVALID_SUBMISSION_ID'});
    const payloadHash=createHash('sha256').update(JSON.stringify(metadata));
    files.forEach(file=>payloadHash.update(file.buffer));
    const checksum=payloadHash.digest('hex');
    const client=await this.db.connect(), written:string[]=[];
    try {
      await client.query('BEGIN');
      await lockMaterialPackage(client,actor.orgId,cycleId,actor.userId);
      if (requestId) {
        const previous=await client.query('SELECT org_id,user_id,cycle_id,payload_hash FROM material_submission_batches WHERE id=$1',[requestId]);
        if(previous.rowCount) {
          const row=previous.rows[0];
          if(row.org_id!==actor.orgId||row.user_id!==actor.userId||row.cycle_id!==cycleId||row.payload_hash!==checksum) throw new ConflictException({code:'SUBMISSION_ID_CONFLICT'});
          await client.query('COMMIT');
          return this.list(actor,cycleId);
        }
      }
      const cyc=await client.query('SELECT status,close_at,self_close_at FROM cycles WHERE id=$1 AND org_id=$2 FOR SHARE',[cycleId,actor.orgId]);
      if (!cyc.rowCount) throw new NotFoundException({code:'CYCLE_NOT_FOUND'});
      const uploadDeadline=cyc.rows[0].self_close_at??cyc.rows[0].close_at;
      if (cyc.rows[0].status!=='REVIEWING'||uploadDeadline && Date.now()>=new Date(uploadDeadline).getTime()) throw new BadRequestException({code:'REPORT_UPLOAD_CLOSED'});
      if(!(await client.query("SELECT 1 FROM cycle_participants WHERE cycle_id=$1 AND org_id=$2 AND user_id=$3 AND eligibility='ELIGIBLE'",[cycleId,actor.orgId,actor.userId])).rowCount)throw new ForbiddenException({code:'NOT_CYCLE_PARTICIPANT'});
      let pkg=await client.query('SELECT id,active_version_id,locked_at,manual_locked_at FROM monthly_reports WHERE cycle_id=$1 AND org_id=$2 AND user_id=$3 FOR UPDATE',[cycleId,actor.orgId,actor.userId]);
      const evaluated=await client.query(`SELECT 1 FROM reviews WHERE cycle_id=$1 AND org_id=$2 AND target_id=$3 AND status='SUBMITTED' LIMIT 1`,[cycleId,actor.orgId,actor.userId]);
      if (pkg.rows[0]?.locked_at || pkg.rows[0]?.manual_locked_at || evaluated.rowCount) throw new ForbiddenException({code:'REPORT_LOCKED'});
      if (!pkg.rowCount) pkg=await client.query('INSERT INTO monthly_reports(id,cycle_id,org_id,user_id) VALUES($1,$2,$3,$4) RETURNING id,active_version_id,locked_at,manual_locked_at',[randomUUID(),cycleId,actor.orgId,actor.userId]);
      const report=pkg.rows[0];
      if (legacyUpdate && report.active_version_id) metadata[0].materialId=report.id;
      const targets=metadata.map(m=>m.materialId).filter(Boolean);
      if (new Set(targets).size!==targets.length) throw new BadRequestException({code:'DUPLICATE_MATERIAL_UPDATE'});
      const dir=process.env.REPORT_STORAGE_DIR||join(process.cwd(),'storage','reports');
      await mkdir(dir,{recursive:true});
      for (let i=0;i<files.length;i++) {
        const file=files[i],meta=metadata[i],format=formats[i];
        let materialId:string;
        if (meta.materialId) {
          const existing=await client.query('SELECT id,material_type FROM monthly_materials WHERE id=$1 AND report_id=$2 AND org_id=$3',[meta.materialId,report.id,actor.orgId]);
          if (!existing.rowCount) throw new NotFoundException({code:'MATERIAL_NOT_FOUND'});
          if (existing.rows[0].material_type!==meta.type) throw new BadRequestException({code:'MATERIAL_TYPE_IMMUTABLE'});
          materialId=existing.rows[0].id;
          await client.query('UPDATE monthly_materials SET name=$1 WHERE id=$2',[meta.name,materialId]);
        } else {
          if (meta.type==='MONTHLY_REPORT') {
            const main=await client.query("SELECT 1 FROM monthly_materials WHERE report_id=$1 AND material_type='MONTHLY_REPORT'",[report.id]);
            if (main.rowCount) throw new ConflictException({code:'PRIMARY_REPORT_EXISTS'});
          }
          materialId=meta.type==='MONTHLY_REPORT'?report.id:randomUUID();
          await client.query('INSERT INTO monthly_materials(id,report_id,org_id,material_type,name) VALUES($1,$2,$3,$4,$5)',[materialId,report.id,actor.orgId,meta.type,meta.name]);
        }
        const primary=meta.type==='MONTHLY_REPORT';
        const next=await client.query(primary?'SELECT coalesce(max(version),0)+1 AS n FROM report_versions WHERE report_id=$1':'SELECT coalesce(max(version),0)+1 AS n FROM monthly_material_versions WHERE material_id=$1',[primary?report.id:materialId]);
        const version=Number(next.rows[0].n),id=randomUUID();
        const diskPath=join(dir,actor.orgId+'_'+cycleId+'_'+actor.userId+'_'+id+'.'+format.ext);
        try { await writeFile(diskPath,file.buffer,{flag:'wx'});written.push(diskPath); }
        catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')await unlink(diskPath).catch(()=>undefined);throw error; }
        let originalName=file.originalname;
        if (/[ÃÂæåçèéêëìíîïðñòóôõö÷øùúûüýþ]/.test(originalName)) { const decoded=Buffer.from(originalName,'latin1').toString('utf8');if(!decoded.includes('\uFFFD'))originalName=decoded; }
        const args=[id,actor.orgId,primary?report.id:materialId,version,diskPath,basename(originalName),file.size,format.mime,createHash('sha256').update(file.buffer).digest('hex'),actor.userId,meta.note];
        if (primary) {
          await client.query(`INSERT INTO report_versions(id,org_id,report_id,version,object_key,original_name,size_bytes,mime,sha256,uploaded_by,version_note,scan_status,preview_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PASSED','READY')`,args);
          await client.query('UPDATE monthly_reports SET active_version_id=$1 WHERE id=$2',[id,report.id]);
        } else await client.query(`INSERT INTO monthly_material_versions(id,org_id,material_id,version,object_key,original_name,size_bytes,mime,sha256,uploaded_by,version_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,args);
      }
      await client.query('UPDATE monthly_reports SET updated_at=now(),row_version=row_version+1 WHERE id=$1',[report.id]);
      await client.query(`UPDATE review_drafts SET data_json=jsonb_set(data_json,'{readConfirmed}','false'),report_version_id=NULL,row_version=row_version+1,updated_at=now()
        WHERE org_id=$1 AND cycle_id=$2 AND target_id=$3`,[actor.orgId,cycleId,actor.userId]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'material.submit','monthly_report',$3,$4)`,[actor.orgId,actor.userId,report.id,'files='+files.length]);
      if(requestId)await client.query('INSERT INTO material_submission_batches(id,org_id,user_id,cycle_id,payload_hash) VALUES($1,$2,$3,$4,$5)',[requestId,actor.orgId,actor.userId,cycleId,checksum]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK');await Promise.all(written.map(path=>unlink(path).catch(()=>undefined)));throw e; }
    finally { client.release(); }
    return this.list(actor,cycleId);
  }

  /** 提交一条云文档链接材料（不落文件，他评与部长可直接点开） */
  async submitLink(actor: AuthContext, cycleId: string, raw: unknown) {
    const meta=this.parseLinkInput(raw);
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      await lockMaterialPackage(client,actor.orgId,cycleId,actor.userId);
      const cyc=await client.query('SELECT status,close_at,self_close_at FROM cycles WHERE id=$1 AND org_id=$2 FOR SHARE',[cycleId,actor.orgId]);
      if (!cyc.rowCount) throw new NotFoundException({code:'CYCLE_NOT_FOUND'});
      const deadline=cyc.rows[0].self_close_at??cyc.rows[0].close_at;
      if (cyc.rows[0].status!=='REVIEWING'||deadline && Date.now()>=new Date(deadline).getTime()) throw new BadRequestException({code:'REPORT_UPLOAD_CLOSED'});
      if(!(await client.query("SELECT 1 FROM cycle_participants WHERE cycle_id=$1 AND org_id=$2 AND user_id=$3 AND eligibility='ELIGIBLE'",[cycleId,actor.orgId,actor.userId])).rowCount)throw new ForbiddenException({code:'NOT_CYCLE_PARTICIPANT'});
      let pkg=await client.query('SELECT id,locked_at,manual_locked_at FROM monthly_reports WHERE cycle_id=$1 AND org_id=$2 AND user_id=$3 FOR UPDATE',[cycleId,actor.orgId,actor.userId]);
      const evaluated=await client.query(`SELECT 1 FROM reviews WHERE cycle_id=$1 AND org_id=$2 AND target_id=$3 AND status='SUBMITTED' LIMIT 1`,[cycleId,actor.orgId,actor.userId]);
      if (pkg.rows[0]?.locked_at || pkg.rows[0]?.manual_locked_at || evaluated.rowCount) throw new ForbiddenException({code:'REPORT_LOCKED'});
      if (!pkg.rowCount) pkg=await client.query('INSERT INTO monthly_reports(id,cycle_id,org_id,user_id) VALUES($1,$2,$3,$4) RETURNING id,locked_at,manual_locked_at',[randomUUID(),cycleId,actor.orgId,actor.userId]);
      const report=pkg.rows[0];
      let materialId:string;
      if (meta.materialId) {
        const existing=await client.query('SELECT id,name,material_type FROM monthly_materials WHERE id=$1 AND report_id=$2 AND org_id=$3',[meta.materialId,report.id,actor.orgId]);
        if (!existing.rowCount) throw new NotFoundException({code:'MATERIAL_NOT_FOUND'});
        if (existing.rows[0].material_type==='MONTHLY_REPORT') throw new BadRequestException({code:'LINK_PRIMARY_NOT_ALLOWED'});
        materialId=existing.rows[0].id;
        await client.query('UPDATE monthly_materials SET name=$1 WHERE id=$2',[meta.name,materialId]);
      } else {
        materialId=randomUUID();
        await client.query('INSERT INTO monthly_materials(id,report_id,org_id,material_type,name) VALUES($1,$2,$3,$4,$5)',[materialId,report.id,actor.orgId,meta.type,meta.name]);
      }
      const next=await client.query('SELECT coalesce(max(version),0)+1 AS n FROM monthly_material_versions WHERE material_id=$1',[materialId]);
      const version=Number(next.rows[0].n),versionId=randomUUID();
      await client.query(`INSERT INTO monthly_material_versions(id,org_id,material_id,version,object_key,external_url,original_name,size_bytes,mime,sha256,uploaded_by,version_note)
        VALUES($1,$2,$3,$4,NULL,$5,$6,1,'text/uri-list',$7,$8,$9)`,
        [versionId,actor.orgId,materialId,version,meta.url,'云文档链接',createHash('sha256').update(meta.url).digest('hex'),actor.userId,meta.note]);
      await client.query('UPDATE monthly_reports SET updated_at=now(),row_version=row_version+1 WHERE id=$1',[report.id]);
      await client.query(`UPDATE review_drafts SET data_json=jsonb_set(data_json,'{readConfirmed}','false'),report_version_id=NULL,row_version=row_version+1,updated_at=now()
        WHERE org_id=$1 AND cycle_id=$2 AND target_id=$3`,[actor.orgId,cycleId,actor.userId]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'material.submit','monthly_report',$3,$4)`,[actor.orgId,actor.userId,report.id,'link='+meta.url.slice(0,200)]);
      await client.query('COMMIT');
    } catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    return this.list(actor,cycleId);
  }

  async lock(actor: AuthContext,cycleId:string) {
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');await lockMaterialPackage(client,actor.orgId,cycleId,actor.userId);
      const cycle=await client.query('SELECT status,close_at,self_close_at FROM cycles WHERE id=$1 AND org_id=$2 FOR SHARE',[cycleId,actor.orgId]);
      const lockDeadline=cycle.rows[0]?.self_close_at??cycle.rows[0]?.close_at;
      if(!cycle.rowCount||cycle.rows[0].status!=='REVIEWING'||lockDeadline&&Date.now()>=new Date(lockDeadline).getTime()) throw new BadRequestException({code:'REPORT_UPLOAD_CLOSED'});
      const report=await client.query(`SELECT mr.id,mr.lock_count,mr.manual_locked_at,rv.scan_status,rv.preview_status FROM monthly_reports mr LEFT JOIN report_versions rv ON rv.id=mr.active_version_id
        WHERE mr.org_id=$1 AND mr.cycle_id=$2 AND mr.user_id=$3 FOR UPDATE OF mr`,[actor.orgId,cycleId,actor.userId]);
      if (!report.rowCount) throw new NotFoundException({code:'REPORT_NOT_FOUND'});
      const row=report.rows[0];
      if (row.manual_locked_at) return {locked:true,lockCount:Number(row.lock_count),alreadyLocked:true};
      if (Number(row.lock_count)>=MAX_LOCK_COUNT) throw new BadRequestException({code:'LOCK_LIMIT_REACHED'});
      if (row.scan_status && (row.scan_status!=='PASSED'||row.preview_status!=='READY')) throw new BadRequestException({code:'PRIMARY_REPORT_NOT_READY'});
      await client.query('UPDATE monthly_reports SET manual_locked_at=now(),lock_count=lock_count+1,updated_at=now() WHERE id=$1',[row.id]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'material.lock','monthly_report',$3,$4)`,[actor.orgId,actor.userId,row.id,'用户确认锁定整个成果包（第 '+(Number(row.lock_count)+1)+' 次）']);
      await client.query('COMMIT');return {locked:true,lockCount:Number(row.lock_count)+1};
    } catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }

  async unlock(actor: AuthContext,cycleId:string) {
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');await lockMaterialPackage(client,actor.orgId,cycleId,actor.userId);
      const cycle=await client.query('SELECT status,close_at,self_close_at FROM cycles WHERE id=$1 AND org_id=$2 FOR SHARE',[cycleId,actor.orgId]);
      if(!cycle.rowCount) throw new NotFoundException({code:'CYCLE_NOT_FOUND'});
      const deadline=cycle.rows[0]?.self_close_at??cycle.rows[0]?.close_at;
      if(cycle.rows[0].status!=='REVIEWING'||deadline&&Date.now()>=new Date(deadline).getTime()) throw new BadRequestException({code:'REPORT_UPLOAD_CLOSED'});
      const report=await client.query('SELECT id,lock_count,manual_locked_at,locked_at FROM monthly_reports WHERE org_id=$1 AND cycle_id=$2 AND user_id=$3 FOR UPDATE',[actor.orgId,cycleId,actor.userId]);
      if (!report.rowCount) throw new NotFoundException({code:'REPORT_NOT_FOUND'});
      const row=report.rows[0];
      if (!row.manual_locked_at) throw new BadRequestException({code:'MATERIAL_NOT_LOCKED'});
      const evaluated=await client.query(`SELECT 1 FROM reviews WHERE cycle_id=$1 AND org_id=$2 AND target_id=$3 AND status='SUBMITTED' LIMIT 1`,[cycleId,actor.orgId,actor.userId]);
      if (evaluated.rowCount) throw new ForbiddenException({code:'REPORT_LOCKED'});
      await client.query('UPDATE monthly_reports SET manual_locked_at=NULL,unlocked_at=now(),row_version=row_version+1,updated_at=now() WHERE id=$1',[row.id]);
      await client.query(`INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id,reason) VALUES($1,$2,'material.unlock','monthly_report',$3,$4)`,[actor.orgId,actor.userId,row.id,'用户解锁成果包（已锁定 '+row.lock_count+' 次）']);
      await client.query('COMMIT');return {locked:false,lockCount:Number(row.lock_count)};
    } catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }

  async preview(actor:AuthContext,cycleId:string,versionId:string):Promise<MaterialPreview> {
    const result=await this.db.query(`SELECT v.object_key,v.original_name,v.mime,NULL::text AS external_url FROM report_versions v JOIN monthly_reports mr ON mr.id=v.report_id
      WHERE v.id=$1 AND mr.org_id=$2 AND mr.cycle_id=$3 AND mr.user_id=$4
      UNION ALL
      SELECT v.object_key,v.original_name,v.mime,v.external_url FROM monthly_material_versions v JOIN monthly_materials m ON m.id=v.material_id JOIN monthly_reports mr ON mr.id=m.report_id
      WHERE v.id=$1 AND mr.org_id=$2 AND mr.cycle_id=$3 AND mr.user_id=$4`,[versionId,actor.orgId,cycleId,actor.userId]);
    if(!result.rowCount)throw new NotFoundException({code:'REPORT_FILE_NOT_FOUND'});
    const row=result.rows[0];
    if(row.external_url) return {kind:'link',externalUrl:row.external_url as string,fileName:(row.original_name as string)??'云文档链接',mime:'text/uri-list'};
    try{return {kind:'file',buffer:await readFile(row.object_key),fileName:row.original_name as string,mime:row.mime as string};}catch{throw new NotFoundException({code:'REPORT_FILE_NOT_FOUND'});}
  }
}
