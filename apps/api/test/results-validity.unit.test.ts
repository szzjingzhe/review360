import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { buildOne, collectBuildInputs, publishBuildTx, RESULT_FORMULA_VERSION } from '@360/domain';
import { ResultsService } from '../src/results/results.service';
import { CalibrationService } from '../src/calibration/calibration.service';
import { ReviewsService } from '../src/reviews/reviews.service';
import { PublishService } from '../src/results/publish.service';
import { handleClose } from '../../worker/src/phases/handlers';
vi.mock('../../worker/src/db.js', () => ({ withTx: vi.fn() }));

// All database calls below are in-memory doubles. The unit runner forbids pg connections.
const actor = { userId: 'manager', orgId: 'org', displayName: 'Manager', sessionIdHash: 'hash' };
const result = (rows: any[] = []) => ({ rows, rowCount: rows.length });
async function status(promise: Promise<unknown>) {
  try { await promise; return 200; } catch (e: any) { return e.getStatus?.() ?? 500; }
}
function fixture() {
  const state = {
    peers: [86, 90, 88, 92].map((score, i) => ({ id: `peer${i}`, score, active: true, voided: false })),
    self: 95, open: 0, builds: new Map<string, any>(), publications: [] as any[],
  };
  const query = vi.fn(async (sql: string, p: any[] = []): Promise<any> => {
    if (sql.startsWith('SELECT cycle_id FROM result_builds')) return result([{ cycle_id: 'cycle' }]);
    if (sql.includes('SELECT id, status, close_at')) return result([{ id: 'cycle', status: 'REVIEWING', close_at: new Date(0), now: new Date() }]);
    if (sql.includes('SELECT org_id FROM cycles')) return result([{ org_id: 'org' }]);
    if (sql.includes('SELECT status FROM cycles')) return result([{ status: 'CALIBRATING' }]);
    if (sql.includes('SELECT user_id FROM cycle_participants WHERE cycle_id = $1')) return result([{ user_id: 'target' }]);
    if (sql.includes('FROM cycles WHERE id = $1 AND org_id')) return result([{ id: 'cycle', status: 'CALIBRATING', org_id: 'org' }]);
    if (sql.includes('SELECT user_id AS target_id')) return result([{ target_id: 'target' }]);
    if (sql.includes('SELECT user_id FROM cycle_participants')) return result([{ user_id: 'target' }]);
    if (sql.includes('SELECT count(*) AS n FROM assignments')) return result([{ n: '0' }]);
    if (sql.includes('r.checksum AS ruleset_checksum')) return result([{ ruleset_checksum: 'checksum', assignment_version: 1 }]);
    if (sql.includes('config_json')) return result([{ config: {}, config_json: {} }]);
    if (sql.includes('WITH latest AS')) return result();
    if (sql.includes('FROM report_versions')) return result();
    if (sql.includes('FROM result_feedback')) return result([{ n: '0' }]);
    if (sql.includes('SELECT rr.id AS revision_id')) {
      const source = (id: string, score: number, kind: string) => ({ revision_id: id, score_bp: score * 100, kind,
        template_id: 'tpl', expected_template_id: 'tpl', items: [{ itemId: 'metric', score }], template_items: [{ id: 'metric', weight: 100 }] });
      return result([...state.peers.filter(x => x.active && !x.voided).map(x => source(x.id, x.score, 'PEER')), source('self', state.self, 'SELF')]);
    }
    if (sql.includes('SELECT count(*) AS n FROM calibration_cases')) return result([{ n: String(state.open) }]);
    if (sql.includes('INSERT INTO result_builds')) {
      const existing = [...state.builds.values()].find(x => x.input_hash === p[3]);
      if (existing) {
        if (!['APPROVED', 'PUBLISHED'].includes(existing.status)) existing.status = 'BUILT';
        return result([{ id: existing.id, inserted: false }]);
      }
      const b = { id: `build${state.builds.size}`, cycle_id: p[0], target_id: p[2], input_hash: p[3], formula_version: p[4],
        exact_score: p[5], dimension_json: JSON.parse(p[6]), status: 'BUILT' };
      state.builds.set(b.id, b); return result([{ id: b.id, inserted: true }]);
    }
    if (sql.includes("SET status = 'STALE'") || sql.includes("SET status='STALE'")) {
      for (const b of state.builds.values()) {
        if (b.status === 'PUBLISHED') continue;
        if (sql.includes('WHERE id=$1') ? b.id === p[0] : b.input_hash !== p[2]) b.status = 'STALE';
      }
      return result();
    }
    if (sql.includes('FROM result_builds') && sql.includes('FOR UPDATE')) return result([state.builds.get(p[0])].filter(Boolean));
    if (sql.includes('FROM result_approvals')) return result([{ decision: 'APPROVED', approver_id: 'independent' }]);
    if (sql.includes('SELECT ti.id AS item_id')) return result([{ item_id: 'metric', label: 'Metric' }]);
    if (sql.includes("to_char(month")) return result([{ m: '2026-10' }]);
    if (sql.includes('publication_version AS v')) return result(state.publications.map((x, i) => ({ id: x.id, v: i + 1 })).reverse().slice(0, 1));
    if (sql.includes('INSERT INTO published_results')) {
      const pub = { id: `publication${state.publications.length}`, payload: JSON.parse(p[5]) };
      state.publications.push(pub); return result([{ id: pub.id }]);
    }
    if (sql.includes("UPDATE result_builds SET status = 'PUBLISHED'")) { state.builds.get(p[0]).status = 'PUBLISHED'; return result(); }
    return result();
  });
  const client = { query, release: vi.fn() } as any;
  return { state, query, client, db: { query, connect: async () => client } as any };
}

describe('Result construction and publication, real services with database doubles', () => {
  it('batch and single construction both return 89 using user_id, not target_id on participants', async () => {
    const f = fixture(); const service = new ResultsService(f.db);
    const batch = await service.buildResults(actor, 'cycle', undefined);
    const single = await service.buildResults(actor, 'cycle', { targetId: 'target' });
    expect(batch.items[0].exactScore).toBe(89); expect(single.items[0]).toMatchObject({ exactScore: 89, buildId: batch.items[0].buildId });
    expect(f.query.mock.calls.some(([sql]) => sql.includes('SELECT user_id AS target_id'))).toBe(true);
  });
  it('cancelled and voided revisions are excluded by the effective-source query', async () => {
    const f = fixture(); f.state.peers[0].active = false; f.state.peers[1].voided = true;
    const inputs = await collectBuildInputs(f.client, 'cycle', 'target');
    expect(inputs.peers.map(x => x.revisionId)).toEqual(['peer2', 'peer3']);
    const sql = f.query.mock.calls.find(([s]) => s.includes('SELECT rr.id AS revision_id'))![0];
    for (const text of ["ea.status='ACTIVE'", "'VOID_APPROVE'", 'r.current_revision_id=rr.id']) expect(sql).toContain(text);
    expect((await buildOne(f.client, 'cycle', 'org', 'target')).exactScore).toBe(90);
  });
  it('zero effective peers cannot produce a build', async () => {
    const f = fixture(); f.state.peers.forEach(x => x.voided = true);
    await expect(buildOne(f.client, 'cycle', 'org', 'target')).rejects.toMatchObject({ reasons: ['NO_PEER_REVIEWS'] });
    expect(f.state.builds.size).toBe(0);
  });
  it.each(['open', 'void', 'old-formula'])('%s prevents publication and invalidates the old pending build', async (change) => {
    const f = fixture(); const built = await buildOne(f.client, 'cycle', 'org', 'target');
    const b = f.state.builds.get(built.buildId); b.status = 'APPROVED';
    if (change === 'open') f.state.open = 1;
    if (change === 'void') f.state.peers[0].voided = true;
    if (change === 'old-formula') b.formula_version = 'self30_peer70@v1.0';
    expect(await publishBuildTx(f.client, 'org', b.id)).toBeNull();
    expect(b.status).toBe('STALE'); expect(f.state.publications).toHaveLength(0);
  });
  it('rebuilding a published input preserves its publication and status', async () => {
    const f = fixture(); const built = await buildOne(f.client, 'cycle', 'org', 'target');
    const b = f.state.builds.get(built.buildId); b.status = 'APPROVED';
    await publishBuildTx(f.client, 'org', b.id);
    const snapshot = JSON.stringify(f.state.publications);
    const reused = await buildOne(f.client, 'cycle', 'org', 'target');
    expect(reused.buildId).toBe(b.id); expect(b.status).toBe('PUBLISHED');
    expect(JSON.stringify(f.state.publications)).toBe(snapshot);
    const sql = f.query.mock.calls.find(([s]) => s.includes('INSERT INTO result_builds'))![0];
    expect(sql).toContain("('APPROVED','PUBLISHED')");
    expect(f.state.publications[0].payload.formula_version).toBe(RESULT_FORMULA_VERSION);
  });
  it('a self revision changes the snapshot hash but not the final score', async () => {
    const f = fixture(); const a = await buildOne(f.client, 'cycle', 'org', 'target'); f.state.self = 0;
    const b = await buildOne(f.client, 'cycle', 'org', 'target');
    expect(a.exactScore).toBe(89); expect(b.exactScore).toBe(89); expect(a.selfScore).toBe(95); expect(b.selfScore).toBe(0);
    expect(a.buildId).not.toBe(b.buildId);
  });
  it('corrections publish a new version while the previous snapshot stays immutable', async () => {
    const f = fixture(); const first = await buildOne(f.client, 'cycle', 'org', 'target');
    f.state.builds.get(first.buildId).status = 'APPROVED';
    await publishBuildTx(f.client, 'org', first.buildId);
    const original = JSON.stringify(f.state.publications[0]);
    f.state.peers[0].score = 90;
    const corrected = await buildOne(f.client, 'cycle', 'org', 'target');
    f.state.builds.get(corrected.buildId).status = 'APPROVED';
    expect(await publishBuildTx(f.client, 'org', corrected.buildId)).toMatchObject({ publicationVersion: 2, exactScore: 90 });
    expect(JSON.stringify(f.state.publications[0])).toBe(original);
    expect(f.state.builds.get(first.buildId).status).toBe('PUBLISHED');
    const insert = f.query.mock.calls.filter(([s]) => s.includes('INSERT INTO published_results'))[1];
    expect(insert[1][6]).toBe('publication0');
  });
  it('normal deadline close scans before building results', async () => {
    const f = fixture();
    expect(await handleClose(f.client, 'cycle', new Date())).toMatchObject({ kind: 'EXECUTED', reason: 'built=1 skipped=0' });
    const scan = f.query.mock.calls.findIndex(([s]) => s.includes('WITH latest AS'));
    const build = f.query.mock.calls.findIndex(([s]) => s.includes('INSERT INTO result_builds'));
    expect(scan).toBeGreaterThan(-1); expect(build).toBeGreaterThan(scan);
  });
  it('API commits invalidation before returning 409, rather than rolling it back', async () => {
    const f = fixture(); const built = await buildOne(f.client, 'cycle', 'org', 'target');
    const b = f.state.builds.get(built.buildId); b.status = 'APPROVED'; f.state.peers[0].voided = true;
    expect(await status(new PublishService(f.db).publishBuild(actor, b.id))).toBe(409);
    expect(b.status).toBe('STALE'); expect(f.query.mock.calls.some(([s]) => s === 'COMMIT')).toBe(true);
    expect(await status(new PublishService(f.db).publishBuild(actor, b.id))).toBe(409);
  });
});

describe('Calibration void workflow without a database', () => {
  function calibration(requester: string | null) {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT cycle_id')) return result([{ cycle_id: 'cycle' }]);
      if (sql.includes('FOR UPDATE OF cc,rv')) return result([{ id: 'case', status: 'OPEN', org_id: 'org', cycle_id: 'cycle',
        target_id: 'target', reviewer_id: 'reviewer', void_requested_by: requester, review_id: 'review', revision_id: 'revision', current_revision_id: 'revision' }]);
      return result();
    });
    return { query, service: new CalibrationService({ connect: async () => ({ query, release() {} }) } as any) };
  }
  it('approval without a formal request is 409 and cannot withdraw a review', async () => {
    const f = calibration(null); expect(await status(f.service.actOnCase(actor, 'case', { action: 'VOID_APPROVE', reason: 'test' }))).toBe(409);
    expect(f.query.mock.calls.some(([s]) => s.includes("status='WITHDRAWN'"))).toBe(false);
  });
  it('requester cannot approve; independent approval withdraws the revision and stales pending builds', async () => {
    const blocked = calibration('manager'); expect(await status(blocked.service.actOnCase(actor, 'case', { action: 'VOID_APPROVE', reason: 'test' }))).toBe(403);
    const f = calibration('other'); expect(await status(f.service.actOnCase(actor, 'case', { action: 'VOID_APPROVE', reason: 'test' }))).toBe(200);
    expect(f.query.mock.calls.some(([s]) => s.includes("status='WITHDRAWN'"))).toBe(true);
    expect(f.query.mock.calls.some(([s]) => s.includes("status IN ('BUILT','APPROVED')"))).toBe(true);
    expect(f.query.mock.calls.some(([s]) => s.includes('INSERT INTO audit_events'))).toBe(true);
  });
});

describe('Review submission server checks', () => {
  function reviews(active = true, withdrawn = false, submitted = false) {
    const own = { reviewer_id: 'manager', target_id: 'target', cycle_id: 'cycle', org_id: 'org', kind: 'PEER', assignment_id: 'assignment', status: withdrawn ? 'WITHDRAWN' : submitted ? 'SUBMITTED' : 'DRAFT' };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT cycle_id FROM reviews')) return result([{ cycle_id: 'cycle' }]);
      if (sql.includes('FROM reviews') && sql.includes('FOR UPDATE')) return result([own]);
      if (sql.includes('FROM assignments')) return active ? result([{ id: 'assignment' }]) : result();
      if (sql.includes('SELECT ti.id,ti.weight')) return result([1, 2, 3, 4].map(i => ({ id: `metric${i}`, weight: 25, template_id: 'tpl' })));
      if (sql.includes('SELECT status, close_at')) return result([{ status: 'REVIEWING', close_at: new Date(Date.now() + 60000) }]);
      if (sql.includes('MAX(revision_no)')) return result([{ max: submitted ? 1 : null }]);
      if (sql.includes('INSERT INTO review_revisions')) return result([{ id: 'new-revision' }]);
      if (sql.includes('config_json')) return result([{ config_json: {}, config: {}, checksum: 'checksum' }]);
      if (sql.includes('SELECT cc.id, cc.revision_due_at')) return result([{ id: 'case', revision_due_at: new Date(Date.now() + 60000), latest_action: 'SUGGEST_REVISION' }]);
      return result();
    });
    return { query, service: new ReviewsService({ connect: async () => ({ query, release() {} }) } as any) };
  }
  it('partial dimensions are rejected before inserting a revision', async () => {
    const f = reviews();
    await expect(f.service.submitReview(actor, 'review', { payload: { items: [{ itemId: 'metric1', score: 70 }], readConfirmed: true } })).rejects.toMatchObject({ response: { code: 'REQUIRED_ITEM_MISSING' } });
    expect(f.query.mock.calls.some(([s]) => s.includes('INSERT INTO review_revisions'))).toBe(false);
  });
  it('cancelled assignment refuses both draft and submission with 403', async () => {
    const f = reviews(false);
    expect(await status(f.service.saveDraft(actor, 'review', { items: [] }))).toBe(403);
    expect(await status(f.service.submitReview(actor, 'review', { payload: { items: [], readConfirmed: true } }))).toBe(403);
  });
  it('withdrawn review cannot be resubmitted', async () => {
    const f = reviews(true, true);
    expect(await status(f.service.submitReview(actor, 'review', { payload: { items: [], readConfirmed: true } }))).toBe(403);
  });
  it('valid full submission records the template, invalidates pending builds and scans', async () => {
    const f = reviews();
    const submitted = await f.service.submitReview(actor, 'review', { payload: { items: [1,2,3,4].map(i => ({itemId:`metric${i}`,score:70})), readConfirmed:true } });
    expect(submitted.scoreBp).toBe(7000);
    expect(f.query.mock.calls.some(([s]) => s.includes("status IN ('BUILT','APPROVED')"))).toBe(true);
    expect(f.query.mock.calls.some(([s]) => s.includes('WITH latest AS'))).toBe(true);
  });
  it('controlled revision invalidates pending builds and preserves the prior revision', async () => {
    const f = reviews(true, false, true);
    expect(await f.service.submitRevision(actor, 'review', { payload: { items: [1,2,3,4].map(i => ({itemId:`metric${i}`,score:70})), readConfirmed:true } })).toMatchObject({ revisionNo:2,scoreBp:7000 });
    expect(f.query.mock.calls.some(([s]) => s.includes("status IN ('BUILT','APPROVED')"))).toBe(true);
    expect(f.query.mock.calls.some(([s]) => /UPDATE review_revisions|DELETE FROM review_revisions/.test(s))).toBe(false);
    expect(f.query.mock.calls.some(([s]) => s.includes("'REVISION_SUBMITTED'"))).toBe(true);
  });
});
