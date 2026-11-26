-- M1-005 核验、结果与运维（技术文档 5.4）

CREATE TABLE calibration_cases (
  id                  UUID PRIMARY KEY,
  cycle_id            UUID NOT NULL REFERENCES cycles (id),
  org_id              UUID NOT NULL REFERENCES organizations (id),
  review_revision_id  UUID NOT NULL REFERENCES review_revisions (id),
  reason_code         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  assignee_id         UUID REFERENCES users (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_calibration_case ON calibration_cases (review_revision_id, reason_code);

CREATE TABLE calibration_actions (
  id          UUID PRIMARY KEY,
  case_id     UUID NOT NULL REFERENCES calibration_cases (id),
  org_id      UUID NOT NULL REFERENCES organizations (id),
  actor_id    UUID NOT NULL REFERENCES users (id),
  action      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_calibration_actions_case ON calibration_actions (case_id, created_at);

CREATE TABLE result_builds (
  id               UUID PRIMARY KEY,
  cycle_id         UUID NOT NULL REFERENCES cycles (id),
  org_id           UUID NOT NULL REFERENCES organizations (id),
  target_id        UUID NOT NULL REFERENCES users (id),
  input_hash       TEXT NOT NULL,
  formula_version  TEXT NOT NULL,
  exact_score      NUMERIC(10, 4),
  dimension_json   JSONB,
  status           TEXT NOT NULL DEFAULT 'BUILT'
                   CHECK (status IN ('BUILT', 'STALE', 'APPROVED', 'PUBLISHED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_result_build_input ON result_builds (cycle_id, target_id, input_hash);

CREATE TABLE result_source_reviews (
  id                  UUID PRIMARY KEY,
  result_build_id     UUID NOT NULL REFERENCES result_builds (id) ON DELETE CASCADE,
  review_revision_id  UUID NOT NULL REFERENCES review_revisions (id)
);
CREATE UNIQUE INDEX uq_result_source ON result_source_reviews (result_build_id, review_revision_id);

CREATE TABLE result_feedback (
  id              UUID PRIMARY KEY,
  result_build_id UUID NOT NULL REFERENCES result_builds (id),
  org_id          UUID NOT NULL REFERENCES organizations (id),
  editor_id       UUID NOT NULL REFERENCES users (id),
  strengths       TEXT,
  improvements    TEXT,
  review_status   TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (review_status IN ('DRAFT', 'REVIEWED', 'REJECTED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE result_approvals (
  id              UUID PRIMARY KEY,
  result_build_id UUID NOT NULL REFERENCES result_builds (id),
  org_id          UUID NOT NULL REFERENCES organizations (id),
  approver_id     UUID NOT NULL REFERENCES users (id),
  decision        TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 绑定精确 build；输入改变则批准失效（RESULT_STALE），由服务层比对 input_hash 判定。

CREATE TABLE published_results (
  id                  UUID PRIMARY KEY,
  cycle_id            UUID NOT NULL REFERENCES cycles (id),
  org_id              UUID NOT NULL REFERENCES organizations (id),
  target_id           UUID NOT NULL REFERENCES users (id),
  publication_version INTEGER NOT NULL CHECK (publication_version > 0),
  result_build_id     UUID NOT NULL REFERENCES result_builds (id),
  payload_json        JSONB NOT NULL,
  published_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  supersedes_id       UUID REFERENCES published_results (id)
);
CREATE UNIQUE INDEX uq_published_result ON published_results (cycle_id, target_id, publication_version);
CREATE INDEX idx_published_results_target ON published_results (target_id, published_at DESC);

CREATE TABLE award_decisions (
  id              UUID PRIMARY KEY,
  cycle_id        UUID NOT NULL REFERENCES cycles (id),
  org_id          UUID NOT NULL REFERENCES organizations (id),
  target_id       UUID NOT NULL REFERENCES users (id),
  category        TEXT NOT NULL,
  decision        TEXT NOT NULL,
  reason          TEXT,
  result_version  INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feedback_requests (
  id              UUID PRIMARY KEY,
  publication_id  UUID NOT NULL REFERENCES published_results (id),
  org_id          UUID NOT NULL REFERENCES organizations (id),
  applicant_id    UUID NOT NULL REFERENCES users (id),
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'DONE')),
  handler_id      UUID REFERENCES users (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notification_outbox (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations (id),
  event_key     TEXT NOT NULL,
  recipient_id   UUID NOT NULL REFERENCES users (id),
  channel       TEXT NOT NULL,
  payload_json  JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'DEAD')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_outbox_event ON notification_outbox (event_key, recipient_id, channel);
CREATE INDEX idx_outbox_dispatch ON notification_outbox (status, next_retry_at);

CREATE TABLE scheduled_jobs (
  id               UUID PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organizations (id),
  job_type         TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  cycle_id         UUID REFERENCES cycles (id),
  due_at           TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  lease_until      TIMESTAMPTZ,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_scheduled_job ON scheduled_jobs (job_type, idempotency_key);

CREATE TABLE audit_events (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL,
  actor_id       UUID REFERENCES users (id),
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT,
  reason         TEXT,
  request_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_resource ON audit_events (resource_type, resource_id, created_at);
-- 追加写、禁止普通应用权限 UPDATE/DELETE：除非会话显式设置 audit.allow_mutation（迁移维护用）。
CREATE OR REPLACE FUNCTION audit_events_block_mutation() RETURNS trigger AS $$
BEGIN
  -- current_setting 未设置时返回 NULL，NULL <> 'on' 结果为 NULL（不触发），
  -- 必须用 coalesce 显式落到 'off'，否则未设置时守卫被跳过。
  IF coalesce(current_setting('audit.allow_mutation', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'audit_events 为追加写日志，禁止 %', TG_OP;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();

CREATE TABLE idempotency_records (
  id            UUID PRIMARY KEY,
  actor_id      UUID NOT NULL REFERENCES users (id),
  route         TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'IN_FLIGHT' CHECK (status IN ('IN_FLIGHT', 'COMPLETED')),
  response_json JSONB,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_idempotency ON idempotency_records (actor_id, route, key);
