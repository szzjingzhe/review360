-- Incremental projections only. Published results and review revisions are immutable sources.
CREATE TABLE business_administrators (
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  PRIMARY KEY(org_id,user_id)
);
-- Dynamic HEAD membership respects appointment expiry and suspended accounts.
-- Anonymous reviewer identities are deliberately NOT in this capability list.
CREATE VIEW effective_capability_grants AS
SELECT org_id,user_id,capability,scope_type,scope_id,valid_from,valid_to,revoked_at FROM capability_grants
UNION ALL
SELECT u.org_id,u.id,cap.capability,'ORG'::text,NULL::uuid,
 '-infinity'::timestamptz,NULL::timestamptz,NULL::timestamptz
FROM users u CROSS JOIN unnest(ARRAY['workspace.oversight','management.access','cycle.manage',
 'assignment.manage','progress.read','reminder.send','calibration.resolve','result.read_published',
 'result.read_aggregate','result.confirm','result.publish','feedback.manage','report.view',
 'org.manage','audit.export','growth.manage']) AS cap(capability)
WHERE u.status='ACTIVE' AND (EXISTS(SELECT 1 FROM business_administrators a WHERE a.org_id=u.org_id AND a.user_id=u.id)
 OR EXISTS(SELECT 1 FROM appointments a WHERE a.org_id=u.org_id AND a.user_id=u.id AND a.role='HEAD'
 AND a.valid_from<=CURRENT_DATE AND (a.valid_to IS NULL OR a.valid_to>CURRENT_DATE)));

CREATE TABLE growth_analyses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 publication_id uuid NOT NULL REFERENCES published_results(id),
 generation_no integer NOT NULL CHECK(generation_no>0),
 status text NOT NULL CHECK(status IN ('GENERATING','DRAFT','FAILED','CONFIRMED')),
 model text NOT NULL,
 raw_text text,
 draft_json jsonb,
 confirmed_json jsonb,
 failure_code text,
 generated_by uuid NOT NULL REFERENCES users(id),
 confirmed_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 UNIQUE(publication_id,generation_no),
 CHECK((status='CONFIRMED')=(confirmed_json IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_growth_generation_running ON growth_analyses(publication_id) WHERE status='GENERATING';
CREATE INDEX idx_growth_publication ON growth_analyses(publication_id,generation_no DESC);
