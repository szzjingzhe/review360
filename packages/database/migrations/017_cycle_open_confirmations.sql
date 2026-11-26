-- Explicit approval of a preview is required before scheduled opening.
CREATE TABLE cycle_open_confirmations (
 cycle_id UUID PRIMARY KEY REFERENCES cycles(id) ON DELETE CASCADE,
 org_id UUID NOT NULL REFERENCES organizations(id),
 run_id UUID NOT NULL REFERENCES assignment_runs(id),
 confirmed_by UUID NOT NULL REFERENCES users(id),
 confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
