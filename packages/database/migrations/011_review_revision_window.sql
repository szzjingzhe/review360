-- M10 更正修订窗口（PRD §8.1「管理员退回的评分需有单独的修订截止时间与版本记录」、§9.1「更正应由原评价人形成修订版」）
--
-- 背景：calibration_cases 按 (review_revision_id, reason_code) 唯一；核验动作
-- SUGGEST_REVISION / REQUEST_SUPPLEMENT 之后 case 保持 OPEN，等待**原评价人**提交修订版。
-- 修订通常发生在校准期（即周期 close_at 之后），所以它不能受周期截止约束，
-- 而需要自己的截止时间——即本列。

ALTER TABLE calibration_cases
  ADD COLUMN revision_due_at TIMESTAMPTZ;

COMMENT ON COLUMN calibration_cases.revision_due_at IS
  '要求原评价人提交修订版的截止时间（仅 SUGGEST_REVISION / REQUEST_SUPPLEMENT 时设置）';

CREATE INDEX idx_calibration_cases_revision_due
  ON calibration_cases (revision_due_at)
  WHERE revision_due_at IS NOT NULL;
