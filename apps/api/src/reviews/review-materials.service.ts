import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../database/database.module';
import type { AuthContext } from '../auth/current-user.decorator';

@Injectable()
export class ReviewMaterialsService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  private async authorized(actor: AuthContext, reviewId: string) {
    const result = await this.db.query(`SELECT r.*,c.status AS cycle_status,c.self_close_at AS cycle_self_close_at,a.status AS assignment_status,
      (a.status='ACTIVE' AND a.source_type='REPLACEMENT' AND a.replaces_id IS NOT NULL
       AND a.supplement_authorized_by IS NOT NULL AND a.supplement_due_at>now()) AS authorized_supplement
      FROM reviews r JOIN cycles c ON c.id=r.cycle_id AND c.org_id=r.org_id
      LEFT JOIN assignments a ON a.id=r.assignment_id
      WHERE r.id=$1 AND r.org_id=$2`, [reviewId,actor.orgId]);
    const row=result.rows[0];
    if(!row)throw new NotFoundException({code:'REVIEW_NOT_FOUND'});
    if(row.reviewer_id!==actor.userId || (row.kind==='PEER'&&row.assignment_status!=='ACTIVE'))
      throw new ForbiddenException({code:'MATERIAL_ACCESS_DENIED'});
    // 他评材料区会展示他人的月度成果：自评阶段未结束 / 本人自评未提交时不得访问
    if(row.kind==='PEER' && row.status!=='SUBMITTED'){
      if(row.cycle_self_close_at && Date.now()<new Date(row.cycle_self_close_at).getTime())
        throw new ForbiddenException({code:'PEER_REVIEW_NOT_OPEN'});
      const self=await this.db.query(`SELECT 1 FROM reviews WHERE cycle_id=$1 AND reviewer_id=$2 AND target_id=$2 AND kind='SELF' AND org_id=$3 AND status='SUBMITTED'`,[row.cycle_id,actor.userId,actor.orgId]);
      if(!self.rowCount) throw new ForbiddenException({code:'PEER_REVIEW_LOCKED_SELF_PENDING'});
    }
    if(!['REVIEWING','CALIBRATING'].includes(row.cycle_status)
      && !(row.status==='SUBMITTED'&&['PARTIALLY_PUBLISHED','PUBLISHED'].includes(row.cycle_status))
      && !(row.cycle_status==='PARTIALLY_PUBLISHED'&&row.authorized_supplement))
      throw new ForbiddenException({code:'MATERIAL_ACCESS_CLOSED'});
    return row;
  }

  async list(actor: AuthContext, reviewId: string) {
    const review=await this.authorized(actor,reviewId);
    const revision=await this.db.query(`SELECT rr.report_version_id,s.versions_json
      FROM review_revisions rr LEFT JOIN review_material_snapshots s ON s.revision_id=rr.id
      WHERE rr.review_id=$1 ORDER BY rr.revision_no DESC LIMIT 1`,[reviewId]);
    const fixed=review.status==='SUBMITTED';
    const snapshot=revision.rows[0];
    // Old revisions may only bind a primary version. Never replace it with today's file.
    const ids:string[]|null=fixed ? (Array.isArray(snapshot?.versions_json)
      ? snapshot.versions_json.map((v:{versionId:string})=>v.versionId)
      : snapshot?.report_version_id ? [snapshot.report_version_id] : []) : null;
    const files=await this.db.query(`
      SELECT m.id AS "materialId",m.name,m.material_type AS type,v.id,v.version,
        v.original_name AS "fileName",v.size_bytes::float8 AS "sizeBytes",v.mime,v.created_at AS "createdAt",
        v.preview_status='READY' AND v.scan_status='PASSED' AS ready, NULL::text AS "externalUrl"
      FROM monthly_reports mr JOIN monthly_materials m ON m.report_id=mr.id AND m.material_type='MONTHLY_REPORT'
      JOIN report_versions v ON v.report_id=mr.id
      WHERE mr.org_id=$1 AND mr.cycle_id=$2 AND mr.user_id=$3
        AND (($4::uuid[] IS NULL AND v.id=mr.active_version_id) OR v.id=ANY($4::uuid[]))
      UNION ALL
      SELECT m.id,m.name,m.material_type,v.id,v.version,coalesce(v.original_name,'云文档链接'),v.size_bytes::float8,v.mime,v.created_at,true,v.external_url
      FROM monthly_reports mr JOIN monthly_materials m ON m.report_id=mr.id AND m.material_type<>'MONTHLY_REPORT'
      JOIN monthly_material_versions v ON v.material_id=m.id
      WHERE mr.org_id=$1 AND mr.cycle_id=$2 AND mr.user_id=$3
        AND (($4::uuid[] IS NULL AND v.version=(SELECT max(version) FROM monthly_material_versions WHERE material_id=m.id)) OR v.id=ANY($4::uuid[]))
      ORDER BY type, "createdAt" DESC`,[actor.orgId,review.cycle_id,review.target_id,ids]);
    return {basis:fixed?'SNAPSHOT':'CURRENT',snapshotUnavailable:fixed&&!snapshot?.versions_json&&!snapshot?.report_version_id,materials:files.rows};
  }

  async file(actor:AuthContext,reviewId:string,versionId:string) {
    const allowed=await this.list(actor,reviewId);
    const metadata=allowed.materials.find(v=>v.id===versionId);
    if(!metadata)throw new ForbiddenException({code:'MATERIAL_VERSION_NOT_AUTHORIZED'});
    if(!metadata.ready)throw new ForbiddenException({code:'MATERIAL_NOT_READY'});
    if(metadata.externalUrl)return {externalUrl:metadata.externalUrl as string,fileName:metadata.fileName as string,mime:'text/uri-list'};
    const result=await this.db.query(`SELECT object_key FROM report_versions WHERE id=$1 AND org_id=$2
      UNION ALL SELECT object_key FROM monthly_material_versions WHERE id=$1 AND org_id=$2`,[versionId,actor.orgId]);
    try {return {...metadata,buffer:await readFile(result.rows[0].object_key)};}
    catch {throw new NotFoundException({code:'MATERIAL_FILE_MISSING'});}
  }
}
