CREATE TABLE feishu_prebinding_batches (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL REFERENCES organizations(id),
 tenant_key TEXT NOT NULL,
 app_id TEXT NOT NULL,
 created_by UUID NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPLIED')),
 visibility_json JSONB NOT NULL,
 submit_hash TEXT,
 applied_by UUID REFERENCES users(id),
 applied_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_result_json JSONB,
 CHECK(status<>'APPLIED' OR (submit_hash IS NOT NULL AND applied_by IS NOT NULL AND applied_at IS NOT NULL))
);
CREATE INDEX ix_prebinding_batches_org ON feishu_prebinding_batches(org_id,created_at DESC);
CREATE TABLE feishu_prebinding_items (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id UUID NOT NULL REFERENCES feishu_prebinding_batches(id),
 org_id UUID NOT NULL REFERENCES organizations(id),
 user_id UUID NOT NULL REFERENCES users(id),
 member_name TEXT NOT NULL,
 department_name TEXT NOT NULL,
 match_status TEXT NOT NULL,
 candidates_json JSONB NOT NULL,
 bindings_json JSONB NOT NULL,
 verified_open_id TEXT,
 verification_evidence TEXT,
 verified_by UUID REFERENCES users(id),
 verified_at TIMESTAMPTZ,
 UNIQUE(batch_id,user_id),
 CHECK((verified_open_id IS NULL AND verification_evidence IS NULL AND verified_by IS NULL AND verified_at IS NULL)
   OR (verified_open_id IS NOT NULL AND length(trim(verification_evidence)) BETWEEN 1 AND 500 AND verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX ix_prebinding_items_batch ON feishu_prebinding_items(batch_id);
