import '../../../scripts/test-db-setup.cjs';
import { ReviewMaterialsService } from '../src/reviews/review-materials.service';
import 'reflect-metadata';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { MaterialsService, type MaterialFile, type MaterialMeta } from '../src/report/materials.service';
import { ReportService } from '../src/report/report.service';
import { ReviewsService } from '../src/reviews/reviews.service';
import type { AuthContext } from '../src/auth/current-user.decorator';
import { purgeCycles } from './helpers/cycle-cleanup';
import { ITEM_REASON_OK, OVERALL_STATEMENT_OK } from './helpers/review-text';

// Never run material mutations against a developer's working database.
const isolated = true; // Shared setup has already validated the exact target.
describe.skipIf(!isolated)('Monthly material packages (isolated database only)',()=>{
  let db:Pool,svc:MaterialsService,old:ReportService,reviews:ReviewsService,actor:AuthContext,other:AuthContext,cycle:string,dir:string;
  let index=0; const months:string[]=[]; const previousDir=process.env.REPORT_STORAGE_DIR;
  const pdf=(name='报告.pdf'):MaterialFile=>({originalname:name,mimetype:'application/pdf',buffer:Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'),size:44});
  function file(name='报告.pdf'){const f=pdf(name);f.size=f.buffer.length;return f;}
  const meta=(type='MONTHLY_REPORT',name='本月工作报告',materialId?:string):MaterialMeta=>({type,name,note:'版本说明',...(materialId?{materialId}:{})});
  const create=async()=>svc.submit(actor,cycle,[file(),file('项目.pdf'),file('竞赛.pdf')],[meta(),meta('PROJECT','项目成果'),meta('COMPETITION','竞赛成果')]);
  beforeAll(async()=>{
    db=new Pool({connectionString:process.env.DATABASE_URL});svc=new MaterialsService(db);old=new ReportService(db,svc);reviews=new ReviewsService(db);
    const users=(await db.query(`SELECT id,org_id,display_name FROM users WHERE status='ACTIVE'
      AND org_id=(SELECT org_id FROM users WHERE status='ACTIVE' GROUP BY org_id HAVING count(*)>=2 ORDER BY org_id LIMIT 1)
      ORDER BY id LIMIT 2`)).rows;
    [actor,other]=users.map(u=>({userId:u.id,orgId:u.org_id,displayName:u.display_name,sessionIdHash:'isolated-test'}));
    dir=await mkdtemp(join(tmpdir(),'review360-materials-'));process.env.REPORT_STORAGE_DIR=dir;
  });
  beforeEach(async()=>{cycle=randomUUID();index++;const month=String(2042+Math.floor((index-1)/12))+'-'+String((index-1)%12+1).padStart(2,'0')+'-01';months.push(month);
    await db.query(`INSERT INTO cycles(id,org_id,month,title,status,ruleset_id,open_at,close_at)
      SELECT $1,$2,$3,'材料隔离测试','REVIEWING',id,now()-interval '1 day',now()+interval '1 day' FROM rulesets WHERE org_id=$2 AND status='FROZEN' LIMIT 1`,[cycle,actor.orgId,month]);
    await db.query(`INSERT INTO cycle_participants(cycle_id,org_id,user_id,dept_snapshot,role_snapshot,template_id)
      SELECT c.id,c.org_id,u.id,(SELECT id FROM departments WHERE org_id=c.org_id LIMIT 1),'MEMBER',tv.id
      FROM cycles c JOIN template_versions tv ON tv.ruleset_id=c.ruleset_id AND tv.role_code='MEMBER'
      JOIN users u ON u.id=ANY($2::uuid[]) WHERE c.id=$1`,[cycle,[actor.userId,other.userId]]);
  });
  afterAll(async()=>{if(db){await purgeCycles(db,months);await db.end();}if(previousDir===undefined)delete process.env.REPORT_STORAGE_DIR;else process.env.REPORT_STORAGE_DIR=previousDir;if(dir)await rm(dir,{recursive:true,force:true});});
  it('creates one primary and multiple supplements with independent V1; legacy API counts only the primary',async()=>{
    const result=await create();expect(result.materials).toHaveLength(3);expect(result.materials.filter(m=>m.isPrimary)).toHaveLength(1);
    expect(result.materials.every(m=>m.versions[0].version===1&&m.versions[0].uploadedBy===actor.displayName&&m.versions[0].note==='版本说明')).toBe(true);
    expect(await old.listFiles(actor,cycle)).toHaveLength(1);
  });
  it('updates a single material without affecting others; retains and serves historical versions',async()=>{
    const initial=await create(),primary=initial.materials.find(m=>m.isPrimary)!,supp=initial.materials.find(m=>m.type==='PROJECT')!;
    await svc.submit(actor,cycle,[file('新主月报.pdf')],[meta('MONTHLY_REPORT','主月报更新',primary.id)]);
    const result=await svc.submit(actor,cycle,[file('新项目.pdf')],[meta('PROJECT','项目更新',supp.id)]);
    expect(result.materials.find(m=>m.id===primary.id)!.versions.map(v=>v.version)).toEqual([2,1]);
    expect(result.materials.find(m=>m.id===supp.id)!.versions.map(v=>v.version)).toEqual([2,1]);
    expect(result.materials.find(m=>m.type==='COMPETITION')!.versions).toHaveLength(1);
    expect((await svc.preview(actor,cycle,supp.versions[0].id)).buffer).toEqual(file().buffer);
  });
  it('rejects a duplicate primary and rolls back every file/material in the batch',async()=>{
    await create();const before=await readdir(dir);
    await expect(svc.submit(actor,cycle,[file('多余.pdf'),file()],[meta('OTHER','不得留下'),meta()])).rejects.toMatchObject({response:{code:'PRIMARY_REPORT_EXISTS'}});
    expect((await svc.list(actor,cycle)).materials).toHaveLength(3);expect(await readdir(dir)).toEqual(before);
  });
  it('validates format, content, size and fixed material types on the server',async()=>{
    await expect(svc.submit(actor,cycle,[file('x.exe')],[meta()])).rejects.toMatchObject({response:{code:'FILE_TYPE_NOT_ALLOWED'}});
    const forged=file();forged.buffer=Buffer.from('not a pdf');forged.size=forged.buffer.length;
    await expect(svc.submit(actor,cycle,[forged],[meta()])).rejects.toMatchObject({response:{code:'FILE_CONTENT_MISMATCH'}});
    const big=file();big.buffer=Buffer.alloc(20*1024*1024+1);big.size=big.buffer.length;
    await expect(svc.submit(actor,cycle,[big],[meta()])).rejects.toMatchObject({response:{code:'FILE_SIZE_INVALID'}});
    await expect(svc.submit(actor,cycle,[file()],[meta('PDF')])).rejects.toMatchObject({response:{code:'INVALID_MATERIAL_METADATA'}});
    expect((await svc.list(actor,cycle)).materials).toHaveLength(0);
  });
  it('does not expose or update another member\'s material',async()=>{
    const initial=await create(),supp=initial.materials.find(m=>!m.isPrimary)!;
    await expect(svc.preview(other,cycle,supp.versions[0].id)).rejects.toMatchObject({response:{code:'REPORT_FILE_NOT_FOUND'}});
    await expect(svc.submit(other,cycle,[file()],[meta(supp.type,'越权',supp.id)])).rejects.toMatchObject({response:{code:'MATERIAL_NOT_FOUND'}});
    expect((await svc.list(other,cycle)).materials).toHaveLength(0);
  });
  it('serializes concurrent version updates and assigns consecutive server versions',async()=>{
    const initial=await create(),supp=initial.materials.find(m=>m.type==='PROJECT')!;
    await Promise.all([svc.submit(actor,cycle,[file()],[meta('PROJECT','并发一',supp.id)]),svc.submit(actor,cycle,[file()],[meta('PROJECT','并发二',supp.id)])]);
    expect((await svc.list(actor,cycle)).materials.find(m=>m.id===supp.id)!.versions.map(v=>v.version)).toEqual([3,2,1]);
  });
  it('retries the same request without duplicate materials; rejects reuse with changed content',async()=>{
    const requestId=randomUUID();await svc.submit(actor,cycle,[file()],[meta('OTHER','可安全重试')],false,requestId);
    await svc.submit(actor,cycle,[file()],[meta('OTHER','可安全重试')],false,requestId);
    expect((await svc.list(actor,cycle)).materials).toHaveLength(1);
    await expect(svc.submit(actor,cycle,[file()],[meta('OTHER','修改内容')],false,requestId)).rejects.toMatchObject({response:{code:'SUBMISSION_ID_CONFLICT'}});
  });
  it('locks the whole package; rejects new materials, updates and legacy upload bypass',async()=>{
    const result=await create(),supp=result.materials.find(m=>!m.isPrimary)!;await svc.lock(actor,cycle);
    expect((await svc.list(actor,cycle)).materials.every(m=>m.versions.every(v=>v.status==='LOCKED'))).toBe(true);
    await expect(svc.submit(actor,cycle,[file()],[meta('OTHER','不能新增')])).rejects.toMatchObject({response:{code:'REPORT_LOCKED'}});
    await expect(svc.submit(actor,cycle,[file()],[meta(supp.type,'不能修改',supp.id)])).rejects.toMatchObject({response:{code:'REPORT_LOCKED'}});
    await expect(old.uploadFile(actor,cycle,file())).rejects.toMatchObject({response:{code:'REPORT_LOCKED'}});
  });
  async function selfDraft(){const id=randomUUID();await db.query("INSERT INTO reviews(id,cycle_id,org_id,reviewer_id,target_id,kind) VALUES($1,$2,$3,$4,$4,'SELF')",[id,cycle,actor.orgId,actor.userId]);const items=(await db.query("SELECT ti.id FROM template_items ti JOIN template_versions tv ON tv.id=ti.template_id JOIN cycles c ON c.ruleset_id=tv.ruleset_id WHERE c.id=$1 AND tv.role_code='SELF'",[cycle])).rows;expect(items.length).toBeGreaterThan(0);await reviews.saveDraft(actor,id,{items:items.map(i=>({itemId:i.id,score:80,reason:ITEM_REASON_OK})),overallReason:OVERALL_STATEMENT_OK,readConfirmed:true});return id;}
  it('freezes exact primary/supplementary versions in the successful evaluation transaction',async()=>{
    const initial=await create(),id=await selfDraft();const revision=await reviews.submitReview(actor,id,undefined);
    const snap=(await db.query('SELECT * FROM review_material_snapshots WHERE revision_id=$1',[revision.revisionId])).rows[0];
    expect(snap.versions_json.map((x:any)=>x.versionId).sort()).toEqual(initial.materials.map(m=>m.versions[0].id).sort());
    const ref=(await db.query('SELECT report_version_id FROM review_revisions WHERE id=$1',[revision.revisionId])).rows[0];expect(ref.report_version_id).toBe(initial.materials.find(m=>m.isPrimary)!.versions[0].id);
    await expect(svc.submit(actor,cycle,[file()],[meta('OTHER','评价后禁止修改')])).rejects.toMatchObject({response:{code:'REPORT_LOCKED'}});
  });
  it('rolls back the tentative lock when evaluation validation fails',async()=>{
    await create();const id=await selfDraft();await db.query("UPDATE review_drafts SET data_json=jsonb_set(data_json,'{readConfirmed}','false') WHERE cycle_id=$1",[cycle]);
    await expect(reviews.submitReview(actor,id,undefined)).rejects.toMatchObject({response:{code:'READ_CONFIRM_REQUIRED'}});
    expect((await svc.list(actor,cycle)).locked).toBe(false);
  });
  it('backfills a legacy primary without changing file/version IDs or original foreign keys',async()=>{
    const original=await old.uploadFile(actor,cycle,file('旧版月报.pdf'));const before=await old.listFiles(actor,cycle);
    await db.query('DELETE FROM monthly_materials WHERE report_id=$1',[original.reportId]);
    const sql=readFileSync(join(process.cwd(),'../../packages/database/migrations/013_monthly_materials.sql'),'utf8');
    const backfill=sql.match(/INSERT INTO monthly_materials[\s\S]*?ON CONFLICT DO NOTHING;/)![0];await db.query(backfill);
    const after=await svc.list(actor,cycle);expect(after.materials[0].versions[0].id).toBe(original.id);expect(await old.listFiles(actor,cycle)).toEqual(before);
  });
  it('rejects uploads in a closed cycle without creating a package',async()=>{
    await db.query("UPDATE cycles SET status='PUBLISHED' WHERE id=$1",[cycle]);
    await expect(svc.submit(actor,cycle,[file()],[meta()])).rejects.toMatchObject({response:{code:'REPORT_UPLOAD_CLOSED'}});
    expect((await svc.list(actor,cycle)).materials).toHaveLength(0);
  });
  it('keeps evaluation references consistent when upload and first evaluation race',async()=>{
    const initial=await create(),primary=initial.materials.find(m=>m.isPrimary)!,id=await selfDraft();
    const results=await Promise.allSettled([
      reviews.submitReview(actor,id,undefined),
      svc.submit(actor,cycle,[file('并发更新.pdf')],[meta('MONTHLY_REPORT','主月报并发更新',primary.id)]),
    ]);
    if(results[0].status==='rejected') {
      expect(results[1].status).toBe('fulfilled');
      const items=(await db.query("SELECT ti.id FROM template_items ti JOIN template_versions tv ON tv.id=ti.template_id JOIN cycles c ON c.ruleset_id=tv.ruleset_id WHERE c.id=$1 AND tv.role_code='SELF'",[cycle])).rows;
      await reviews.saveDraft(actor,id,{items:items.map(i=>({itemId:i.id,score:80,reason:ITEM_REASON_OK})),overallReason:OVERALL_STATEMENT_OK,readConfirmed:true});
      await reviews.submitReview(actor,id,undefined);
    }
    const pkg=(await db.query('SELECT active_version_id,locked_at FROM monthly_reports WHERE id=$1',[primary.id])).rows[0];
    const revision=(await db.query('SELECT report_version_id FROM review_revisions WHERE review_id=$1 ORDER BY revision_no DESC LIMIT 1',[id])).rows[0];
    expect(pkg.locked_at).not.toBeNull();expect(revision.report_version_id).toBe(pkg.active_version_id);
    const snapshot=(await db.query('SELECT versions_json FROM review_material_snapshots s JOIN review_revisions r ON r.id=s.revision_id WHERE r.review_id=$1',[id])).rows[0];
    expect(snapshot.versions_json.find((m:any)=>m.type==='MONTHLY_REPORT').versionId).toBe(pkg.active_version_id);
  });
  it('authorizes task material reads and denies other reviewers and unrelated version IDs',async()=>{
    const created=await create(),id=await selfDraft(),reader=new ReviewMaterialsService(db);
    const result=await reader.list(actor,id);expect(result.basis).toBe('CURRENT');expect(result.materials).toHaveLength(3);
    expect((await reader.file(actor,id,created.materials[0].versions[0].id)).buffer).toEqual(file().buffer);
    await expect(reader.list(other,id)).rejects.toMatchObject({response:{code:'MATERIAL_ACCESS_DENIED'}});
    await expect(reader.file(actor,id,randomUUID())).rejects.toMatchObject({response:{code:'MATERIAL_VERSION_NOT_AUTHORIZED'}});
  });
  it('reads submitted snapshot versions and own submitted item scores without substituting current files',async()=>{
    await create();const id=await selfDraft(),reader=new ReviewMaterialsService(db);await reviews.submitReview(actor,id,undefined);
    const before=await reader.list(actor,id);expect(before.basis).toBe('SNAPSHOT');expect(before.materials).toHaveLength(3);
    const detail=await reviews.getReviewDetail(actor,id);expect(detail.latestRevision!.items).toHaveLength(4);expect(detail.latestRevision!.items.every(i=>i.score===80)).toBe(true);
    await db.query('UPDATE monthly_reports SET active_version_id=NULL WHERE cycle_id=$1',[cycle]);
    expect((await reader.list(actor,id)).materials.map(v=>v.id).sort()).toEqual(before.materials.map(v=>v.id).sort());
  });
  it('does not fall back to current materials for a legacy revision without a reference',async()=>{
    await create();const id=await selfDraft();await reviews.submitReview(actor,id,undefined);
    await db.query('DELETE FROM review_material_snapshots WHERE revision_id IN (SELECT id FROM review_revisions WHERE review_id=$1)',[id]);
    await db.query('UPDATE review_revisions SET report_version_id=NULL WHERE review_id=$1',[id]);
    const result=await new ReviewMaterialsService(db).list(actor,id);expect(result.snapshotUnavailable).toBe(true);expect(result.materials).toEqual([]);
  });
  it('closes material access after publication and distinguishes missing stored files',async()=>{
    const created=await create(),id=await selfDraft(),reader=new ReviewMaterialsService(db),version=created.materials[0].versions[0].id;
    await db.query("UPDATE report_versions SET object_key='/nonexistent/review360-file.pdf' WHERE id=$1",[version]);
    await expect(reader.file(actor,id,version)).rejects.toMatchObject({response:{code:'MATERIAL_FILE_MISSING'}});
    await db.query("UPDATE cycles SET status='PUBLISHED' WHERE id=$1",[cycle]);
    await expect(reader.list(actor,id)).rejects.toMatchObject({response:{code:'MATERIAL_ACCESS_CLOSED'}});
  });

  it('allows an assigned peer to read target materials but denies cancelled assignments and other organizations',async()=>{
    await create();const id=await selfDraft(),run=randomUUID(),assignment=randomUUID(),reader=new ReviewMaterialsService(db);
    await db.query("INSERT INTO assignment_runs(id,cycle_id,org_id,version,seed,algorithm_version,input_hash,status) VALUES($1,$2,$3,1,1,'test','test','LOCKED')",[run,cycle,actor.orgId]);
    await db.query("INSERT INTO assignments(id,run_id,cycle_id,org_id,reviewer_id,target_id,source_type) VALUES($1,$2,$3,$4,$5,$6,'PEER')",[assignment,run,cycle,actor.orgId,other.userId,actor.userId]);
    await db.query("UPDATE reviews SET kind='PEER',reviewer_id=$2,assignment_id=$3 WHERE id=$1",[id,other.userId,assignment]);
    expect((await reader.list(other,id)).materials).toHaveLength(3);
    await expect(reader.list(actor,id)).rejects.toMatchObject({response:{code:'MATERIAL_ACCESS_DENIED'}});
    await expect(reader.list({...other,orgId:randomUUID()},id)).rejects.toMatchObject({response:{code:'REVIEW_NOT_FOUND'}});
    await db.query("UPDATE assignments SET status='CANCELLED' WHERE id=$1",[assignment]);
    await expect(reader.list(other,id)).rejects.toMatchObject({response:{code:'MATERIAL_ACCESS_DENIED'}});
  });

  it('keeps incomplete self drafts, blocks short reasons on submit, and preserves historical revisions',async()=>{
    const id=await selfDraft();const detail=await reviews.getReviewDetail(actor,id);
    expect(detail.reasonRules).toEqual({lowExclusive:60,highInclusive:80,minChars:100});
    const draft={items:detail.template.items.map(i=>({itemId:i.id,score:0,reason:'字'.repeat(99)})),readConfirmed:true};
    await reviews.saveDraft(actor,id,draft);
    expect((await reviews.getReviewDetail(actor,id)).draft.dataJson.items![0].reason).toBe('字'.repeat(99));
    await expect(reviews.submitReview(actor,id,undefined)).rejects.toMatchObject({response:{code:'LOW_ITEM_REASON_REQUIRED',violations:expect.arrayContaining([expect.objectContaining({requiredChars:100,actualChars:99})])}});
    await reviews.saveDraft(actor,id,{...draft,items:draft.items.map(i=>({...i,score:60,reason:''}))});
    await reviews.submitReview(actor,id,undefined);
    const saved=await reviews.getReviewDetail(actor,id);expect(saved.latestRevision!.scoreBp).toBe(6000);
    expect(saved.latestRevision!.items.every(i=>!i.reason)).toBe(true);
  });

});
