import '../../../scripts/test-db-setup.cjs';
import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { RulesetsService } from '../src/cycles/rulesets.service';
import { verifyTestConnection } from '../../../scripts/test-db-safety.cjs';

describe('isolated ruleset editing', () => {
  it('copies exactly, persists descriptions, rejects stale edits and protects frozen versions', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await verifyTestConnection(pool);
    const service = new RulesetsService(pool);
    const source = (await pool.query("SELECT id,org_id FROM rulesets WHERE status='FROZEN' AND (SELECT count(*) FROM template_versions WHERE ruleset_id=rulesets.id AND role_code<>'HRPB')>=3 LIMIT 1")).rows[0];
    const user = (await pool.query('SELECT id FROM users WHERE org_id=$1 LIMIT 1',[source.org_id])).rows[0];
    const actor = { userId:user.id, orgId:source.org_id };
    const original = await service.getRuleset(actor.orgId,source.id);
    let id: string | undefined;
    try {
      const draft = await service.createRuleset(actor,{base_ruleset_id:source.id}); id=draft.id;
      const copy = await service.getRuleset(actor.orgId,id!);
      expect(copy.config_json).toEqual(original.config_json);
      expect(copy.templates).toEqual(original.templates.map((t:any)=>({...t,id:copy.templates.find((x:any)=>x.role_code===t.role_code).id})));
      const templates=structuredClone(copy.templates);
      templates[0].items[0].description='隔离测试说明';
      await service.editDraft(actor,id!,{config:copy.config_json,templates,expected_checksum:copy.checksum});
      const saved=await service.getRuleset(actor.orgId,id!);
      expect(saved.templates[0].items[0].description).toBe('隔离测试说明');
      await expect(service.editDraft(actor,id!,{config:copy.config_json,templates,expected_checksum:copy.checksum})).rejects.toMatchObject({status:409});
      await expect(service.editDraft(actor,source.id,{config:original.config_json,templates:original.templates,expected_checksum:original.checksum})).rejects.toMatchObject({status:400});
      expect(await service.getRuleset(actor.orgId,source.id)).toEqual(original);
    } finally { if(id)await service.deleteDraft(actor,id); await pool.end(); }
  });
});
