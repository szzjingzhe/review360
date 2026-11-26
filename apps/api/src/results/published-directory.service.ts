import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PolicyService } from '../authz/policy.service';
import type { AuthContext } from '../auth/current-user.decorator';

@Injectable()
export class PublishedDirectoryService {
  constructor(@Inject('DATABASE_POOL') private readonly db: Pool, private readonly policy: PolicyService) {}
  async list(actor: AuthContext) {
    await this.policy.assertCollection(actor, 'result.read_published');
    const params: unknown[]=[actor.orgId];
    const scope=this.policy.scopedSql(actor,'result.read_published','p.cycle_id','cp.dept_snapshot',params);
    // Select an explicit aggregate projection, never payload_json or build/review sources.
    return (await this.db.query(`SELECT p.id,p.cycle_id,c.title,c.status AS cycle_status,to_char(c.month,'YYYY-MM') AS month,
      p.target_id,u.display_name AS target_name,d.name AS department_name,p.publication_version,p.published_at,
      p.payload_json->'final_score' AS final_score,p.payload_json->'self_score' AS self_score,
      p.payload_json->'formula_version' AS formula_version
      FROM published_results p JOIN cycles c ON c.id=p.cycle_id AND c.org_id=p.org_id
      JOIN users u ON u.id=p.target_id AND u.org_id=p.org_id
      JOIN cycle_participants cp ON cp.cycle_id=p.cycle_id AND cp.user_id=p.target_id AND cp.org_id=p.org_id
      LEFT JOIN departments d ON d.id=cp.dept_snapshot AND d.org_id=p.org_id
      WHERE p.org_id=$1 AND ${scope}
        AND p.publication_version=(SELECT max(p2.publication_version) FROM published_results p2
          WHERE p2.org_id=p.org_id AND p2.cycle_id=p.cycle_id AND p2.target_id=p.target_id)
      ORDER BY c.month DESC,u.display_name,p.target_id`,params)).rows;
  }
}
