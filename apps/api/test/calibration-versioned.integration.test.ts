import '../../../scripts/test-db-setup.cjs';
import {describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {createTriggers,thresholdsFrom} from '@360/domain';

describe('versioned calibration against isolated PostgreSQL',()=>{
 it('scans valid submitted reviews idempotently without self-peer difference when unconfigured',async()=>{
  const pool=new Pool({connectionString:process.env.DATABASE_URL});const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const org=(await c.query('SELECT id FROM organizations LIMIT 1')).rows[0].id;
   const users=(await c.query('SELECT id FROM users WHERE org_id=$1 AND status=\'ACTIVE\' LIMIT 3',[org])).rows;
   const source=(await c.query("SELECT id,config_json FROM rulesets WHERE org_id=$1 AND status='FROZEN' LIMIT 1",[org])).rows[0];
   const config={...source.config_json,reasons:{policy:'prd_v1',item_min_chars:30,overall_min_chars:50,low_overall_min_chars:30}};
   const rs=(await c.query("INSERT INTO rulesets(id,org_id,version,status,config_json,checksum) VALUES(gen_random_uuid(),$1,(SELECT max(version)+1000 FROM rulesets WHERE org_id=$1),'FROZEN',$2,'integration') RETURNING id",[org,config])).rows[0].id;
   const cycle=(await c.query("INSERT INTO cycles(id,org_id,month,title,status,ruleset_id) VALUES(gen_random_uuid(),$1,'2087-08-01','Isolated calibration','CALIBRATING',$2) RETURNING id",[org,rs])).rows[0].id;
   const run=(await c.query("INSERT INTO assignment_runs(id,cycle_id,org_id,version,seed,algorithm_version,input_hash,status) VALUES(gen_random_uuid(),$1,$2,1,'qa','qa','qa','LOCKED') RETURNING id",[cycle,org])).rows[0].id;
   const item=(await c.query('SELECT i.id FROM template_items i JOIN template_versions t ON t.id=i.template_id JOIN rulesets r ON r.id=t.ruleset_id WHERE r.org_id=$1 LIMIT 1',[org])).rows[0].id;
   async function review(reviewer:string,target:string,kind:'SELF'|'PEER',score:number,status='ACTIVE'){
    const assignment=kind==='PEER'?(await c.query("INSERT INTO assignments(id,run_id,cycle_id,org_id,reviewer_id,target_id,source_type,status) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'PEER',$6) RETURNING id",[run,cycle,org,reviewer,target,status])).rows[0].id:null;
    const id=(await c.query("INSERT INTO reviews(id,org_id,cycle_id,assignment_id,reviewer_id,target_id,kind,status) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,'SUBMITTED') RETURNING id",[org,cycle,assignment,reviewer,target,kind])).rows[0].id;
    const rev=(await c.query("INSERT INTO review_revisions(id,org_id,review_id,revision_no,score_bp,overall_reason,submitted_at) VALUES(gen_random_uuid(),$1,$2,1,$3,'不足',now()) RETURNING id",[org,id,score*100])).rows[0].id;
    await c.query('UPDATE reviews SET current_revision_id=$2 WHERE id=$1',[id,rev]);
    await c.query("INSERT INTO review_item_scores(id,revision_id,org_id,item_id,score,reason) VALUES(gen_random_uuid(),$1,$2,$3,$4,'短')",[rev,org,item,score]);
    return rev;
   }
   const self=await review(users[0].id,users[0].id,'SELF',95),peer=await review(users[1].id,users[0].id,'PEER',90),cancelled=await review(users[2].id,users[0].id,'PEER',95,'CANCELLED');
   const first=await createTriggers(c,cycle,org,thresholdsFrom(config));expect(first.created).toBeGreaterThan(0);
   const cases=(await c.query('SELECT review_revision_id,reason_code FROM calibration_cases WHERE cycle_id=$1',[cycle])).rows;
   expect(cases.some(x=>x.review_revision_id===self&&x.reason_code==='EXCELLENT')).toBe(true);
   expect(cases.some(x=>x.review_revision_id===peer&&x.reason_code==='MISSING_REASON')).toBe(true);
   expect(cases.some(x=>x.review_revision_id===cancelled)).toBe(false);
   expect(cases.some(x=>x.reason_code==='SELF_PEER_DIFF')).toBe(false);
   expect((await createTriggers(c,cycle,org,thresholdsFrom(config))).created).toBe(0);
   await c.query("UPDATE assignments SET status='CANCELLED' WHERE id=(SELECT assignment_id FROM reviews WHERE current_revision_id=$1)",[peer]);
   await createTriggers(c,cycle,org,thresholdsFrom(config));
   const invalidated=await c.query('SELECT count(*)::int AS n FROM calibration_cases WHERE review_revision_id=$1 AND invalidated_at IS NULL',[peer]);
   expect(invalidated.rows[0].n).toBe(0);
  }finally{await c.query('ROLLBACK');c.release();await pool.end();}
 });
});
