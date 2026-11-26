-- Admission requests do not create members or sessions. Approval binds an existing user.
CREATE TABLE feishu_admission_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL DEFAULT 'FEISHU' CHECK(provider='FEISHU'),
  tenant_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','REVOKED')),
  approved_user_id UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  review_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  receipt_hash TEXT NOT NULL,
  receipt_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider,tenant_key,external_id),
  CHECK(status<>'APPROVED' OR approved_user_id IS NOT NULL)
);
CREATE INDEX ix_feishu_admission_queue ON feishu_admission_requests(org_id,status,created_at);
CREATE UNIQUE INDEX uq_feishu_admission_receipt ON feishu_admission_requests(receipt_hash);
-- A member has at most one approved identity per provider/tenant. Migration fails
-- on pre-existing conflicts instead of deleting or silently choosing an identity.
CREATE UNIQUE INDEX uq_approved_external_user ON external_identities(user_id,provider,tenant_key) WHERE approved;
