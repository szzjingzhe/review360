-- Draft manual relations, separate from live assignments. No existing rows changed.
CREATE TABLE assignment_manual_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  cycle_id UUID NOT NULL REFERENCES cycles(id),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  target_id UUID NOT NULL REFERENCES users(id),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reviewer_id <> target_id),
  UNIQUE(cycle_id,reviewer_id,target_id),
  FOREIGN KEY(cycle_id,reviewer_id) REFERENCES cycle_participants(cycle_id,user_id),
  FOREIGN KEY(cycle_id,target_id) REFERENCES cycle_participants(cycle_id,user_id)
);
CREATE INDEX idx_assignment_manual_cycle ON assignment_manual_edges(org_id,cycle_id);
