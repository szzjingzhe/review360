-- 032: 云文档链接材料 + 手动锁定可解锁（最多锁定 2 次）

-- 1. 材料版本支持外链：object_key 可空，external_url 有值时表示该版本是云文档链接
ALTER TABLE monthly_material_versions ALTER COLUMN object_key DROP NOT NULL;
ALTER TABLE monthly_material_versions ADD COLUMN IF NOT EXISTS external_url text;

ALTER TABLE monthly_material_versions DROP CONSTRAINT IF EXISTS monthly_material_versions_source_check;
ALTER TABLE monthly_material_versions ADD CONSTRAINT monthly_material_versions_source_check
  CHECK (object_key IS NOT NULL OR external_url IS NOT NULL);

ALTER TABLE monthly_material_versions DROP CONSTRAINT IF EXISTS monthly_material_versions_external_url_check;
ALTER TABLE monthly_material_versions ADD CONSTRAINT monthly_material_versions_external_url_check
  CHECK (external_url IS NULL OR (length(external_url) BETWEEN 8 AND 1000 AND external_url LIKE 'https://%'));

-- 2. 手动锁定与自动冻结分开：locked_at 由自评提交自动冻结，manual_locked_at 是用户主动锁定
ALTER TABLE monthly_reports ADD COLUMN IF NOT EXISTS manual_locked_at timestamptz;
ALTER TABLE monthly_reports ADD COLUMN IF NOT EXISTS lock_count integer NOT NULL DEFAULT 0;
ALTER TABLE monthly_reports ADD COLUMN IF NOT EXISTS unlocked_at timestamptz;

ALTER TABLE monthly_reports DROP CONSTRAINT IF EXISTS monthly_reports_lock_count_check;
ALTER TABLE monthly_reports ADD CONSTRAINT monthly_reports_lock_count_check
  CHECK (lock_count >= 0 AND lock_count <= 2);
