import { describe, expect, it } from 'vitest';
import { DEPARTMENTS } from '../../../packages/database/src/seed';
import { PolicyService } from '../src/authz/policy.service';

/** 当前组织：原 HRBP 人员已归入产品部普通成员。 */
describe('种子名单（PRD 3.1）', () => {
  it('共 5 个部门，44 人，5 位部长', () => {
    expect(DEPARTMENTS).toHaveLength(5);
    const total = DEPARTMENTS.reduce((n, d) => n + d.members.length + 1, 0);
    expect(total).toBe(44);
    expect(DEPARTMENTS.filter((d) => d.head).length).toBe(5);
  });

  it('调整后各部门含部长人数为 9/9/9/9/8', () => {
    const counts = DEPARTMENTS.map((d) => d.members.length + 1);
    expect(counts.sort((a, b) => a - b).join(',')).toBe('8,9,9,9,9');
  });

  it('44 个姓名无重复、无空字符串', () => {
    const names = DEPARTMENTS.flatMap((d) => [d.head, ...d.members]);
    expect(new Set(names).size).toBe(44);
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  it('产品部含 8 名普通成员，其中包括原 HRBP 人员', () => {
    const pd = DEPARTMENTS.find((d) => d.code === 'PD');
    expect(pd?.members).toHaveLength(8);
    expect(pd?.members).toEqual(expect.arrayContaining(['示例成员43', '示例成员35']));
  });
});

/** 技术文档 4.3 / PRD 4：target 为当前用户时一律拒绝读取原始他评 */
describe('本人隔离策略', () => {
  const policy = new PolicyService(null as never);

  it('本人读取自己的原始他评被拒绝（SELF_AUDIT_FORBIDDEN）', () => {
    const me = 'user-a';
    try {
      policy.assertNotSelfTarget(me, me);
      expect.unreachable('应当抛出 ForbiddenException');
    } catch (e) {
      const code = (e as { response?: { code?: string } }).response?.code;
      expect(code).toBe('SELF_AUDIT_FORBIDDEN');
      expect((e as { status?: number }).status).toBe(403);
    }
  });

  it('他人对象不受影响', () => {
    expect(() => policy.assertNotSelfTarget('user-a', 'user-b')).not.toThrow();
  });
});
