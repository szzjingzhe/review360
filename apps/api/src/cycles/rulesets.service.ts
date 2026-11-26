import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';

function validatePrdConfig(config:any) {
  const d=config?.calibration_difference;
  if(d!=null&&(!Number.isInteger(d.min_reviews)||d.min_reviews<2||!Number.isFinite(d.medium_points)||d.medium_points<0||!Number.isFinite(d.high_points)||d.high_points<d.medium_points||d.high_points>100))throw new BadRequestException({code:'RULESET_DIFFERENCE_CONFIG_INVALID'});
  if(config?.reasons?.policy!=='prd_v1')return;
  const {high_bp:high,excellent_bp:excellent,low_bp:low}=config.score??{};
  const {item_min_chars:item,overall_min_chars:overall,low_overall_min_chars:lowOverall}=config.reasons;
  if(![high,excellent,low].every(x=>Number.isInteger(x)&&x>=0&&x<=10000)||low>high||high>excellent||![item,overall,lowOverall].every(x=>Number.isInteger(x)&&x>0&&x<=10000))throw new BadRequestException({code:'RULESET_SCORE_CONFIG_INVALID'});
}

/**
 * 规则集服务（技术文档 5.2）：规则版本化，DRAFT 可编辑、FROZEN 供开期引用；
 * checksum 记录冻结时配置摘要。配置 JSON 结构由前端/调用方约定，服务端仅做基本结构校验。
 */
@Injectable()
export class RulesetsService {
  constructor(@Inject('DATABASE_POOL') private readonly db: Pool) {}

  async listRulesets(orgId: string) {
    const { rows } = await this.db.query(
      `SELECT r.id, r.version, r.status, r.checksum, r.created_at,r.frozen_at,r.frozen_by,u.display_name AS frozen_by_name,
              (SELECT count(*)::int FROM template_versions t
                WHERE t.ruleset_id = r.id AND t.role_code <> 'HRPB') AS template_count
       FROM rulesets r LEFT JOIN users u ON u.id=r.frozen_by AND u.org_id=r.org_id WHERE r.org_id = $1 ORDER BY r.version DESC`,
      [orgId],
    );
    return rows;
  }

  async getRuleset(orgId: string, rulesetId: string) {
    const { rows } = await this.db.query(
      `SELECT r.id, r.version, r.status, r.config_json, r.checksum, r.created_at
       FROM rulesets r WHERE r.id = $1 AND r.org_id = $2`,
      [rulesetId, orgId],
    );
    if (!rows[0]) throw new NotFoundException();

    const { rows: templateRows } = await this.db.query(
      `SELECT t.id, t.role_code, t.name,
              (SELECT json_agg(json_build_object(
                 'code', i.code, 'label', i.label, 'weight', i.weight, 'position', i.position, 'description', i.description
               ) ORDER BY i.position)
               FROM template_items i WHERE i.template_id = t.id) AS items
       FROM template_versions t WHERE t.ruleset_id = $1 AND t.role_code <> 'HRPB'
       ORDER BY t.role_code`,
      [rulesetId],
    );
    return { ...rows[0], templates: templateRows };
  }

  /** 创建规则集草稿：可基于现有规则集复制（base_ruleset_id），或直接给 config */
  async createRuleset(actor: { userId: string; orgId: string }, body: Record<string, unknown>) {
    if (typeof body.base_ruleset_id === 'string') {
      const source=await this.db.query('SELECT id FROM rulesets WHERE id=$1 AND org_id=$2',[body.base_ruleset_id,actor.orgId]);
      if (!source.rowCount) throw new NotFoundException({code:'RULESET_NOT_FOUND'});
    }
    let config = body.config;
    if (config === undefined && typeof body.base_ruleset_id === 'string') {
      const { rows } = await this.db.query(
        `SELECT config_json FROM rulesets WHERE id = $1 AND org_id = $2`,
        [body.base_ruleset_id, actor.orgId],
      );
      if (!rows[0]) throw new BadRequestException({ code: 'FIELD_INVALID', field: 'base_ruleset_id' });
      config = rows[0].config_json;
    }
    if (config === undefined || config === null || typeof config !== 'object') {
      throw new BadRequestException({ code: 'FIELD_INVALID', field: 'config' });
    }
    const configJson = JSON.stringify(config);
    if (configJson.length > 100_000) throw new BadRequestException({ code: 'CONFIG_TOO_LARGE' });

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[actor.orgId+':ruleset-version']);
      const { rows: vRows } = await client.query(
        `SELECT coalesce(max(version), 0) + 1 AS next FROM rulesets WHERE org_id = $1`,
        [actor.orgId],
      );
      const { rows } = await client.query(
        `INSERT INTO rulesets (id, org_id, version, status, config_json, checksum)
         VALUES (gen_random_uuid(), $1, $2, 'DRAFT', $3, $4)
         RETURNING id, version, status`,
        [actor.orgId, vRows[0].next, configJson, createHash('sha256').update(configJson).digest('hex')],
      );
      // 基于现有规则集复制时，连同模板一起复制
      if (typeof body.base_ruleset_id === 'string') {
        await client.query(
          `INSERT INTO template_versions (id, org_id, ruleset_id, role_code, name)
           SELECT gen_random_uuid(), org_id, $2, role_code, name
           FROM template_versions WHERE ruleset_id = $1 AND role_code <> 'HRPB'`,
          [body.base_ruleset_id, rows[0].id],
        );
        await client.query(
          `INSERT INTO template_items (id, org_id, template_id, code, label, weight, position, description)
           SELECT gen_random_uuid(), i.org_id, t2.id, i.code, i.label, i.weight, i.position, i.description
           FROM template_items i
           JOIN template_versions t1 ON t1.id = i.template_id AND t1.ruleset_id = $1
           JOIN template_versions t2 ON t2.ruleset_id = $2 AND t2.role_code = t1.role_code`,
          [body.base_ruleset_id, rows[0].id],
        );
      }
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async editDraft(actor:{userId:string;orgId:string},id:string,body:Record<string,unknown>) {
    if(!body.config||typeof body.config!=='object'||Array.isArray(body.config)||JSON.stringify(body.config).length>100000)
      throw new BadRequestException({code:'CONFIG_INVALID'});
    validatePrdConfig(body.config);
    if(!Array.isArray(body.templates))throw new BadRequestException({code:'TEMPLATES_REQUIRED'});
    const templates=body.templates as any[];
    if(templates.length<3||templates.length>5||new Set(templates.map(t=>t.role_code)).size!==templates.length||!['HEAD','MEMBER','SELF'].every(role=>templates.some(t=>t.role_code===role))||templates.some(t=>!['HEAD','MEMBER','SELF','UPWARD','SUPERVISOR'].includes(t.role_code)))
      throw new BadRequestException({code:'TEMPLATE_ROLES_INVALID'});
    for(const t of templates){
      if(typeof t.name!=='string'||!t.name.trim()||!Array.isArray(t.items)||!t.items.length||t.items.length>30)
        throw new BadRequestException({code:'TEMPLATE_INVALID'});
      if(new Set(t.items.map((i:any)=>i.code)).size!==t.items.length||t.items.some((i:any)=>typeof i.code!=='string'||!i.code.trim()||typeof i.label!=='string'||!i.label.trim()||!Number.isInteger(i.weight)||i.weight<=0||i.weight>100))
        throw new BadRequestException({code:'TEMPLATE_ITEMS_INVALID'});
    }
    const client=await this.db.connect();try{await client.query('BEGIN');
      const row=(await client.query('SELECT status,checksum FROM rulesets WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,actor.orgId])).rows[0];
      if(!row)throw new NotFoundException();if(row.status!=='DRAFT')throw new BadRequestException({code:'NOT_DRAFT'});
      if(typeof body.expected_checksum!=='string'||body.expected_checksum!==row.checksum)throw new ConflictException({code:'RULESET_CONCURRENT_MODIFICATION'});
      if((await client.query('SELECT 1 FROM cycles WHERE ruleset_id=$1 LIMIT 1',[id])).rowCount)throw new BadRequestException({code:'RULESET_IN_USE'});
      await client.query('DELETE FROM template_items WHERE template_id IN(SELECT id FROM template_versions WHERE ruleset_id=$1)',[id]);
      await client.query('DELETE FROM template_versions WHERE ruleset_id=$1',[id]);
      for(const t of templates){const template=(await client.query('INSERT INTO template_versions(id,org_id,ruleset_id,role_code,name) VALUES(gen_random_uuid(),$1,$2,$3,$4) RETURNING id',[actor.orgId,id,t.role_code,t.name])).rows[0];
        for(let n=0;n<t.items.length;n++){const i=t.items[n];if(i.description!=null&&(typeof i.description!=='string'||i.description.length>2000))throw new BadRequestException({code:'TEMPLATE_DESCRIPTION_INVALID'});await client.query('INSERT INTO template_items(id,org_id,template_id,code,label,weight,position,description) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)',[actor.orgId,template.id,i.code,i.label,i.weight,n,i.description??null]);}}
      await client.query('UPDATE rulesets SET config_json=$2,checksum=$3 WHERE id=$1',[id,body.config,createHash('sha256').update(JSON.stringify({config:body.config,templates})).digest('hex')]);
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id) VALUES($1,$2,'ruleset.edit','ruleset',$3)",[actor.orgId,actor.userId,id]);
      await client.query('COMMIT');return {id,status:'DRAFT'};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async deleteDraft(actor:{userId:string;orgId:string},id:string){
    const client=await this.db.connect();try{await client.query('BEGIN');
      const row=(await client.query('SELECT status FROM rulesets WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,actor.orgId])).rows[0];
      if(!row)throw new NotFoundException();if(row.status!=='DRAFT')throw new BadRequestException({code:'NOT_DRAFT'});
      if((await client.query('SELECT 1 FROM cycles WHERE ruleset_id=$1 LIMIT 1',[id])).rowCount)throw new BadRequestException({code:'RULESET_IN_USE'});
      await client.query('DELETE FROM template_items WHERE template_id IN(SELECT id FROM template_versions WHERE ruleset_id=$1)',[id]);
      await client.query('DELETE FROM template_versions WHERE ruleset_id=$1',[id]);await client.query('DELETE FROM rulesets WHERE id=$1',[id]);
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id) VALUES($1,$2,'ruleset.delete_draft','ruleset',$3)",[actor.orgId,actor.userId,id]);
      await client.query('COMMIT');return {id,deleted:true};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async freezeRuleset(actor:{userId:string;orgId:string},id:string){
    const client=await this.db.connect();try{await client.query('BEGIN');
      const row=(await client.query('SELECT status,config_json FROM rulesets WHERE id=$1 AND org_id=$2 FOR UPDATE',[id,actor.orgId])).rows[0];
      if(!row)throw new NotFoundException();if(row.status!=='DRAFT')throw new BadRequestException({code:'NOT_DRAFT'});
      validatePrdConfig(row.config_json);
      const templates=(await client.query(`SELECT t.role_code,COALESCE(sum(i.weight),0)::int AS total,count(i.id)::int AS items
        FROM template_versions t LEFT JOIN template_items i ON i.template_id=t.id WHERE t.ruleset_id=$1 GROUP BY t.role_code`,[id])).rows;
      if(templates.some(t=>t.total!==100||t.items===0)||!['HEAD','MEMBER','SELF'].every(role=>templates.some(t=>t.role_code===role)))
        throw new BadRequestException({code:'TEMPLATE_WEIGHT_INVALID'});
      const checksum=createHash('sha256').update(JSON.stringify({config:row.config_json,templates:(await client.query(`SELECT t.role_code,i.code,i.label,i.weight,i.position,i.description FROM template_versions t JOIN template_items i ON i.template_id=t.id WHERE t.ruleset_id=$1 ORDER BY t.role_code,i.position`,[id])).rows})).digest('hex');
      const updated=(await client.query("UPDATE rulesets SET status='FROZEN',checksum=$2,frozen_at=now(),frozen_by=$3 WHERE id=$1 RETURNING id,version,status,checksum,frozen_at,frozen_by",[id,checksum,actor.userId])).rows[0];
      await client.query("INSERT INTO audit_events(org_id,actor_id,action,resource_type,resource_id) VALUES($1,$2,'ruleset.freeze','ruleset',$3)",[actor.orgId,actor.userId,id]);
      await client.query('COMMIT');return updated;
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
}
