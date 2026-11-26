-- 036: 解除「每月只能一期」，改为「同时只能一期进行中」
--
-- 原约束 uq_cycle_month (org_id, month) 使得同一月份永远只能存在一条周期记录，
-- 已发布的月份无法再发起第二期。
-- 新口径：
--   1. 同一月份可以有多期（用 title 区分期次，如「2026-11 月度环评（第2期）」）；
--   2. 同一组织在同一时刻只允许一期处于进行中状态，由部分唯一索引在数据库层强保证。
--
-- 进行中 = PENDING_OPEN / REVIEWING / PAUSED / CALIBRATING / PARTIALLY_PUBLISHED
-- 不占用互斥的状态：DRAFT（草稿可提前准备多期）、PUBLISHED、ARCHIVED、CANCELLED

DROP INDEX IF EXISTS uq_cycle_month;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cycle_single_active
  ON cycles (org_id)
  WHERE status IN ('PENDING_OPEN', 'REVIEWING', 'PAUSED', 'CALIBRATING', 'PARTIALLY_PUBLISHED');

-- 同月多期后列表需要稳定顺序：月份倒序 → 创建时间倒序
CREATE INDEX IF NOT EXISTS ix_cycles_org_month_created
  ON cycles (org_id, month DESC, created_at DESC);
