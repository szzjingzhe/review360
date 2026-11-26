/**
 * 前端模拟 API：异步返回 + 内存态写入，支持交互闭环。
 * 页面通过本模块获取数据/提交动作，无需真实后端。
 */
import {
  users, departments, currentOrg, rulesets, cycles, awardCandidates, feedbackRequests, awardDecisions, monthlyReports, auditEvents,
  type User, type Ruleset, type Cycle, type Review, type CalibrationCase,
  type ResultBuild, type PublishedResult, type AwardCandidate, type FeedbackRequest,
  type AwardDecision, type Assignment, type MonthlyReport, type AuditEvent,
  type DepartmentProgress, type DepartmentProgressMember,
} from './data.js';

// 深拷贝，保证每次刷新页面都回到初始演示态
const db = structuredClone({ users, departments, currentOrg, rulesets, cycles, awardCandidates, feedbackRequests, awardDecisions, monthlyReports, auditEvents });

const delay = (ms = 240) => new Promise((r) => setTimeout(r, ms));
function byId<T extends { id: string }>(arr: T[], id: string): T | undefined {
  return arr.find((x) => x.id === id);
}
export function userName(id: string): string {
  return db.users.find((u) => u.id === id)?.displayName ?? id;
}
export function userById(id: string): User | undefined {
  return db.users.find((u) => u.id === id);
}

export const mockApi = {
  async whoami(): Promise<User> {
    await delay(80);
    // 默认进入个人端演示身份（普通成员）。
    // 注：原实现写死 db.users[4] 并注释为「刘洋」，但该下标实际是 HRPB（赵敏），索引与注释不一致；改为按角色查找。
    return db.users.find((u) => u.roles.includes('MEMBER')) ?? db.users[0];
  },
  async loginAs(userId: string): Promise<User> {
    await delay(120);
    const u = userById(userId);
    if (!u) throw new Error('用户不存在');
    return u;
  },
  async listUsers(): Promise<User[]> { await delay(60); return db.users; },

  // ---- 规则集 ----
  async listRulesets(): Promise<Ruleset[]> { await delay(120); return db.rulesets; },
  async getRuleset(id: string): Promise<Ruleset | undefined> { await delay(100); return byId(db.rulesets, id); },

  // ---- 周期 ----
  async listCycles(): Promise<Cycle[]> { await delay(160); return db.cycles; },
  async getCycle(id: string): Promise<Cycle | undefined> { await delay(120); return byId(db.cycles, id); },
  async createCycle(payload: { month: string; title: string; rulesetId: string }): Promise<Cycle> {
    await delay(300);
    const id = 'c' + Math.random().toString(36).slice(2, 8);
    const ruleset = byId(db.rulesets, payload.rulesetId)!;
    const sampleMembers = db.users.filter((u) => u.roles.includes('MEMBER')).slice(0, 4);
    const cycle: Cycle = {
      id, month: payload.month, title: payload.title, status: 'DRAFT',
      openAt: '', closeAt: '', publishAt: '', rulesetId: payload.rulesetId, phase: 'CLOSE',
      participants: sampleMembers.map((u) => ({ userId: u.id, role: u.roles[0] })),
      assignments: [], reviews: [], calibrationCases: [], resultBuilds: [], publishedResults: [],
    };
    void ruleset;
    db.cycles.unshift(cycle);
    return cycle;
  },
  // 开期预览：返回分配边（按 source_type 分组）
  async previewCycle(cycleId: string): Promise<{ sourceType: string; edges: Assignment[]; count: number }[]> {
    await delay(200);
    const cycle = byId(db.cycles, cycleId);
    if (!cycle) throw new Error('周期不存在');
    const groups = new Map<string, Assignment[]>();
    for (const a of cycle.assignments) {
      if (!groups.has(a.sourceType)) groups.set(a.sourceType, []);
      groups.get(a.sourceType)!.push(a);
    }
    return [...groups.entries()].map(([sourceType, edges]) => ({ sourceType, edges, count: edges.length }));
  },
  async openCycle(cycleId: string): Promise<Cycle> {
    await delay(400);
    const cycle = byId(db.cycles, cycleId);
    if (!cycle) throw new Error('周期不存在');
    // 演示：根据参与者生成假分配（HEAD/HRPB/MEMBER 各一对 + SELF）
    const heads = db.users.filter((u) => u.roles.includes('HEAD'));
    const hrbps = db.users.filter((u) => u.roles.includes('HRPB'));
    const members = cycle.participants.map((p) => p.userId);
    let n = 0;
    for (const m of members) {
      const head = heads[0];
      if (head) cycle.assignments.push({ id: 'a' + ++n, cycleId, sourceType: 'HEAD', reviewerId: head.id, targetId: m, status: 'ACTIVE' });
      const hrpb = hrbps[0];
      if (hrpb) cycle.assignments.push({ id: 'a' + ++n, cycleId, sourceType: 'HRPB', reviewerId: hrpb.id, targetId: m, status: 'ACTIVE' });
      cycle.assignments.push({ id: 'a' + ++n, cycleId, sourceType: 'MEMBER', reviewerId: m === members[0] ? members[1] ?? m : members[0], targetId: m, status: 'ACTIVE' });
      cycle.assignments.push({ id: 'a' + ++n, cycleId, sourceType: 'SELF', reviewerId: m, targetId: m, status: 'ACTIVE' });
    }
    cycle.status = 'REVIEWING';
    return cycle;
  },

  // ---- 我的评价任务 ----
  async getMyTasks(userId: string, cycleId?: string): Promise<Review[]> {
    await delay(160);
    const res: Review[] = [];
    for (const c of db.cycles) {
      if (cycleId && c.id !== cycleId) continue;
      for (const r of c.reviews) {
        if (r.reviewerId === userId && r.kind === 'PEER') res.push(r);
      }
    }
    return res;
  },
  async getSelfReview(userId: string, cycleId?: string): Promise<Review | undefined> {
    await delay(120);
    for (const c of db.cycles) {
      if (cycleId && c.id !== cycleId) continue;
      const r = c.reviews.find((x) => x.reviewerId === userId && x.kind === 'SELF');
      if (r) return r;
    }
    return undefined;
  },
  async getReview(id: string): Promise<Review | undefined> {
    await delay(120);
    for (const c of db.cycles) {
      const r = c.reviews.find((x) => x.id === id);
      if (r) return r;
    }
    return undefined;
  },
  async saveDraft(reviewId: string, draft: Review['draft']): Promise<void> {
    await delay(200);
    for (const c of db.cycles) {
      const r = c.reviews.find((x) => x.id === reviewId);
      if (r) { r.draft = { ...draft, readConfirmed: true }; r.status = 'DRAFT'; return; }
    }
    throw new Error('评价不存在');
  },
  async submitReview(reviewId: string): Promise<number> {
    await delay(300);
    for (const c of db.cycles) {
      const r = c.reviews.find((x) => x.id === reviewId);
      if (r) {
        const items = r.template.items;
        const scores = r.draft.items.map((it) => it.score ?? 0);
        let w = 0, s = 0;
        items.forEach((it, i) => { w += it.weight; s += it.weight * (scores[i] ?? 0); });
        const bp = Math.round((s / w) * 100);
        r.revision = { scoreBp: bp, items: r.draft.items.map((it) => ({ ...it })), submittedAt: new Date().toISOString() };
        r.status = 'SUBMITTED';
        return bp;
      }
    }
    throw new Error('评价不存在');
  },

  /**
   * 更正修订（PRD §9.1）。真实后端要求存在"等原评价人处理"的核验修订请求且未过期；
   * mock 数据不模拟核验退回流程，因此这里只会抛 REVISION_NOT_REQUESTED。
   */
  async submitRevision(reviewId: string): Promise<number> {
    await delay(300);
    for (const c of db.cycles) {
      const r = c.reviews.find((x) => x.id === reviewId);
      if (r) {
        if (!r.revisionRequest) throw new Error('REVISION_NOT_REQUESTED');
        const items = r.template.items;
        const scores = r.draft.items.map((it) => it.score ?? 0);
        let w = 0, s = 0;
        items.forEach((it, i) => { w += it.weight; s += it.weight * (scores[i] ?? 0); });
        const bp = Math.round((s / w) * 100);
        r.revision = { scoreBp: bp, items: r.draft.items.map((it) => ({ ...it })), submittedAt: new Date().toISOString() };
        r.revisionRequest = null;
        return bp;
      }
    }
    throw new Error('评价不存在');
  },

  // ---- 核验 ----
  async listCalibrationCases(cycleId?: string): Promise<CalibrationCase[]> {
    await delay(160);
    const res: CalibrationCase[] = [];
    for (const c of db.cycles) {
      if (cycleId && c.id !== cycleId) continue;
      res.push(...c.calibrationCases);
    }
    return res;
  },
  async takeCalibrationAction(caseId: string, action: string, reason: string, actorId: string): Promise<CalibrationCase> {
    await delay(300);
    for (const c of db.cycles) {
      const cc = c.calibrationCases.find((x) => x.id === caseId);
      if (cc) {
        if (cc.targetId === actorId) throw new Error('SELF_CONFLICT');
        // 找到原评分作者也禁止（演示用：reviewerId === actorId）
        if (cc.reviewerId === actorId) throw new Error('AUTHOR_CONFLICT');
        cc.status = 'RESOLVED';
        cc.resolvedBy = userName(actorId);
        cc.resolvedAction = action;
        cc.resolvedAt = new Date().toISOString();
        cc.reason = reason || cc.reason;
        return cc;
      }
    }
    throw new Error('核验项不存在');
  },

  // ---- 结果构建 / 审批 / 发布 ----
  async listResultBuilds(cycleId: string): Promise<ResultBuild[]> {
    await delay(160);
    const c = byId(db.cycles, cycleId);
    return c ? c.resultBuilds : [];
  },
  async approveBuild(buildId: string, actorId: string): Promise<Pick<ResultBuild, 'id' | 'status'>> {
    await delay(280);
    for (const c of db.cycles) {
      const b = c.resultBuilds.find((x) => x.id === buildId);
      if (b) {
        if (b.targetId === actorId) throw new Error('SELF_AUDIT_FORBIDDEN');
        if (b.status === 'STALE') throw new Error('RESULT_STALE');
        b.status = 'APPROVED';
        return b;
      }
    }
    throw new Error('结果构建不存在');
  },
  async publishBuild(buildId: string, actorId: string): Promise<PublishedResult> {
    await delay(320);
    for (const c of db.cycles) {
      const b = c.resultBuilds.find((x) => x.id === buildId);
      if (!b) continue;
      if (b.targetId === actorId) throw new Error('SELF_AUDIT_FORBIDDEN');
      if (b.status !== 'APPROVED') throw new Error('APPROVAL_REQUIRED');
      b.status = 'PUBLISHED';
      const pub: PublishedResult = {
        id: 'pr' + Math.random().toString(36).slice(2, 8), cycleId: c.id, targetId: b.targetId,
        publicationVersion: c.publishedResults.length + 1,
        payloadJson: {
          month: c.month, final_score: b.exactScore,
          peer_items: b.dimensionJson.peerItems.map((it) => ({ label: it.itemId, avg_score: it.avgScore })),
          self_items: b.dimensionJson.selfItems.map((it) => ({ label: it.itemId, avg_score: it.avgScore })),
          peer_count: b.dimensionJson.peerCount, self_present: b.dimensionJson.selfPresent,
          formula_version: 'equal_weight_peer_avg_self_separate.v1',
        },
      };
      c.publishedResults.push(pub);
      return pub;
    }
    throw new Error('结果构建不存在');
  },

  // ---- 个人结果 ----
  async getMyResults(userId: string): Promise<PublishedResult[]> {
    await delay(160);
    const res: PublishedResult[] = [];
    for (const c of db.cycles) res.push(...c.publishedResults.filter((p) => p.targetId === userId));
    return res;
  },

  // ---- 评优 ----
  async listAwardCandidates(cycleId?: string): Promise<AwardCandidate[]> {
    await delay(160);
    return cycleId ? db.awardCandidates.filter((a) => a.cycleId === cycleId) : db.awardCandidates;
  },
  async listAwardDecisions(cycleId: string): Promise<AwardDecision[]> {
    await delay(120);
    return db.awardDecisions.filter((d) => d.cycleId === cycleId);
  },
  /** 保存评优决定：按 (cycleId, targetId, category) 幂等覆盖 */
  async saveAwardDecision(payload: {
    cycleId: string; targetId: string; category: string; decision: AwardDecision['decision']; reason?: string;
  }): Promise<AwardDecision> {
    await delay(260);
    if (payload.decision !== 'NONE' && !payload.reason?.trim()) {
      throw new Error('AWARD_REASON_REQUIRED');
    }
    const existing = db.awardDecisions.find(
      (d) => d.cycleId === payload.cycleId && d.targetId === payload.targetId && d.category === payload.category,
    );
    if (existing) {
      existing.decision = payload.decision;
      existing.reason = payload.reason ?? null;
      existing.createdAt = new Date().toISOString();
      return existing;
    }
    const dec: AwardDecision = {
      id: 'ad' + Math.random().toString(36).slice(2, 8), cycleId: payload.cycleId, targetId: payload.targetId,
      category: payload.category, decision: payload.decision, reason: payload.reason ?? null, createdAt: new Date().toISOString(),
    };
    db.awardDecisions.push(dec);
    return dec;
  },

  // ---- 反馈申诉 ----
  async listFeedback(userId: string): Promise<FeedbackRequest[]> {
    await delay(120);
    return db.feedbackRequests.filter((f) => f.targetId === userId);
  },
  async listAllFeedback(): Promise<FeedbackRequest[]> {
    await delay(120);
    return db.feedbackRequests;
  },
  async requestFeedback(payload: { cycleId: string; targetId: string; reason: string }): Promise<FeedbackRequest> {
    await delay(240);
    const dup = db.feedbackRequests.find(
      (f) => f.cycleId === payload.cycleId && f.targetId === payload.targetId && f.status === 'PENDING',
    );
    if (dup) throw new Error('FEEDBACK_DUPLICATED');
    const fb: FeedbackRequest = {
      id: 'fb' + Math.random().toString(36).slice(2, 8), cycleId: payload.cycleId, targetId: payload.targetId,
      reason: payload.reason, createdAt: new Date().toISOString(), status: 'PENDING',
    };
    db.feedbackRequests.push(fb);
    return fb;
  },
  /** 处理人审批反馈申诉：APPROVED → DONE，REJECTED → REJECTED */
  async resolveFeedback(requestId: string, decision: 'APPROVED' | 'REJECTED', note?: string): Promise<FeedbackRequest> {
    await delay(260);
    const fb = db.feedbackRequests.find((f) => f.id === requestId);
    if (!fb) throw new Error('FEEDBACK_REQUEST_NOT_FOUND');
    if (fb.status !== 'PENDING') throw new Error('FEEDBACK_NOT_PENDING');
    fb.status = decision === 'APPROVED' ? 'DONE' : 'REJECTED';
    fb.handlerNote = note;
    return fb;
  },
  /** 本人对一级结案（DONE/REJECTED）的反馈发起二次申诉：→ REREVIEW_PENDING */
  async openRereview(requestId: string, reason: string): Promise<FeedbackRequest> {
    await delay(240);
    const fb = db.feedbackRequests.find((f) => f.id === requestId);
    if (!fb) throw new Error('FEEDBACK_REQUEST_NOT_FOUND');
    if (fb.status !== 'DONE' && fb.status !== 'REJECTED') throw new Error('REREVIEW_NOT_ALLOWED');
    fb.status = 'REREVIEW_PENDING';
    fb.rereviewReason = reason;
    fb.rereviewOpenedAt = new Date().toISOString();
    return fb;
  },
  /** 处理人二审二次申诉：APPROVED → REREVIEW_DONE，REJECTED → REREVIEW_REJECTED（终态） */
  async resolveRereview(requestId: string, decision: 'APPROVED' | 'REJECTED', note?: string): Promise<FeedbackRequest> {
    await delay(260);
    const fb = db.feedbackRequests.find((f) => f.id === requestId);
    if (!fb) throw new Error('FEEDBACK_REQUEST_NOT_FOUND');
    if (fb.status !== 'REREVIEW_PENDING') throw new Error('REREVIEW_NOT_PENDING');
    fb.status = decision === 'APPROVED' ? 'REREVIEW_DONE' : 'REREVIEW_REJECTED';
    fb.handlerNote = note;
    return fb;
  },

  // ---- 部门进度聚合（部门端 / 首页部门视角）----
  /** 只返回进度与缺交名单，不含任何原始单份评分、评价者身份或排名 */
  async getDepartmentProgress(cycleId: string, deptId: string): Promise<DepartmentProgress> {
    await delay(160);
    const cycle = byId(db.cycles, cycleId);
    if (!cycle) throw new Error('CYCLE_NOT_FOUND');
    const dept = byId(db.departments, deptId);
    const members: DepartmentProgressMember[] = db.users
      .filter((u) => u.deptId === deptId && !u.roles.includes('SUPERVISOR'))
      .map((u) => {
        const self = cycle.reviews.find((r) => r.kind === 'SELF' && r.targetId === u.id);
        const expected = cycle.assignments.filter(
          (a) => a.targetId === u.id && a.sourceType !== 'SELF' && a.status === 'ACTIVE',
        ).length;
        const received = cycle.reviews.filter(
          (r) => r.kind === 'PEER' && r.targetId === u.id && r.status === 'SUBMITTED',
        ).length;
        return {
          userId: u.id,
          displayName: u.displayName,
          roleSnapshot: u.roles[0] ?? null,
          selfStatus: (self?.status === 'SUBMITTED' ? 'SUBMITTED' : self ? 'DRAFT' : 'NOT_STARTED') as DepartmentProgressMember['selfStatus'],
          peerExpected: expected,
          peerReceived: received,
        };
      });
    return {
      cycleId,
      departmentId: deptId,
      departmentCode: dept?.name ?? null,
      departmentName: dept?.name ?? null,
      memberCount: members.length,
      selfDone: members.filter((m) => m.selfStatus === 'SUBMITTED').length,
      peerReceived: members.reduce((s, m) => s + m.peerReceived, 0),
      peerExpected: members.reduce((s, m) => s + m.peerExpected, 0),
      missingSelf: members
        .filter((m) => m.selfStatus !== 'SUBMITTED')
        .map((m) => ({ userId: m.userId, displayName: m.displayName })),
      materialsAvailable: false,
      materialsSubmitted: null,
      members,
    };
  },

  // ---- 月报（report.view）----
  async getMonthlyReport(cycleId: string): Promise<MonthlyReport> {
    await delay(220);
    const found = db.monthlyReports.find((r) => r.cycleId === cycleId);
    if (found) return found;
    // 演示：未预置快照时基于已发布结果实时聚合（0-100 制）
    const cycle = db.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw new Error('CYCLE_NOT_FOUND');
    const latest = new Map<string, PublishedResult>();
    for (const p of cycle.publishedResults) {
      const prev = latest.get(p.targetId);
      if (!prev || p.publicationVersion > prev.publicationVersion) latest.set(p.targetId, p);
    }
    const buckets = { excellent: 0, good: 0, qualified: 0, low: 0 };
    let sum = 0;
    for (const p of latest.values()) {
      const s = p.payloadJson.final_score ?? 0;
      sum += s;
      if (s >= 90) buckets.excellent++;
      else if (s >= 80) buckets.good++;
      else if (s >= 60) buckets.qualified++;
      else buckets.low++;
    }
    const rows = [...latest.values()];
    const report: MonthlyReport = {
      cycleId, orgId: currentOrg.id, generatedAt: new Date().toISOString(),
      org: {
        participantCount: cycle.participants.length, publishedCount: rows.length,
        avgScore: rows.length ? Math.round(sum / rows.length) : 0, distribution: buckets,
        awardedCount: db.awardDecisions.filter((d) => d.cycleId === cycleId && d.decision === 'AWARDED').length,
        feedbackCount: db.feedbackRequests.filter((f) => f.cycleId === cycleId).length,
        feedbackResolved: db.feedbackRequests.filter((f) => f.cycleId === cycleId && f.status !== 'PENDING').length,
      },
      departments: [],
    };
    return report;
  },

  // ---- 审计事件（audit.export） ----
  async listAuditEvents(filter?: {
    action?: string; from?: string; to?: string; actorId?: string;
  }): Promise<AuditEvent[]> {
    await delay(160);
    let rows = [...db.auditEvents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (filter?.action) rows = rows.filter((r) => r.action === filter.action);
    if (filter?.actorId) rows = rows.filter((r) => r.actorId === filter.actorId);
    if (filter?.from) rows = rows.filter((r) => r.createdAt >= filter.from!);
    if (filter?.to) rows = rows.filter((r) => r.createdAt <= filter.to!);
    return rows;
  },
  // 前端生成 CSV/PDF 下载内容（与真实后端 /audit/export 平行自洽）
  async exportAudit(
    rows: AuditEvent[], format: 'csv' | 'pdf',
  ): Promise<{ content: string; filename: string; mime: string }> {
    await delay(120);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'pdf') {
      return { content: buildAuditHtml(rows), filename: `audit-events-${stamp}.html`, mime: 'text/html' };
    }
    return { content: '﻿' + buildAuditCsv(rows), filename: `audit-events-${stamp}.csv`, mime: 'text/csv' };
  },
};

const AUDIT_COLS = ['序号', '时间', '操作人', '操作', '资源类型', '资源ID', '原因', '请求ID'];
function auditCsvCell(v: string): string {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function buildAuditCsv(rows: AuditEvent[]): string {
  const lines = [AUDIT_COLS.join(',')];
  rows.forEach((r, i) => {
    const cells = [
      String(i + 1), r.createdAt, r.actorName ?? r.actorId ?? '', r.action,
      r.resourceType, r.resourceId ?? '', r.reason ?? '', r.requestId ?? '',
    ].map(auditCsvCell);
    lines.push(cells.join(','));
  });
  return lines.join('\r\n');
}
function auditEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function buildAuditHtml(rows: AuditEvent[]): string {
  const body = rows
    .map((r, i) => {
      const td = (v: string) => `<td>${auditEsc(v)}</td>`;
      return `<tr>${td(String(i + 1))}${td(r.createdAt)}${td(r.actorName ?? r.actorId ?? '')}${td(r.action)}${td(r.resourceType)}${td(r.resourceId ?? '')}${td(r.reason ?? '')}${td(r.requestId ?? '')}</tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>审计事件导出</title>
<style>
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; color: #1f2937; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; } .meta { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; } th { background: #f3f4f6; }
  @media print { body { padding: 0; } .no-print { display: none; } @page { margin: 16mm; } }
</style></head>
<body>
  <h1>360° 环评系统 · 审计事件导出</h1>
  <div class="meta">共 ${rows.length} 条记录 · 生成于 ${new Date().toISOString()}</div>
  <button class="no-print" onclick="window.print()">打印 / 另存为 PDF</button>
  <table><thead><tr>${AUDIT_COLS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
  <tbody>
${body}
  </tbody></table>
</body></html>`;
}

export type MockApi = typeof mockApi;
