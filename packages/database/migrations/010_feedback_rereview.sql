-- M8 二次申诉评审（技术文档 §13 状态机扩展）

-- 状态约束扩展：新增二级申诉态
ALTER TABLE feedback_requests
  DROP CONSTRAINT IF EXISTS feedback_requests_status_check;

ALTER TABLE feedback_requests
  ADD CONSTRAINT feedback_requests_status_check
  CHECK (status IN (
    'PENDING', 'APPROVED', 'REJECTED', 'DONE',
    'REREVIEW_PENDING', 'REREVIEW_DONE', 'REREVIEW_REJECTED'
  ));

-- 二次申诉字段：申诉理由、二审处理人、发起时间
ALTER TABLE feedback_requests
  ADD COLUMN IF NOT EXISTS rereview_reason       TEXT,
  ADD COLUMN IF NOT EXISTS rereview_handler_id   UUID REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS rereview_opened_at    TIMESTAMPTZ;
