import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { OrgController } from '../src/org/org.controller';

const userId = '11111111-1111-4111-8111-111111111111';
const actor = {
  sessionIdHash: 'session-hash', userId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333', displayName: '权限管理员',
};

function makeController() {
  const db = { query: vi.fn(), connect: vi.fn() };
  const policy = { assertCapability: vi.fn() };
  return new OrgController(db as any, policy as any);
}

describe('角色权限请求校验', () => {
  it.each(['', '   ', 'x'.repeat(501)])('拒绝空白或超长的授权原因：%p', async (reason) => {
    const controller = makeController();
    let caught: unknown;
    try {
      await controller.createGrant(actor, { user_id: userId, capability: 'cycle.manage', reason });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toEqual({ code: 'FIELD_INVALID', field: 'reason' });
  });

  it('拒绝未知权限且不会打开数据库事务', async () => {
    const controller = makeController();
    let caught: unknown;
    try {
      await controller.createGrant(actor, { user_id: userId, capability: 'unknown.permission', reason: '审批依据' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toEqual({ code: 'FIELD_INVALID', field: 'capability' });
  });
});
