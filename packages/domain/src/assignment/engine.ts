import { createHash } from 'node:crypto';
import type { AssignmentInput, AssignmentResult, AssignmentShortfall, AssignmentShortfallReason, Edge, Participant } from './types.js';
import { sample, shuffle, createPrng } from './prng.js';
import {assignmentEdgeIssue,ASSIGNMENT_MAX_INDEGREE,ASSIGNMENT_MAX_OUTDEGREE} from './constraints.js';

export const ALGORITHM_VERSION = 'v2.2-manual-first-cross-department-fallback';

/** 每名被评价人应获得的他评份数下限（开期预检按此判定可行性）。 */
export const MIN_INDEGREE = 4;
const MAX_INDEGREE = ASSIGNMENT_MAX_INDEGREE;
const MAX_OUTDEGREE = ASSIGNMENT_MAX_OUTDEGREE;

interface Grouped {
  byDept: Map<string, Participant[]>;
  heads: Participant[];
  supervisor?: Participant;
  members: Participant[];
  peers: Participant[];
}

function group(input: AssignmentInput): Grouped {
  const byDept = new Map<string, Participant[]>();
  for (const p of input.participants) {
    const list = byDept.get(p.deptId) ?? [];
    list.push(p);
    byDept.set(p.deptId, list);
  }
  const heads: Participant[] = [];
  let supervisor: Participant | undefined;
  const members: Participant[] = [];
  for (const p of input.participants) {
    if (p.role === 'HEAD') heads.push(p);
    else if (p.role === 'SUPERVISOR') supervisor = p;
    else if (p.role === 'MEMBER') members.push(p);
  }
  const peers = [...members];
  return { byDept, heads, supervisor, members, peers };
}

function key(reviewer: string, target: string): string {
  return `${reviewer}->${target}`;
}

class EdgeBuilder {
  edges: Edge[] = [];
  seen = new Set<string>();
  historyCount = new Map<string, number>();
  avoidSet = new Set<string>();
  indeg: Map<string, number> = new Map();
  outdeg: Map<string, number> = new Map();

  constructor(
    history: AssignmentInput['history'],
    avoidPairs: AssignmentInput['avoidPairs'],
    private readonly participants: Participant[],
  ) {
    for (const h of history) {
      const k = key(h.reviewerId, h.targetId);
      this.historyCount.set(k, (this.historyCount.get(k) ?? 0) + 1);
    }
    for (const [a, b] of avoidPairs) {
      this.avoidSet.add(key(a, b));
      this.avoidSet.add(key(b, a));
    }
    for (const p of participants) {
      this.indeg.set(p.userId, 0);
      this.outdeg.set(p.userId, 0);
    }
  }

  canAdd(reviewerId: string, targetId: string, allowCrossDepartment = false): boolean {
    if(assignmentEdgeIssue(this.participants,this.edges,reviewerId,targetId,allowCrossDepartment))return false;
    if (reviewerId === targetId) return false;
    const k = key(reviewerId, targetId);
    if (this.seen.has(k)) return false;
    if (this.avoidSet.has(k)) return false;
    if ((this.outdeg.get(reviewerId) ?? 0) >= MAX_OUTDEGREE) return false;
    if ((this.indeg.get(targetId) ?? 0) >= MAX_INDEGREE) return false;
    return true;
  }

  add(reviewerId: string, targetId: string, sourceType: Edge['sourceType'], isFixed: boolean): boolean {
    if (!this.canAdd(reviewerId, targetId, sourceType === 'MANUAL' || sourceType === 'PEER_CROSS_DEPT')) return false;
    const k = key(reviewerId, targetId);
    this.seen.add(k);
    this.edges.push({ reviewerId, targetId, sourceType, isFixed });
    this.indeg.set(targetId, (this.indeg.get(targetId) ?? 0) + 1);
    this.outdeg.set(reviewerId, (this.outdeg.get(reviewerId) ?? 0) + 1);
    return true;
  }
}

function stableSort<T>(arr: T[], keyFn: (x: T) => string): T[] {
  return [...arr].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

export function generateAssignment(input: AssignmentInput): AssignmentResult {
  const diagnostics: string[] = [];
  const { byDept, heads, supervisor, members, peers } = group(input);
  const builder = new EdgeBuilder(input.history, input.avoidPairs, input.participants);
  const partById = new Map(input.participants.map((p) => [p.userId, p]));
  for (const edge of [...(input.manualEdges ?? [])].sort((a,b)=>key(a.reviewerId,a.targetId).localeCompare(key(b.reviewerId,b.targetId)))) {
    const reviewer=partById.get(edge.reviewerId), target=partById.get(edge.targetId);
    if (!reviewer || !target || !['HEAD','MEMBER'].includes(reviewer.role) || !['HEAD','MEMBER'].includes(target.role)
      || (builder.indeg.get(target.userId)??0)>=MAX_INDEGREE
      || !builder.add(reviewer.userId,target.userId,'MANUAL',true)) {
      diagnostics.push(`人工关系不合法或超过容量：${edge.reviewerId}->${edge.targetId}`);
    }
  }

  // 1. 同组互评：本版本统一由同组关系生成，取消跨组的上下级专门边。
  //    先生成部长互评，确保部长之间可以双向互评，再为部长保留剩余容量。
  // 2. 部长互评：部长按 seed 排序形成有向环；两个部长时自然形成双向评价。
  if (heads.length >= 2) {
    const ordered = shuffle(stableSort(heads, (h) => h.userId), `${input.seed}:head-loop`);
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i];
      const b = ordered[(i + 1) % ordered.length];
      if (a.userId !== b.userId) builder.add(a.userId, b.userId, 'HEAD_LOOP', false);
    }
  }

  // 3. 部长 → 本部门成员，最多使用部长剩余容量（通常为 4 个）。
  for (const [deptId, people] of byDept) {
    // 外部人员（EXTERNAL）可能挂虚设部门；无部长且无正式成员的组不参与、不算缺陷
    if (!people.some((p) => p.role === 'HEAD') && people.every((p) => p.role === 'EXTERNAL')) {
      continue;
    }
    const head = people.find((p) => p.role === 'HEAD');
    if (!head) {
      diagnostics.push(`部门 ${deptId} 缺少部长`);
      continue;
    }
    // 固定关系的成员集合保持稳定；剩余成员通过同部门动态边轮换覆盖。
    const candidates = stableSort(people.filter((p) => p.role === 'MEMBER'), (p) => p.userId);
    for (const p of candidates) {
      if ((builder.outdeg.get(head.userId) ?? 0) >= MAX_OUTDEGREE) break;
      builder.add(head.userId, p.userId, 'HEAD_TO_MEMBER', true);
    }
  }

  // 4. 成员 → 本部门部长：成员可以评价部长，选择 2 人作为向上评价。
  for (const [deptId, people] of byDept) {
    const head = people.find((p) => p.role === 'HEAD');
    if (!head) continue;
    const candidates = people.filter((p) => p.role === 'MEMBER' && p.userId !== head.userId);
    const selected = sample(candidates, Math.min(2, candidates.length), `${input.seed}:upward:${deptId}`);
    for (const reviewer of selected) {
      builder.add(reviewer.userId, head.userId, 'MEMBER_TO_HEAD', false);
    }
  }

  // 5. 入度缺口补足：只从同部门成员/部长中选择，形成部门内环评小组。
  //    一半目标（按 seed 轮换）补到 5，其余补到 4（技术文档：被评价人数在 4 和 5 间分布）。
  //    候选优先级：历史重复少 > 评价人出度低 > 同部门 > 跨部门 > seed 扰动。
  const eligibleTargets = input.participants.filter(
    (p) => p.role === 'MEMBER' || p.role === 'HEAD',
  );
  const avgOut = Math.max(
    1,
    Math.ceil((eligibleTargets.length * MIN_INDEGREE) / Math.max(1, eligibleTargets.length - 1)),
  );
  const maxOut = MAX_OUTDEGREE;

  // 轮换决定哪一半目标获得第 5 份（fifthCount 高者优先排除，实现跨期均衡）
  const fifthCount = new Map<string, number>();
  for (const h of input.history) {
    fifthCount.set(h.targetId, (fifthCount.get(h.targetId) ?? 0) + 1);
  }
  const extraHalf = new Set(
    shuffle(stableSort(eligibleTargets, (t) => t.userId), `${input.seed}:extra-half`)
      .sort((a, b) => (fifthCount.get(a.userId) ?? 0) - (fifthCount.get(b.userId) ?? 0))
      .slice(0, Math.floor(eligibleTargets.length / 2))
      .map((t) => t.userId),
  );

  for (const target of shuffle(stableSort(eligibleTargets, (t) => t.userId), `${input.seed}:fill-order`).sort((a, b) => (byDept.get(a.deptId)?.length ?? 0) - (byDept.get(b.deptId)?.length ?? 0))) {
    const goal = extraHalf.has(target.userId) ? MAX_INDEGREE : MIN_INDEGREE;
    while ((builder.indeg.get(target.userId) ?? 0) < goal) {
      const candidates = eligibleTargets
        .filter((c) => c.userId !== target.userId)
        .filter((c) => builder.canAdd(c.userId, target.userId, c.deptId !== target.deptId))
        .filter((c) => (builder.outdeg.get(c.userId) ?? 0) < maxOut);

      if (candidates.length === 0) break;

      // 评分排序：历史重复次数少者优先，出度低者优先，同部门优先，最后 seed 扰动
      const rng = createPrng(`${input.seed}:fill:${target.userId}:${builder.indeg.get(target.userId)}`);
      const seedScore = new Map(candidates.map((candidate) => [candidate.userId, rng()]));
      candidates.sort((a, b) => {
        if ((a.deptId === target.deptId) !== (b.deptId === target.deptId)) return a.deptId === target.deptId ? -1 : 1;
        const ha = builder.historyCount.get(key(a.userId, target.userId)) ?? 0;
        const hb = builder.historyCount.get(key(b.userId, target.userId)) ?? 0;
        if (ha !== hb) return ha - hb;
        const oa = builder.outdeg.get(a.userId) ?? 0;
        const ob = builder.outdeg.get(b.userId) ?? 0;
        // 先平衡出度保证可行性，再用 seed 打散同一出度候选，避免无历史时每月生成相同关系。
        if (oa !== ob) return oa - ob;
        const sa = seedScore.get(a.userId) ?? 0;
        const sb = seedScore.get(b.userId) ?? 0;
        return sa - sb;
      });

      const reviewer = candidates[0];
      const sameDept = reviewer.deptId === target.deptId;
      builder.add(
        reviewer.userId,
        target.userId,
        sameDept ? 'PEER_SAME_DEPT' : 'PEER_CROSS_DEPT',
        false,
      );
    }
  }

  // 统计与验证
  const indegrees: Record<string, number> = {};
  const outdegrees: Record<string, number> = {};
  for (const p of input.participants) {
    indegrees[p.userId] = builder.indeg.get(p.userId) ?? 0;
    outdegrees[p.userId] = builder.outdeg.get(p.userId) ?? 0;
  }

  // 被评价池：部长、普通成员；监管与外部人员不被评价
  const evaluated = input.participants.filter(
    (p) => p.role === 'MEMBER' || p.role === 'HEAD',
  );
  const shortfalls: Array<AssignmentShortfall & { reason: AssignmentShortfallReason }> = [];
  const deptSize = new Map<string, number>();
  for (const p of input.participants) deptSize.set(p.deptId, (deptSize.get(p.deptId) ?? 0) + 1);
  const label = (p: Participant) => `${p.displayName ? `${p.displayName}（${p.userId}）` : p.userId}·${p.deptId}`;

  /** 目标补不满时给出可能原因：整体容量不足、部门可评价人不足、部门仅本人或其他。 */
  const shortfallReason = (target: Participant, missing: number): AssignmentShortfallReason => {
    const others = eligibleTargets.filter((c) => c.userId !== target.userId);
    if (others.length === 0) return 'SINGLE_MEMBER_DEPARTMENT';
    if (others.every((c) => (builder.outdeg.get(c.userId) ?? 0) >= maxOut)) return 'REVIEWER_CAPACITY';
    if ((deptSize.get(target.deptId) ?? 1) <= 1) return 'SINGLE_MEMBER_DEPARTMENT';
    if (missing > 0 && others.filter((c) => builder.canAdd(c.userId, target.userId, c.deptId !== target.deptId)).length === 0) {
      return 'INSUFFICIENT_CANDIDATES';
    }
    return 'OTHER';
  };

  let feasible = diagnostics.length === 0;
  for (const p of evaluated) {
    const d = indegrees[p.userId] ?? 0;
    if (d < MIN_INDEGREE) {
      feasible = false;
      const missing = MIN_INDEGREE - d;
      const reason = shortfallReason(p, missing);
      diagnostics.push(`参与者 ${p.displayName ? `${p.displayName}（${p.userId}）` : p.userId}（${p.deptId}）入度为 ${d}，低于 ${MIN_INDEGREE}，还缺 ${missing} 份他评`);
      shortfalls.push({ targetId: p.userId, targetName: p.displayName, deptId: p.deptId, indegree: d, minIndegree: MIN_INDEGREE, missing, reason });
    } else if (d > MAX_INDEGREE) {
      feasible = false;
      diagnostics.push(`参与者 ${label(p)} 入度为 ${d}，高于 ${MAX_INDEGREE}`);
    }
  }

  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        participantIds: input.participants.map((p) => p.userId).sort(),
        participants: input.participants.map(p=>[p.userId,p.deptId,p.role]).sort((a,b)=>a[0].localeCompare(b[0])),
        manualEdges: (input.manualEdges??[]).map(e=>key(e.reviewerId,e.targetId)).sort(),
        historyKeys: input.history.map((h) => key(h.reviewerId, h.targetId)).sort(),
        avoidPairs: input.avoidPairs,
        seed: input.seed,
        algorithmVersion: input.algorithmVersion ?? ALGORITHM_VERSION,
      }),
    )
    .digest('hex')
    .slice(0, 32);

  return {
    feasible,
    diagnostics,
    shortfalls,
    edges: builder.edges,
    indegrees,
    outdegrees,
    seed: input.seed,
    algorithmVersion: input.algorithmVersion ?? ALGORITHM_VERSION,
    inputHash,
  };
}
