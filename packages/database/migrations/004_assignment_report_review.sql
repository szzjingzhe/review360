-- M1-004 分配、月报与评分（技术文档 5.3）

CREATE TABLE assignment_runs (
  id                  UUID PRIMARY KEY,
  cycle_id            UUID NOT NULL REFERENCES cycles (id),
  org_id              UUID NOT NULL REFERENCES organizations (id),
  version             INTEGER NOT NULL,
  seed                INTEGER NOT NULL,
  algorithm_version   TEXT NOT NULL,
  input_hash          TEXT NOT NULL,
  cost                INTEGER,
  diagnostics         JSONB,
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'LOCKED', 'SUPERSEDED')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_assignment_run_version ON assignment_runs (cycle_id, version);

CREATE TABLE assignments (
  id            UUID PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES assignment_runs (id),
  cycle_id      UUID NOT NULL REFERENCES cycles (id),
  org_id        UUID NOT NULL REFERENCES organizations (id),
  reviewer_id   UUID NOT NULL REFERENCES users (id),
  target_id     UUID NOT NULL REFERENCES users (id),
  source_type   TEXT NOT NULL
                CHECK (source_type IN ('HEAD', 'HRPB', 'PEER', 'SUPERVISOR', 'UPWARD')),
  is_fixed      BOOLEAN NOT NULL DEFAULT FALSE,
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'CANCELLED', 'REPLACED')),
  replaces_id   UUID REFERENCES assignments (id),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE assignments ADD CONSTRAINT no_peer_self CHECK (reviewer_id <> target_id);
CREATE UNIQUE INDEX uq_active_assignment
  ON assignments (cycle_id, reviewer_id, target_id) WHERE status <> 'CANCELLED';
CREATE INDEX idx_assignments_target ON assignments (cycle_id, target_id, status);
CREATE INDEX idx_assignments_reviewer ON assignments (cycle_id, reviewer_id, status);

CREATE TABLE monthly_reports (
  id                  UUID PRIMARY KEY,
  cycle_id            UUID NOT NULL REFERENCES cycles (id),
  org_id              UUID NOT NULL REFERENCES organizations (id),
  user_id             UUID NOT NULL REFERENCES users (id),
  active_version_id   UUID,
  locked_at           TIMESTAMPTZ,
  row_version         INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_report_per_cycle ON monthly_reports (cycle_id, user_id);

CREATE TABLE report_versions (
  id              UUID PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations (id),
  report_id       UUID NOT NULL REFERENCES monthly_reports (id),
  version         INTEGER NOT NULL CHECK (version > 0),
  object_key      TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime            TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  scan_status     TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (scan_status IN ('PENDING', 'PASSED', 'FAILED')),
  preview_status  TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (preview_status IN ('PENDING', 'READY', 'FAILED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_report_version ON report_versions (report_id, version);
CREATE UNIQUE INDEX uq_report_object_key ON report_versions (object_key);
ALTER TABLE monthly_reports
  ADD CONSTRAINT fk_report_active_version
  FOREIGN KEY (active_version_id) REFERENCES report_versions (id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE upload_sessions (
  id              UUID PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organizations (id),
  owner_id        UUID NOT NULL REFERENCES users (id),
  report_id       UUID REFERENCES monthly_reports (id),
  temporary_key   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN', 'COMPLETED', 'EXPIRED', 'ABORTED')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_upload_temporary_key ON upload_sessions (temporary_key);

CREATE TABLE review_drafts (
  id                 UUID PRIMARY KEY,
  cycle_id           UUID NOT NULL REFERENCES cycles (id),
  org_id             UUID NOT NULL REFERENCES organizations (id),
  reviewer_id        UUID NOT NULL REFERENCES users (id),
  target_id          UUID NOT NULL REFERENCES users (id),
  kind               TEXT NOT NULL CHECK (kind IN ('SELF', 'PEER')),
  data_json          JSONB NOT NULL DEFAULT '{}',
  report_version_id  UUID REFERENCES report_versions (id),
  row_version        INTEGER NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 每个有效评分身份一份当前草稿。
CREATE UNIQUE INDEX uq_review_draft ON review_drafts (cycle_id, reviewer_id, target_id, kind);

CREATE TABLE reviews (
  id                  UUID PRIMARY KEY,
  cycle_id            UUID NOT NULL REFERENCES cycles (id),
  org_id              UUID NOT NULL REFERENCES organizations (id),
  assignment_id       UUID REFERENCES assignments (id),
  reviewer_id         UUID NOT NULL REFERENCES users (id),
  target_id           UUID NOT NULL REFERENCES users (id),
  kind                TEXT NOT NULL CHECK (kind IN ('SELF', 'PEER')),
  current_revision_id UUID,
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'SUBMITTED', 'WITHDRAWN')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 他评绑定唯一任务；自评周期+本人唯一。SELF 时 reviewer = target。
CREATE UNIQUE INDEX uq_review_assignment ON reviews (assignment_id) WHERE assignment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_review_self ON reviews (cycle_id, target_id) WHERE kind = 'SELF';
ALTER TABLE reviews ADD CONSTRAINT ck_review_self_pair
  CHECK ((kind = 'SELF' AND reviewer_id = target_id AND assignment_id IS NULL)
      OR (kind = 'PEER' AND reviewer_id <> target_id AND assignment_id IS NOT NULL));

CREATE TABLE review_revisions (
  id                 UUID PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organizations (id),
  review_id          UUID NOT NULL REFERENCES reviews (id),
  revision_no        INTEGER NOT NULL CHECK (revision_no > 0),
  report_version_id  UUID REFERENCES report_versions (id),
  template_id        UUID REFERENCES template_versions (id),
  score_bp           INTEGER CHECK (score_bp BETWEEN 0 AND 10000),
  overall_reason     TEXT,
  comment            TEXT,
  next_plan          TEXT,
  read_confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_review_revision ON review_revisions (review_id, revision_no);
ALTER TABLE review_revisions
  ADD CONSTRAINT ck_revision_template_immutable
  CHECK (revision_no = 1 OR template_id IS NOT NULL);
ALTER TABLE reviews
  ADD CONSTRAINT fk_review_current_revision
  FOREIGN KEY (current_revision_id) REFERENCES review_revisions (id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE review_item_scores (
  id           UUID PRIMARY KEY,
  revision_id  UUID NOT NULL REFERENCES review_revisions (id) ON DELETE CASCADE,
  org_id       UUID NOT NULL REFERENCES organizations (id),
  item_id      UUID NOT NULL REFERENCES template_items (id),
  score        INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reason       TEXT
);
CREATE UNIQUE INDEX uq_item_score ON review_item_scores (revision_id, item_id);

CREATE TABLE reviewer_cycle_stats (
  id                UUID PRIMARY KEY,
  cycle_id          UUID NOT NULL REFERENCES cycles (id),
  org_id            UUID NOT NULL REFERENCES organizations (id),
  reviewer_id       UUID NOT NULL REFERENCES users (id),
  effective_count   INTEGER NOT NULL DEFAULT 0,
  high_count        INTEGER NOT NULL DEFAULT 0,
  row_version       INTEGER NOT NULL DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_reviewer_stats ON reviewer_cycle_stats (cycle_id, reviewer_id);

CREATE TABLE reviewer_statements (
  id                UUID PRIMARY KEY,
  cycle_id          UUID NOT NULL REFERENCES cycles (id),
  org_id            UUID NOT NULL REFERENCES organizations (id),
  reviewer_id       UUID NOT NULL REFERENCES users (id),
  version           INTEGER NOT NULL CHECK (version > 0),
  statement         TEXT NOT NULL,
  high_count        INTEGER NOT NULL,
  effective_count   INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_reviewer_statement ON reviewer_statements (cycle_id, reviewer_id, version);
