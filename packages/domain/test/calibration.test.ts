import { describe, expect, it } from 'vitest';
import {
  detectCalibrationTriggers,
  type CalibrationTriggerInput,
} from '../src/calibration/triggers.js';
import {
  checkCalibrationActor,
  statusAfterAction,
  isCalibrationAction,
  type CalibrationActorContext,
} from '../src/calibration/actions.js';

function triggerInput(over: Partial<CalibrationTriggerInput> = {}): CalibrationTriggerInput {
  return {
    scoreBp: 8500,
    itemScores: [],
    reviewerCyclePeerCount: 1,
    reviewerCycleHighCount: 0,
    ...over,
  };
}

describe('M4.2 核验触发判定（PRD §8.3）', () => {
  it('单项达到重点高分线时进入重点抽查，即使综合分低于该线',()=>{
    const triggers=detectCalibrationTriggers(triggerInput({scoreBp:8500,itemScores:[{itemId:'dimension',score:95}]}));
    expect(triggers.map(t=>t.reasonCode)).toContain('EXCELLENT');
  });
  it('综合分 ≥90 触发 HIGH_TOTAL', () => {
    const t = detectCalibrationTriggers(triggerInput({ scoreBp: 9000 }));
    expect(t.map((x) => x.reasonCode)).toEqual(['HIGH_TOTAL']);
    expect(t[0].detail).toContain('90.00');
  });

  it('综合分 ≥95 只触发 EXCELLENT，不再重复建 HIGH_TOTAL', () => {
    const t = detectCalibrationTriggers(triggerInput({ scoreBp: 9500 }));
    expect(t.map((x) => x.reasonCode)).toEqual(['EXCELLENT']);
  });

  it('89 分不触发（阈值边界，PRD A09）', () => {
    expect(detectCalibrationTriggers(triggerInput({ scoreBp: 8900 }))).toEqual([]);
  });

  it('任一指标 <60 触发 LOW_SCORE 并列出具体指标', () => {
    const t = detectCalibrationTriggers(
      triggerInput({
        scoreBp: 7000,
        itemScores: [
          { itemId: 'delivery', score: 59 },
          { itemId: 'growth', score: 80 },
          { itemId: 'team', score: 45 },
        ],
      }),
    );
    expect(t.map((x) => x.reasonCode)).toEqual(['LOW_SCORE']);
    expect(t[0].detail).toContain('delivery=59');
    expect(t[0].detail).toContain('team=45');
    expect(t[0].detail).not.toContain('growth');
  });

  it('指标 60 分整不触发（<60 才触发）', () => {
    const t = detectCalibrationTriggers(
      triggerInput({ scoreBp: 7000, itemScores: [{ itemId: 'x', score: 60 }] }),
    );
    expect(t).toEqual([]);
  });

  it('比例复核：3/4 超过 50% 触发 HIGH_RATIO，可与低分并存', () => {
    const t = detectCalibrationTriggers(
      triggerInput({
        scoreBp: 9100,
        itemScores: [{ itemId: 'x', score: 50 }],
        reviewerCyclePeerCount: 4,
        reviewerCycleHighCount: 3,
      }),
    );
    expect(t.map((x) => x.reasonCode).sort()).toEqual(['HIGH_RATIO', 'HIGH_TOTAL', 'LOW_SCORE']);
  });

  it('比例复核：2/4 正好 50% 不触发（PRD 示例）', () => {
    const t = detectCalibrationTriggers(
      triggerInput({ scoreBp: 8500, reviewerCyclePeerCount: 4, reviewerCycleHighCount: 2 }),
    );
    expect(t.map((x) => x.reasonCode)).not.toContain('HIGH_RATIO');
  });

  it('比例复核：有效他评不足 4 份不触发 HIGH_RATIO', () => {
    const t = detectCalibrationTriggers(
      triggerInput({ scoreBp: 8500, reviewerCyclePeerCount: 3, reviewerCycleHighCount: 3 }),
    );
    expect(t.map((x) => x.reasonCode)).not.toContain('HIGH_RATIO');
  });

  it('阈值可由 ruleset 覆盖', () => {
    const t = detectCalibrationTriggers(
      triggerInput({ scoreBp: 8000, thresholds: { highBp: 8000 } }),
    );
    expect(t.map((x) => x.reasonCode)).toEqual(['HIGH_TOTAL']);
  });
});

describe('M4.2 核验动作与利益冲突', () => {
  const base: CalibrationActorContext = {
    actorId: 'reviewer-1',
    targetId: 'target-1',
    reviewerId: 'reviewer-1',
    caseStatus: 'OPEN',
  };

  it('动作 → 状态映射：终态动作关闭核验项，退回/建议更正保持 OPEN', () => {
    expect(statusAfterAction('CONFIRM')).toBe('RESOLVED');
    expect(statusAfterAction('VOID_APPROVE')).toBe('RESOLVED');
    expect(statusAfterAction('VOID_REJECT')).toBe('RESOLVED');
    expect(statusAfterAction('DISMISS')).toBe('DISMISSED');
    expect(statusAfterAction('REQUEST_SUPPLEMENT')).toBe('OPEN');
    expect(statusAfterAction('SUGGEST_REVISION')).toBe('OPEN');
    expect(statusAfterAction('VOID_REQUEST')).toBe('OPEN');
  });

  it('终态核验项不可再操作', () => {
    expect(
      checkCalibrationActor({ ...base, actorId: 'third', reviewerId: 'other', caseStatus: 'RESOLVED' }, 'CONFIRM'),
    ).toBe('CASE_FINAL');
    expect(
      checkCalibrationActor({ ...base, actorId: 'third', reviewerId: 'other', caseStatus: 'DISMISSED' }, 'DISMISS'),
    ).toBe('CASE_FINAL');
  });

  it('本人不得处置与自己结果相关的核验项', () => {
    expect(
      checkCalibrationActor({ ...base, actorId: 'target-1', reviewerId: 'other' }, 'CONFIRM'),
    ).toBe('SELF_CONFLICT');
  });

  it('原评分作者不得处置自己的评分', () => {
    expect(checkCalibrationActor(base, 'CONFIRM')).toBe('AUTHOR_CONFLICT');
  });

  it('无关第三方可操作', () => {
    expect(checkCalibrationActor({ ...base, actorId: 'calibrator-9' }, 'CONFIRM')).toBeNull();
  });

  it('作废批准需与申请人不同', () => {
    const ctx: CalibrationActorContext = {
      actorId: 'calibrator-9',
      targetId: 'target-1',
      reviewerId: 'reviewer-1',
      caseStatus: 'OPEN',
      voidRequestedBy: 'calibrator-9',
    };
    expect(checkCalibrationActor(ctx, 'VOID_APPROVE')).toBe('SAME_APPROVER');
    expect(checkCalibrationActor(ctx, 'CONFIRM')).toBeNull();
    expect(
      checkCalibrationActor({ ...ctx, actorId: 'calibrator-10' }, 'VOID_APPROVE'),
    ).toBeNull();
  });

  it('动作名白名单校验', () => {
    expect(isCalibrationAction('CONFIRM')).toBe(true);
    expect(isCalibrationAction('DELETE')).toBe(false);
  });
});

describe('formal void approval precondition',()=>{
 it('rejects approval and rejection without a formal request',()=>{
   const ctx={actorId:'independent',reviewerId:'author',targetId:'target',caseStatus:'OPEN' as const,voidRequestedBy:null};
   expect(checkCalibrationActor(ctx,'VOID_APPROVE')).toBe('VOID_REQUEST_REQUIRED');
   expect(checkCalibrationActor(ctx,'VOID_REJECT')).toBe('VOID_REQUEST_REQUIRED');
 });
});
