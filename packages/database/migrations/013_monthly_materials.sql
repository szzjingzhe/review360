-- Keep the original monthly report/version IDs and evaluation foreign keys intact.
-- monthly_reports remains the per-user/per-cycle package and its active_version_id
-- continues to point ONLY to the primary monthly report.
ALTER TABLE report_versions ADD COLUMN version_note TEXT NOT NULL DEFAULT '';
ALTER TABLE report_versions ADD COLUMN uploaded_by UUID REFERENCES users(id);

CREATE TABLE monthly_materials (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES monthly_reports(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  material_type TEXT NOT NULL CHECK (material_type IN
    ('MONTHLY_REPORT','PROJECT','COMPETITION','WORK_PROOF','PRESENTATION','OTHER')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_material_primary ON monthly_materials(report_id)
  WHERE material_type = 'MONTHLY_REPORT';
CREATE INDEX ix_material_package ON monthly_materials(report_id);

INSERT INTO monthly_materials(id,report_id,org_id,material_type,name,created_at)
SELECT mr.id,mr.id,mr.org_id,'MONTHLY_REPORT',left(coalesce(v.original_name,'月度工作报告'),200),mr.created_at
FROM monthly_reports mr
JOIN LATERAL (SELECT original_name FROM report_versions WHERE report_id=mr.id
  ORDER BY (id=mr.active_version_id) DESC, version DESC LIMIT 1) v ON true
ON CONFLICT DO NOTHING;

-- Supplementary versions are separate, so existing dashboards/result builders
-- querying report_versions cannot mistake a supplement for the primary report.
CREATE TABLE monthly_material_versions (
  id UUID PRIMARY KEY,
  material_id UUID NOT NULL REFERENCES monthly_materials(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL CHECK (version > 0),
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  version_note TEXT NOT NULL DEFAULT '' CHECK (length(version_note) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(material_id,version)
);
CREATE TABLE review_material_snapshots (
  revision_id UUID PRIMARY KEY REFERENCES review_revisions(id),
  report_id UUID NOT NULL REFERENCES monthly_reports(id),
  versions_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE material_submission_batches (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  cycle_id UUID NOT NULL REFERENCES cycles(id),
  payload_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
