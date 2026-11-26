/**
 * 最小数据库客户端结构类型。
 *
 * ops 模块（calibration/scan.ts、results/ops.ts）只需要参数化 query 能力，
 * 用结构化类型代替 `import type { PoolClient } from 'pg'`，
 * 保持 @360/domain 零运行时依赖；pg 的 Pool/PoolClient 结构兼容此接口。
 */
export interface DbClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}
