-- 月评公告：管理员按周期维护一份公告，学员在个人端右上角查看。
-- 公告正文可为空，此时前端展示由周期时间节点自动生成的默认文案。
CREATE TABLE IF NOT EXISTS announcements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  cycle_id     uuid REFERENCES cycles(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  is_published boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcements_title_check CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT announcements_body_check CHECK (char_length(body) <= 4000)
);

-- 同一组织同一周期只保留一条公告；org 级（cycle_id 为空）公告可多条。
CREATE UNIQUE INDEX IF NOT EXISTS uq_announcement_per_cycle
  ON announcements (org_id, cycle_id) WHERE cycle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_announcements_org ON announcements (org_id, updated_at DESC);
