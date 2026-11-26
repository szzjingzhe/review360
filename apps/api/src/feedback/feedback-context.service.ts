import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../database/database.module';
import { PolicyService } from '../authz/policy.service';
import type { AuthContext } from '../auth/current-user.decorator';

interface PublishedItem { item_id?: string; label: string; avg_score: unknown }
interface BuiltItem { itemId: string; avgScore: unknown }
interface Metric { id: string; label: string; weight: number; position: number; template_id: string }

function score(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

/** Only the publication bound to this appeal is projected; raw reviews are never read. */
@Injectable()
export class FeedbackContextService {
  constructor(@Inject(DATABASE_POOL) private readonly db: Pool, private readonly policy: PolicyService) {}

  async get(actor: AuthContext, id: string) {
    // Select identity/authorization metadata first. Do not load score JSON for unauthorized callers.
    const { rows } = await this.db.query(`SELECT p.id,p.cycle_id,p.target_id,p.publication_version,p.published_at,
        c.ruleset_id,cp.dept_snapshot,cp.template_id
      FROM feedback_requests fr
      JOIN published_results p ON p.id=fr.publication_id AND p.org_id=fr.org_id AND p.target_id=fr.applicant_id
      JOIN cycles c ON c.id=p.cycle_id AND c.org_id=fr.org_id
      LEFT JOIN cycle_participants cp ON cp.cycle_id=c.id AND cp.user_id=p.target_id AND cp.org_id=fr.org_id
      WHERE fr.id=$1 AND fr.org_id=$2`, [id, actor.orgId]);
    const publication = rows[0];
    if (!publication) throw new NotFoundException({ code: 'FEEDBACK_REQUEST_NOT_FOUND' });
    const grants = await this.policy.listCapabilities(actor.userId, actor.orgId);
    const canView = actor.userId === publication.target_id || grants.some(g => g.capability === 'calibration.read_raw'
      && (g.scope_type === 'ORG' || g.scope_type === 'CYCLE' && g.scope_id === publication.cycle_id
        || g.scope_type === 'DEPARTMENT' && g.scope_id === publication.dept_snapshot));
    if (!canView) return { result: null, resultUnavailableReason: '当前账号没有查看此申请人评价结果的权限。' };

    const published = (await this.db.query(`SELECT p.payload_json,b.dimension_json FROM published_results p
      LEFT JOIN result_builds b ON b.id=p.result_build_id AND b.org_id=p.org_id
        AND b.cycle_id=p.cycle_id AND b.target_id=p.target_id
      WHERE p.id=$1 AND p.org_id=$2`, [publication.id, actor.orgId])).rows[0];
    const payload = published?.payload_json ?? {}, built = published?.dimension_json ?? {};
    const metrics = (await this.db.query<Metric>(`SELECT ti.id,ti.label,ti.weight,ti.position,ti.template_id
      FROM template_items ti JOIN template_versions tv ON tv.id=ti.template_id AND tv.org_id=ti.org_id
      WHERE tv.ruleset_id=$1 AND ti.org_id=$2 ORDER BY ti.position,ti.id`, [publication.ruleset_id, actor.orgId])).rows;
    const series = (name: 'peer' | 'self') => {
      const items: PublishedItem[] = Array.isArray(payload[name + '_items']) ? payload[name + '_items'] : [];
      const originals: BuiltItem[] = Array.isArray(built[name === 'peer' ? 'peerItems' : 'selfItems'])
        ? built[name === 'peer' ? 'peerItems' : 'selfItems'] : [];
      const mapped = new Map<string, number | null>();
      for (const [index, item] of items.entries()) {
        const original = originals[index];
        const key = item.item_id ?? (original && score(original.avgScore) === score(item.avg_score) ? original.itemId : null);
        const metric = metrics.find(m => m.id === key && m.label === item.label);
        if (metric) mapped.set(metric.id, score(item.avg_score));
      }
      return mapped;
    };
    const peers = series('peer'), self = series('self');
    const dimensions = metrics.filter(m => m.template_id === publication.template_id || peers.has(m.id) || self.has(m.id))
      .map(m => ({ key: m.id, label: m.label, weight: Number(m.weight),
        selfScore: self.get(m.id) ?? null, peerScore: peers.get(m.id) ?? null }));
    return { resultUnavailableReason: null, result: {
      publicationId: publication.id, publicationVersion: publication.publication_version,
      publishedAt: publication.published_at, finalScore: score(payload.final_score), dimensions,
      simulationNotice: payload.simulation === true
        ? (typeof payload.simulation_notice === 'string' ? payload.simulation_notice : '本结果为本地模拟数据，不代表真实评价。') : null,
      notice: '仅展示关联发布版本的自评与匿名他评均分；不同模板指标不按名称强行合并，缺失数据以 — 显示。',
    } };
  }
}
