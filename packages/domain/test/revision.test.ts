import { describe, expect, it } from 'vitest';
import {
  checkRevisionSubmission,
  isRevisionRequested,
  revisionDueAt,
  REVISION_WINDOW_HOURS,
  type RevisionSubmissionContext,
} from '../src/calibration/revision.js';

const BASE: RevisionSubmissionContext = {
  latestAction: 'SUGGEST_REVISION',
  dueAt: null,
  now: new Date('2026-09-23T10:00:00Z'),
  actorId: 'reviewer-1',
  reviewerId: 'reviewer-1',
  targetId: 'target-1',
};

describe('修订请求判定', () => {
  it('只有 SUGGEST_REVISION / REQUEST_SUPPLEMENT 视为"等原评价人处理"', () => {
    expect(isRevisionRequested('SUGGEST_REVISION')).toBe(true);
    expect(isRevisionRequested('REQUEST_SUPPLEMENT')).toBe(true);
    expect(isRevisionRequested('CONFIRM')).toBe(false);
    expect(isRevisionRequested('VOID_REQUEST')).toBe(false);
    expect(isRevisionRequested('REVISION_SUBMITTED')).toBe(false);
    expect(isRevisionRequested(null)).toBe(false);
    expect(isRevisionRequested(undefined)).toBe(false);
  });

  it('修订截止时间 = 基准时间 + 窗口小时（默认 48h）', () => {
    const from = new Date('2026-09-23T10:00:00Z');
    expect(revisionDueAt(from).toISOString()).toBe('2026-09-25T10:00:00.000Z');
    expect(revisionDueAt(from, 1).toISOString()).toBe('2026-09-23T11:00:00.000Z');
    expect(REVISION_WINDOW_HOURS).toBe(48);
  });
});

describe('提交修订版的准入（PRD §9.1 更正须由原评价人形成修订版）', () => {
  it('原评价人 + 已提出更正 + 未过期 → 允许', () => {
    expect(checkRevisionSubmission(BASE)).toBeNull();
  });

  it('最新动作不是更正/补充 → REVISION_NOT_REQUESTED', () => {
    expect(checkRevisionSubmission({ ...BASE, latestAction: 'CONFIRM' })).toBe('REVISION_NOT_REQUESTED');
    expect(checkRevisionSubmission({ ...BASE, latestAction: null })).toBe('REVISION_NOT_REQUESTED');
  });

  it('本人（被评价人）提交 → SELF_CONFLICT', () => {
    expect(checkRevisionSubmission({ ...BASE, actorId: 'target-1' })).toBe('SELF_CONFLICT');
  });
  it('自评退回后只能由原自评作者提交修订',()=>{
    expect(checkRevisionSubmission({...BASE,kind:'SELF',actorId:'self',reviewerId:'self',targetId:'self',latestAction:'REQUEST_SUPPLEMENT'})).toBeNull();
    expect(checkRevisionSubmission({...BASE,kind:'SELF',actorId:'other',reviewerId:'self',targetId:'self'})).toBe('NOT_ORIGINAL_REVIEWER');
  });

  it('非原评分作者提交 → NOT_ORIGINAL_REVIEWER', () => {
    expect(checkRevisionSubmission({ ...BASE, actorId: 'someone-else' })).toBe('NOT_ORIGINAL_REVIEWER');
  });

  it('修订窗口过期 → REVISION_WINDOW_CLOSED', () => {
    expect(
      checkRevisionSubmission({ ...BASE, dueAt: '2026-09-23T09:00:00Z' }),
    ).toBe('REVISION_WINDOW_CLOSED');
  });

  it('窗口未过期或未设置时不做时间拦截', () => {
    expect(checkRevisionSubmission({ ...BASE, dueAt: '2026-09-23T12:00:00Z' })).toBeNull();
    expect(checkRevisionSubmission({ ...BASE, dueAt: null })).toBeNull();
    expect(checkRevisionSubmission({ ...BASE, dueAt: undefined })).toBeNull();
  });

  it('退回补充（REQUEST_SUPPLEMENT）同样允许原评价人提交修订版', () => {
    expect(checkRevisionSubmission({ ...BASE, latestAction: 'REQUEST_SUPPLEMENT' })).toBeNull();
  });

  it('无关人员即使窗口有效也会被拦下', () => {
    expect(
      checkRevisionSubmission({ ...BASE, actorId: 'other', dueAt: '2026-09-23T12:00:00Z' }),
    ).toBe('NOT_ORIGINAL_REVIEWER');
  });
});
