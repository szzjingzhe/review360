-- M6 月报生成（技术文档 §12 月报/组织洞察）
-- 月报由已发布结果实时聚合并落快照，按 (cycle_id, scope) 幂等生成。
-- 注意：monthly_reports 表名已被 004（报告上传版本模型，被 collectBuildInputs 关联 report_versions 使用）占用，
-- 为避免冲突并保护 M4 已验证逻辑，本迁移新建独立表 result_monthly_reports。
CREATE TABLE result_monthly_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      UUID NOT NULL REFERENCES cycles (id),
  org_id        UUID NOT NULL REFERENCES organizations (id),
  scope         TEXT NOT NULL DEFAULT 'ORG'
                CHECK (scope IN ('ORG', 'DEPT')),
  payload_json  JSONB NOT NULL,
  generated_by  UUID REFERENCES users (id),
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_result_monthly_report ON result_monthly_reports (cycle_id, scope);
CREATE INDEX idx_result_monthly_reports_org ON result_monthly_reports (org_id, generated_at DESC);
