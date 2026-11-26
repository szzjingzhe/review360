import { describe, expect, it } from 'vitest';
import { feedbackDeadline, isWithinFeedbackWindow } from '../src/feedback.js';

describe('M5 反馈窗口（发布后 3 个工作日，跳过周末）', () => {
  it('窗口内：发布当天（周一）3 个工作日内可发起', () => {
    // 2026-09-21 是周一
    const published = new Date('2026-09-21T10:00:00');
    const deadline = feedbackDeadline(published, 3);
    // 周一+3 工作日 = 周四 2026-09-24
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-09-24');
    expect(isWithinFeedbackWindow(published, new Date('2026-09-23T23:59:00'))).toBe(true);
  });

  it('窗口跨周末：周五发布 → 截止下周三（周六日不计入）', () => {
    const published = new Date('2026-09-25T10:00:00'); // 周五
    const deadline = feedbackDeadline(published, 3);
    // 周五 + 周一 + 周二 + 周三 = 下周三 2026-09-30
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-09-30');
    // 周日仍在窗口内
    expect(isWithinFeedbackWindow(published, new Date('2026-09-27T12:00:00'))).toBe(true);
    // 下周四已过期
    expect(isWithinFeedbackWindow(published, new Date('2026-10-01T00:00:00'))).toBe(false);
  });

  it('边界：恰在截止日当天仍可发起', () => {
    const published = new Date('2026-09-21T10:00:00');
    const deadline = feedbackDeadline(published, 3);
    expect(isWithinFeedbackWindow(published, deadline)).toBe(true);
    expect(isWithinFeedbackWindow(published, new Date(deadline.getTime() + 1))).toBe(false);
  });
});
