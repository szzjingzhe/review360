-- 030: 自评窗口（自评+材料上传）与他评窗口分离
-- 背景：原流程只有 open_at / close_at 一个窗口，自评和同行评价同时在开放，
--       导致同行可以先于成员提交评价，进而把成员的成果包锁死（REPORT_LOCKED）。
-- 本迁移新增 self_close_at：自评阶段结束时间。
--   [open_at, self_close_at)  → 仅本人自评 + 上传材料
--   [self_close_at, close_at) → 仅同行/上级评价
-- 字段为 NULL 时退回旧行为（单窗口），保证历史周期不受影响。

ALTER TABLE cycles ADD COLUMN IF NOT EXISTS self_close_at TIMESTAMPTZ;

-- 时间顺序：开始 < 自评截止 <= 评价截止
ALTER TABLE cycles DROP CONSTRAINT IF EXISTS ck_cycle_self_order;
ALTER TABLE cycles ADD CONSTRAINT ck_cycle_self_order CHECK (
  self_close_at IS NULL
  OR (
    (open_at IS NULL OR open_at < self_close_at)
    AND (close_at IS NULL OR self_close_at <= close_at)
  )
);
