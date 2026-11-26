-- M5 评优 / 反馈申诉 / 通知投递：补齐幂等约束（技术文档 §11 / §13）

-- 评优决定按「周期 + 被评人 + 类别」唯一：重复保存即覆盖，避免重复记录
CREATE UNIQUE INDEX IF NOT EXISTS uq_award_decision
  ON award_decisions (cycle_id, target_id, category);

-- 反馈申诉按「发布结果 + 申请人」唯一：同一人重复申请复用同一条
CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_request
  ON feedback_requests (publication_id, applicant_id);
