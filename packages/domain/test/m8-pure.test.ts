import { describe, it, expect } from 'vitest';
import type { DbClient } from '../src/db.js';
import { openRereview, resolveRereview } from '../src/feedback.js';

/**
 * 内存版 DbClient（仅响应 feedback 二次申诉涉及的两类 SQL），用于纯单测状态机守卫，
 * 不引入 pg 依赖。行以 id 为键存储在 Map 中。
 */
function makeDb(seed: Record<string, any>[]): DbClient {
  const store = new Map<string, Record<string, any>>();
  for (const r of seed) store.set(r.id, { ...r });
  return {
    async query(sql: string, params?: unknown[]) {
      const id = params?.[0] as string;
      // openRereview 读取申请人/状态
      if (sql.includes('applicant_id, status') && sql.includes('FROM feedback_requests')) {
        const row = store.get(id);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      // resolveRereview 失败分支回读状态
      if (sql.includes('SELECT status FROM feedback_requests')) {
        const row = store.get(id);
        return { rows: row ? [{ status: row.status }] : [], rowCount: row ? 1 : 0 };
      }
      // openRereview 写入 REREVIEW_PENDING
      if (sql.includes("status = 'REREVIEW_PENDING'") && sql.includes('rereview_reason')) {
        const row = store.get(id);
        if (!row) return { rows: [], rowCount: 0 };
        row.status = 'REREVIEW_PENDING';
        row.rereview_reason = params?.[1];
        row.rereview_opened_at = params?.[2];
        return { rows: [{ id, status: row.status }], rowCount: 1 };
      }
      // resolveRereview 写入二审终态（仅当当前为 REREVIEW_PENDING）
      if (sql.includes('rereview_handler_id') && sql.includes("status = 'REREVIEW_PENDING'") && sql.includes('RETURNING')) {
        const row = store.get(id);
        if (!row || row.status !== 'REREVIEW_PENDING') return { rows: [], rowCount: 0 };
        row.status = params?.[1] as string;
        row.rereview_handler_id = params?.[2];
        return { rows: [{ id, status: row.status }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('M8 二次申诉状态机（domain 纯单测）', () => {
  it('openRereview 仅允许一级结案（DONE/REJECTED）发起', async () => {
    const db = makeDb([{ id: 'fb1', applicant_id: 'u1', status: 'DONE' }]);
    const rr = await openRereview(db, { id: 'fb1', applicantId: 'u1', reason: '再申诉' });
    expect(rr.status).toBe('REREVIEW_PENDING');

    const db2 = makeDb([{ id: 'fb2', applicant_id: 'u1', status: 'PENDING' }]);
    await expect(openRereview(db2, { id: 'fb2', applicantId: 'u1', reason: 'r' }))
      .rejects.toThrow(/REREVIEW_NOT_ALLOWED/);

    const db3 = makeDb([{ id: 'fb3', applicant_id: 'u1', status: 'REREVIEW_DONE' }]);
    await expect(openRereview(db3, { id: 'fb3', applicantId: 'u1', reason: 'r' }))
      .rejects.toThrow(/REREVIEW_NOT_ALLOWED/);
  });

  it('openRereview 仅本人可发起', async () => {
    const db = makeDb([{ id: 'fb1', applicant_id: 'u1', status: 'DONE' }]);
    await expect(openRereview(db, { id: 'fb1', applicantId: 'intruder', reason: '冒名' }))
      .rejects.toThrow('NOT_OWN_RESULT');
  });

  it('resolveRereview 推进二级终态，且终态不可再申诉/二审', async () => {
    const db = makeDb([{ id: 'fb1', applicant_id: 'u1', status: 'REREVIEW_PENDING' }]);
    const done = await resolveRereview(db, { id: 'fb1', handlerId: 'h1', decision: 'APPROVED' });
    expect(done.status).toBe('REREVIEW_DONE');

    const db2 = makeDb([{ id: 'fb1', applicant_id: 'u1', status: 'REREVIEW_DONE' }]);
    await expect(resolveRereview(db2, { id: 'fb1', handlerId: 'h1', decision: 'APPROVED' }))
      .rejects.toThrow(/REREVIEW_NOT_PENDING/);
    await expect(openRereview(db2, { id: 'fb1', applicantId: 'u1', reason: 'r' }))
      .rejects.toThrow(/REREVIEW_NOT_ALLOWED/);
  });

  it('resolveRereview REJECTED 映射为 REREVIEW_REJECTED', async () => {
    const db = makeDb([{ id: 'fb1', applicant_id: 'u1', status: 'REREVIEW_PENDING' }]);
    const out = await resolveRereview(db, { id: 'fb1', handlerId: 'h1', decision: 'REJECTED' });
    expect(out.status).toBe('REREVIEW_REJECTED');
  });
});
