import type { User, Ruleset, Cycle, Review, CalibrationCase, ResultBuild, PublishedResult, DepartmentProgress, AwardCandidate, AwardDecision, MonthlyReport, AuditEvent } from '../mock/data.js';
import type { FeedbackRecord, FeedbackContext } from '../contracts/feedback';
import { oversightPreviewActive } from '../lib/visualPreview';

const API = '/api/v1';
type Any = Record<string, any>;
export interface PersonalCycleData {
  eligible: boolean;
  peers: Array<{ assignmentId: string; review: { id: string; status: string } | null }>;
  self: { reviewId: string | null; status: string };
}
const names = new Map<string, string>();
let currentUser: User | null = null;
const pick = (v: Any, camel: string, snake: string, fallback?: any) => v?.[camel] ?? v?.[snake] ?? fallback;

export function realUserName(id: string): string { return names.get(id) ?? id; }

// Reuse the current self-review lookup/creation flow while keeping the complete
// existing detail response available to this page (stable codes and submitted text).
async function selfReviewDetail(cycleIds: string[]): Promise<Any | undefined> {
  for (const id of cycleIds) {
    const tasks=await http<Any>('GET', `/cycles/${id}/assignments/me`);
    if(tasks.self?.reviewId)return http<Any>('GET',`/reviews/${tasks.self.reviewId}`);
    if(tasks.cycle.status==='REVIEWING'){
      const created=await http<{reviewId:string}>('POST',`/cycles/${id}/self-review`,{});
      return http<Any>('GET',`/reviews/${created.reviewId}`);
    }
  }
  return undefined;
}

async function http<T = Any>(method: string, path: string, body?: unknown, headers?: HeadersInit): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const send = () => fetch(API + path, { method, credentials: 'include', headers: isForm ? headers : body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
  let response = await send();
  // 凭证偶发丢失（代理/浏览器瞬时问题）时静默重试一次，避免用户直接看到 401
  if (response.status === 401) { await new Promise((r) => setTimeout(r, 150)); response = await send(); }
  const text = await response.text();
  let json: Any | null = null;
  if (text) { try { json = JSON.parse(text); } catch { throw new Error(`INVALID_API_RESPONSE_${response.status}`); } }
  if (!response.ok) {
    const detail = json?.detail ?? json?.message;
    const violations = Array.isArray(json?.violations) ? `：${json.violations.map((v: Any) => v.detail ?? v.code).join('；')}` : '';
    const rawCode = String(json?.code ?? detail ?? `HTTP_${response.status}`);
    const authLost = rawCode === 'UNAUTHENTICATED' || rawCode === 'SESSION_INVALID';
    const error = new Error((authLost ? 'AUTH_REQUIRED' : rawCode) + violations) as Error & { code?: string; detail?: unknown; status?: number; violations?: Any[] };
    error.code = authLost ? 'AUTH_REQUIRED' : json?.code;
    error.detail = json?.detail;
    error.violations = json?.violations;
    error.status = response.status;
    throw error;
  }
  return (json?.data ?? json) as T;
}

function mapCycle(r: Any): Cycle {
  return { participantCount: r.participant_count ?? r.participants?.filter((p:Any)=>p.eligibility!=='EXCLUDED').length, id: r.id, month: String(r.month ?? '').slice(0, 7), title: r.title ?? '', status: r.status ?? '', openAt: pick(r, 'openAt', 'open_at', ''), closeAt: pick(r, 'closeAt', 'close_at', ''), selfCloseAt: pick(r, 'selfCloseAt', 'self_close_at', ''), publishAt: pick(r, 'publishAt', 'publish_at', ''), rulesetId: pick(r, 'rulesetId', 'ruleset_id', ''), phase: r.phase ?? 'CLOSE', participants: (r.participants ?? []).map((p: Any) => ({ userId: pick(p, 'userId', 'user_id', ''), role: pick(p, 'roleSnapshot', 'role_snapshot', p.role ?? '') })), assignments: [], reviews: [], calibrationCases: [], resultBuilds: [], publishedResults: [] };
}
function mapRuleset(r: Any): Ruleset {
  const templates = (r.templates ?? []).map((t: Any) => ({
    roleCode: pick(t, 'roleCode', 'role_code', ''),
    roleLabel: t.roleLabel ?? t.name ?? t.role_code ?? '',
    items: (t.items ?? []).map((item: Any) => ({
      id: item.id ?? item.code, label: item.label, weight: Number(item.weight),
    })),
  }));
  return {
    id: r.id, name: r.name ?? `规则集 v${r.version}`, status: r.status,
    templateCount: r.template_count ?? templates.length, templates,
  };
}
function mapReview(d: Any): Review | undefined {
  const r = d?.review; if (!r) return undefined;
  // The review detail API already returns the target's display name. Cache it
  // while mapping the review so task lists can render a human-readable name
  // instead of falling back to the UUID.
  const target = r.target ?? {};
  const targetId = target.id ?? pick(r, 'targetId', 'target_id', '');
  const targetName = target.displayName ?? target.display_name ?? target.name;
  if (targetId && targetName) names.set(targetId, String(targetName));
  const items = d.template?.items ?? [], data = d.draft?.dataJson ?? d.draft?.data_json ?? {}, saved = data.items ?? [];
  return { id: r.id, cycleId: pick(r, 'cycleId', 'cycle_id', ''), assignmentId: pick(r, 'assignmentId', 'assignment_id', ''), kind: r.kind, reviewerId: currentUser?.id ?? '', targetId, status: r.status, template: { roleCode: d.template?.roleCode ?? d.template?.role_code ?? 'MEMBER', items: items.map((x: Any) => ({ id: x.id, label: x.label, weight: x.weight })) }, draft: { items: items.map((x: Any) => { const s = saved.find((v: Any) => (v.itemId ?? v.item_id) === x.id); return { itemId: x.id, label: x.label, score: s?.score ?? null, reason: s?.reason ?? '' }; }), overallReason: data.overallReason ?? data.overall_reason ?? '', comment: data.comment ?? '', nextPlan: data.nextPlan ?? data.next_plan ?? '', readConfirmed: !!(data.readConfirmed ?? data.read_confirmed) }, revision: d.latestRevision ? { scoreBp: d.latestRevision.scoreBp ?? d.latestRevision.score_bp ?? 0, items: d.latestRevision.items ?? [], submittedAt: d.latestRevision.submittedAt ?? d.latestRevision.submitted_at ?? '' } : null, revisionRequest: d.revisionRequest ?? null };
}
function mapBuild(r: Any): ResultBuild { return { id: r.id, cycleId: pick(r, 'cycleId', 'cycle_id', ''), targetId: pick(r, 'targetId', 'target_id', ''), status: r.status, exactScore: pick(r, 'exactScore', 'exact_score', null), dimensionJson: pick(r, 'dimensionJson', 'dimension_json', {}), inputHash: pick(r, 'inputHash', 'input_hash', '') }; }
function mapPublication(r: Any): PublishedResult { return { id: r.id, cycleId: pick(r, 'cycleId', 'cycle_id', ''), targetId: pick(r, 'targetId', 'target_id', ''), publicationVersion: pick(r, 'publicationVersion', 'publication_version', 1), payloadJson: pick(r, 'payloadJson', 'payload_json', {}) }; }
function mapFeedback(r: Any): FeedbackRequest { return { id: r.id, cycleId: pick(r, 'cycleId', 'cycle_id', ''), targetId: pick(r, 'targetId', 'target_id', ''), reason: r.reason ?? '', createdAt: pick(r, 'createdAt', 'created_at', ''), status: r.status, handlerNote: r.handlerNote ?? r.handler_note, rereviewReason: pick(r, 'rereviewReason', 'rereview_reason', undefined), rereviewOpenedAt: pick(r, 'rereviewOpenedAt', 'rereview_opened_at', undefined) }; }
function mapCalibration(r: Any): CalibrationCase {
  if(r.target?.id&&r.target?.displayName)names.set(r.target.id,r.target.displayName);
  if(r.source?.reviewer?.id&&r.source?.reviewer?.displayName)names.set(r.source.reviewer.id,r.source.reviewer.displayName);
  return {id:r.id,cycleId:r.cycle?.id??pick(r,'cycleId','cycle_id',''),trigger:r.reasonCode??r.trigger??'',status:r.status,
    targetId:r.target?.id??pick(r,'targetId','target_id',''),reviewerId:r.source?.reviewer?.id??pick(r,'reviewerId','reviewer_id',''),
    reviewId:pick(r,'reviewId','review_id',''),reason:r.detail??r.reason??'',totalScore:r.source?.scoreBp!=null?Number(r.source.scoreBp)/100:pick(r,'totalScore','total_score',0),
    ratioPct:pick(r,'ratioPct','ratio_pct'),peerCount:pick(r,'peerCount','peer_count'),createdAt:pick(r,'createdAt','created_at',''),
    resolvedBy:r.latestAction?.actorId??pick(r,'resolvedBy','resolved_by_name'),resolvedAction:r.latestAction?.action??pick(r,'resolvedAction','resolved_action'),resolvedAt:r.latestAction?.createdAt??pick(r,'resolvedAt','resolved_at')};
}
const calibrationCache=new Map<string,CalibrationCase>();
function mapAudit(r: Any): AuditEvent { return { id: String(r.id), orgId: r.orgId ?? r.org_id ?? '', actorId: r.actorId ?? r.actor_id ?? null, actorName: r.actorName ?? r.actor_name ?? null, action: r.action, resourceType: r.resourceType ?? r.resource_type, resourceId: r.resourceId ?? r.resource_id ?? null, reason: r.reason ?? null, requestId: r.requestId ?? r.request_id ?? null, createdAt: r.createdAt ?? r.created_at ?? '' }; }

export const realApi = {
  async previewPrebindings(){return http<Any>('POST','/auth/feishu/prebindings/preview',{});},
  async listPrebindingBatches(){return http<Any[]>('GET','/auth/feishu/prebindings');},
  async getPrebindingBatch(id:string){return http<Any>('GET','/auth/feishu/prebindings/'+encodeURIComponent(id));},
  async verifyPrebinding(batchId:string,itemId:string,confirmed:boolean,openId:string|undefined,evidence:string){return http<Any>('PUT','/auth/feishu/prebindings/'+encodeURIComponent(batchId)+'/items/'+encodeURIComponent(itemId)+'/verification',{confirmed,openId,evidence});},
  async submitPrebindings(id:string,itemIds:string[],visibilityConfirmed:boolean,visibilityEvidence:string){return http<Any>('POST','/auth/feishu/prebindings/'+encodeURIComponent(id)+'/submit',{itemIds,visibilityConfirmed,visibilityEvidence});},
  async listFeishuBindings() {return http<Any[]>('GET','/auth/feishu/bindings');},
  async revokeFeishuBinding(id:string) {return http('POST','/auth/feishu/bindings/'+encodeURIComponent(id)+'/revoke',{});},
  async listPublishedResults() { const rows=await http<Any[]>('GET', '/published-results');for(const r of rows)if(r.target_id&&r.target_name)names.set(r.target_id,r.target_name);return rows; },
  async whoami() { const d = await http<Any>('GET', '/me'), u = d.user ?? d; currentUser = { isResultViewer: d.isResultViewer === true, isGuidance: d.isGuidance === true, id: u.id, displayName: u.displayName ?? u.display_name ?? '', orgId: u.orgId ?? u.org_id ?? '', deptId: d.department?.dept_id ?? '', deptName: d.department?.dept_name ?? '', roles: (d.appointments ?? []).map((x: Any) => x.role), capabilities: (d.capabilities ?? []).map((x: Any) => x.capability) }; names.set(currentUser.id, currentUser.displayName); return currentUser; },
  async loginAs(id: string) { await http('POST', '/auth/demo-login', { user_id: id }); return this.whoami(); },
  async logout() { await http('POST', '/auth/logout', {}); currentUser = null; },
  async listUsers() { return (await http<Any[]>('GET', '/organization/members')).map(u => { names.set(u.id, u.display_name); return { id: u.id, displayName: u.display_name, orgId: u.org_id ?? '', deptId: u.dept_id ?? '', deptName: u.dept_name ?? '', roles: u.roles ?? [], capabilities: [] }; }); },
  async listDemoUsers() { return (await http<Any[]>('GET', '/auth/demo-users')).map(u=>({id:u.id,displayName:u.display_name,orgId:u.org_id??'',deptId:u.dept_id??'',deptName:u.dept_name??'',roles:u.roles??[],capabilities:u.capabilities??[]})); },
  async getOrganization() { return http<Any>('GET', '/organization'); },
  async listManagedUsers() { return http<Any[]>('GET', '/user-management'); },
  async listRulesets() { return (await http<Any[]>('GET', '/rulesets')).map(mapRuleset); },
  async getRuleset(id: string) { return mapRuleset(await http<Any>('GET', `/rulesets/${id}`)); },
  async listCycles() { return (await http<Any[]>('GET', '/cycles')).map(mapCycle); },
  async getCycle(id: string) { const r = await http<Any>('GET', `/cycles/${id}`); return r ? mapCycle(r) : undefined; },
  async updateCycle(id: string, p: Any) { return mapCycle(await http('PUT', `/cycles/${id}`, { month: p.month, title: p.title, open_at: new Date(p.openAt).toISOString(), close_at: new Date(p.closeAt).toISOString(), publish_at: new Date(p.publishAt).toISOString() })); },
  async deleteCycle(id: string) { return http('DELETE', `/cycles/${id}`); },
  async createCycle(p: { month: string; title: string; rulesetId: string; openAt?: string; closeAt?: string; publishAt?: string }) { const start = p.openAt ? new Date(p.openAt) : new Date(`${p.month}-01T09:00:00+08:00`), close = p.closeAt ? new Date(p.closeAt) : new Date(start), publish = p.publishAt ? new Date(p.publishAt) : new Date(start); if (!p.closeAt) close.setDate(close.getDate() + 10); if (!p.publishAt) publish.setDate(publish.getDate() + 20); return mapCycle(await http('POST', '/cycles', { month: p.month, title: p.title, ruleset_id: p.rulesetId, open_at: start.toISOString(), close_at: close.toISOString(), publish_at: publish.toISOString() })); },
  async previewCycle(id: string) { const r = await http<Any>('POST', `/cycles/${id}/assignment/preview`, {}); return [{ ...r, sourceType: '预览结果', edges: r.edges??[], count: r.edge_count ?? 0 }]; },
  async getManualRelations(id:string) { return http<Any>('GET',`/cycles/${id}/assignment/manual`); },
  async setManualRelation(id:string,reviewerId:string,targetId:string,remove=false,reason='') { return http(remove?'DELETE':'POST',`/cycles/${id}/assignment/manual`,{reviewer_id:reviewerId,target_id:targetId,reason}); },
  async confirmAssignment(id:string,runId:string) { const cycle=await this.getCycle(id);if(cycle?.status==='DRAFT')await http('POST',`/cycles/${id}/submit`,{});await http('POST',`/cycles/${id}/open`,{run_id:runId});return (await this.getCycle(id))!; },
  async openCycle(_id: string):Promise<Cycle> { throw new Error('请先预览完整评价关系，再确认正式生效。'); },
  async getMyTasks(_user: string, cycleId?: string) { const ids = cycleId ? [cycleId] : (await this.listCycles()).map(c => c.id), out: Review[] = []; for (const id of ids) { const d = await http<Any>('GET', `/cycles/${id}/assignments/me`); for (const p of d.peers ?? []) { const target = p.target ?? {}; const targetId = target.id ?? p.target_id; const targetName = target.displayName ?? target.display_name ?? target.name; if (targetId && targetName) names.set(targetId, String(targetName)); if (p.review?.id) { const r = await this.getReview(p.review.id); if (r) out.push(r); } } } return out; },
  // Read-only personal-workspace projection. Keep getSelfReview's creation
  // behavior and the existing task-list adapter unchanged for their callers.
  async getPersonalCycleData(cycleId: string, userId: string): Promise<PersonalCycleData> {
    const [cycle, assignments] = await Promise.all([
      http<{ participants: Array<{ user_id: string; eligibility: string }> }>('GET', `/cycles/${cycleId}`),
      http<{ peers: PersonalCycleData['peers']; self: PersonalCycleData['self'] }>('GET', `/cycles/${cycleId}/assignments/me`),
    ]);
    return {
      eligible: cycle.participants.some(person => person.user_id === userId && person.eligibility === 'ELIGIBLE'),
      peers: assignments.peers,
      self: assignments.self,
    };
  },
  async getSelfReview(_user: string, cycleId?: string) {
    const ids = cycleId ? [cycleId] : (await this.listCycles()).map(c => c.id);
    const detail=await selfReviewDetail(ids);
    return detail?mapReview(detail):undefined;
  },
  async getSelfReviewPage(cycleId:string) { return selfReviewDetail([cycleId]); },
  // Draft JSON already supports null scores. Preserve unscored items AND their
  // reasons; other review pages retain their current adapter behavior.
  async saveSelfReviewDraft(id:string,draft:{items:Array<{itemId:string;score:number|null;reason:string|null}>;overallReason:string|null;comment:string|null;nextPlan:string|null;readConfirmed:boolean}) {
    return http('PUT',`/reviews/${id}/draft`,draft);
  },
  async getEvaluationTasks(cycleId:string) { return http<Any>('GET',`/cycles/${cycleId}/assignments/me`); },
  async getReviewPage(id:string) { return http<Any>('GET',`/reviews/${id}`); },
  async getReviewMaterials(id:string) { return http<Any>('GET',`/reviews/${id}/materials`); },
  async getReview(id: string) { return mapReview(await http('GET', `/reviews/${id}`)); },
  async saveDraft(id: string, d: Review['draft']) { await http('PUT', `/reviews/${id}/draft`, { items: d.items.map(i => ({ itemId: i.itemId, score: i.score ?? null, reason: i.reason || null })), overallReason: d.overallReason || null, comment: d.comment || null, nextPlan: d.nextPlan || null, readConfirmed: d.readConfirmed }); },
  async submitReview(id: string, draft?: Review['draft']) { const r = await http<Any>('POST', `/reviews/${id}/submit`, draft ? { payload: { items: draft.items.map(i => ({ itemId: i.itemId, score: i.score ?? null, reason: i.reason || null })), overallReason: draft.overallReason || null, comment: draft.comment || null, nextPlan: draft.nextPlan || null, readConfirmed: draft.readConfirmed } } : {}); return r.scoreBp ?? r.score_bp ?? 0; },
  async submitRevision(id: string) { const r = await http<Any>('POST', `/reviews/${id}/revision`, {}); return r.scoreBp ?? r.score_bp ?? 0; },
  async listCalibrationCases(id?:string) {
    const out:CalibrationCase[]=[];
    for(let page=1;;page++) {
      const query=new URLSearchParams({page:String(page),page_size:'100'});if(id)query.set('cycle_id',id);
      const rows=await http<Any[]>('GET','/calibration-cases?'+query);
      const mapped=rows.map(mapCalibration);mapped.forEach(c=>calibrationCache.set(c.id,c));out.push(...mapped);
      if(rows.length<100)return out;
    }
  },
  async takeCalibrationAction(id:string,action:string,reason:string,actor:string) {
    const response=await http('POST',`/calibration-cases/${id}/actions`,{action,reason});
    const updated={...(calibrationCache.get(id)??mapCalibration(response)),status:response.status,resolvedAction:response.action,resolvedBy:actor};
    calibrationCache.set(id,updated);return updated;
  },
  async listResultBuilds(id: string) { return (await http<Any[]>('GET', `/cycles/${id}/result-builds`)).map(r => { if (r.target_name) names.set(r.target_id, r.target_name); return mapBuild(r); }); },
  async buildResults(id: string) { return http<{ items: Any[]; incomplete: Array<{ targetId: string; reasons: string[] }> }>('POST', `/cycles/${id}/results/build`, {}); },
  async listReviewScores(id: string) { return http<Any[]>('GET', `/cycles/${id}/review-scores`); },
  async approveBuild(id: string) { return http<Pick<ResultBuild, 'id' | 'status'>>('POST', `/result-builds/${id}/approve`, { decision: 'APPROVED' }); },
  async publishBuild(id: string) { return mapPublication(await http('POST', `/result-builds/${id}/publish`, {})); },
  async getMyGrowthReports() { return http<Any[]>('GET','/me/results'); },
  async getMyResults(_id: string) { return (await http<Any[]>('GET', '/me/results')).map(mapPublication); },
  /** 个人端右上角月评公告（当前周期时间节点 + 管理员正文） */
  async getAnnouncement() { return http<Any>('GET', '/announcements/active'); },
  /** 管理端维护某周期的公告正文 */
  async saveAnnouncement(cycleId: string, p: { title: string; body: string; isPublished: boolean }) { return http<Any>('PUT', `/cycles/${cycleId}/announcement`, p); },
  /** 管理端按周期读取公告 */
  async getCycleAnnouncement(cycleId: string) { return http<Any>('GET', `/cycles/${cycleId}/announcement`); },
  /** 系统设置 → 模型配置 */
  async listLlmProviders() { return http<Any>('GET', '/settings/llm'); },
  async createLlmProvider(p: Any) { return http<Any>('POST', '/settings/llm', p); },
  async updateLlmProvider(id: string, p: Any) { return http<Any>('PUT', `/settings/llm/${id}`, p); },
  async deleteLlmProvider(id: string) { return http<Any>('DELETE', `/settings/llm/${id}`); },
  async setDefaultLlmProvider(id: string) { return http<Any>('POST', `/settings/llm/${id}/default`, {}); },
  async testLlmProvider(id: string) { return http<Any>('POST', `/settings/llm/${id}/test`, {}); },
  /** 催办提醒：把「本期还差什么」推给自己，用于验证飞书通道 */
  async remindCycle(cycleId: string) { return http<Any>('POST', `/cycles/${cycleId}/remind-me`, {}); },
  async listAwardCandidates(cycleId?: string) { const ids = cycleId ? [cycleId] : (await this.listCycles()).map(c => c.id), out: AwardCandidate[] = []; for (const id of ids) { const rows = await http<Any[]>('GET', `/cycles/${id}/award-candidates`); out.push(...rows.map(r => { const score=Number(r.finalScore); if(!r.userId||!r.displayName||r.finalScore==null||!Number.isFinite(score)||score<0||score>100||!r.cycleId||!/^\d{4}-\d{2}/.test(String(r.month)))throw new Error('AWARD_CANDIDATE_INVALID');return { userId:r.userId,displayName:r.displayName,deptName:r.deptName??'',finalScore:score,cycleId:r.cycleId,month:String(r.month).slice(0,7),level:r.level??'' }; })); } return out; },
  async listAwardDecisions(id: string) { return (await http<Any[]>('GET', `/cycles/${id}/award-decisions`)).map(r => ({ id: r.id, cycleId: r.cycleId, targetId: r.targetId, category: r.category, decision: r.decision, reason: r.reason ?? null, createdAt: r.createdAt })); },
  async saveAwardDecision(p: { cycleId: string; targetId: string; category: string; decision: AwardDecision['decision']; reason?: string }) { const r = await http<Any>('POST', '/awards', p); return { id: r.id, cycleId: p.cycleId, targetId: p.targetId, category: p.category, decision: p.decision, reason: p.reason ?? null, createdAt: r.createdAt ?? '' }; },
  async listFeedback(_id: string) { return (await http<Any[]>('GET', '/feedback-requests/mine')).map(mapFeedback); },
  async listAllFeedback() { return (await http<Any[]>('GET', '/feedback-requests')).map(mapFeedback); },
  async listFeedbackManagement() { return http<FeedbackRecord[]>('GET', '/feedback-requests'); },
  async getFeedbackContext(id: string) { return http<FeedbackContext>('GET', `/feedback-requests/${encodeURIComponent(id)}/context`); },
  async requestFeedback(p: { cycleId: string; targetId: string; reason: string }) { const pubs = await this.getMyResults(p.targetId), pub = pubs.find(x => x.cycleId === p.cycleId); if (!pub) throw new Error('PUBLICATION_NOT_FOUND'); return mapFeedback(await http('POST', `/published-results/${pub.id}/feedback-requests`, { reason: p.reason })); },
  async resolveFeedback(id: string, decision: 'APPROVED' | 'REJECTED', note?: string) { return mapFeedback(await http('POST', `/feedback-requests/${id}/resolve`, { decision, note })); },
  async openRereview(id: string, reason: string) { return mapFeedback(await http('POST', `/feedback-requests/${id}/rereview`, { reason })); },
  async resolveRereview(id: string, decision: 'APPROVED' | 'REJECTED', note?: string) { return mapFeedback(await http('POST', `/feedback-requests/${id}/rereview/resolve`, { decision, note })); },
  async getDepartmentProgress(c: string, d: string) { return http<DepartmentProgress>('GET', `/cycles/${c}/departments/${d}/progress`); },
  /** 部长工作台/管理端查看某成员本期材料（仅当前可用版本） */
  async listMemberMaterials(cycleId: string, userId: string) { return http<Any[]>('GET', `/cycles/${cycleId}/participants/${userId}/materials`); },
  async getMonthlyReport(id: string) { return http<MonthlyReport>('GET', `/cycles/${id}/monthly-report`); },
  async listReportFiles(id: string) { return http<Any[]>('GET', `/cycles/${id}/monthly-report/files`); },
  async listMaterials(id: string) { return http<{locked: boolean; lockReason: string | null; lockCount: number; maxLockCount: number; canUnlock: boolean; manualLocked: boolean; unlockedAt: string | null; materials: Any[]}>('GET', `/cycles/${id}/monthly-report/materials`); },
  async submitMaterials(id: string, files: File[], metadata: Array<{name: string; type: string; note: string; materialId?: string}>, requestId: string) { const form = new FormData(); files.forEach(file => form.append('files', file)); form.append('metadata', JSON.stringify(metadata)); form.append('requestId',requestId); return http<Any>('POST', `/cycles/${id}/monthly-report/materials`, form, {}); },
  materialFile(cycleId: string, versionId: string) { return `/api/v1/cycles/${cycleId}/monthly-report/materials/versions/${versionId}/file`; },
  previewReportFile(cycleId: string, fileId: string) { return `/api/v1/cycles/${cycleId}/monthly-report/files/${fileId}/preview`; },
  async uploadReportFile(id: string, file: File) { const form = new FormData(); form.append('file', file); return http<Any>('POST', `/cycles/${id}/monthly-report/files`, form, {}); },
  async lockReportFile(id: string) { return http<Any>('POST', `/cycles/${id}/monthly-report/files/lock`, {}); },
  /** 提交一条飞书云文档链接材料（不传文件） */
  async submitMaterialLink(id: string, payload: {name: string; type: string; url: string; note?: string; materialId?: string}) { return http<Any>('POST', `/cycles/${id}/monthly-report/links`, payload); },
  /** 解锁成果包（本人自助，最多锁定 2 次） */
  async unlockReport(id: string) { return http<Any>('POST', `/cycles/${id}/monthly-report/unlock`, {}); },
  async listAuditEvents(f?: { action?: string; from?: string; to?: string; actorId?: string }) { const q = new URLSearchParams(); for (const [k, v] of Object.entries(f ?? {})) if (v) q.set(k, v); return (await http<Any[]>('GET', `/audit/events${q.size ? `?${q}` : ''}`)).map(mapAudit); },
  async exportAudit(_rows: AuditEvent[], format: 'csv' | 'pdf') { if (oversightPreviewActive(currentUser?.id)) throw new Error('本地模拟预览为只读，不导出真实审计数据。'); const r = await fetch(`${API}/audit/export?format=${format}`, { credentials: 'include' }), content = await r.text(); if (!r.ok) throw new Error(`HTTP_${r.status}`); const filename = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? `audit-events.${format === 'pdf' ? 'html' : 'csv'}`; return { content, filename, mime: format === 'pdf' ? 'text/html' : 'text/csv' }; },
};
type FeedbackRequest = import('../mock/data.js').FeedbackRequest;
