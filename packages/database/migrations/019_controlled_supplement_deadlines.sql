-- Existing assignments remain unchanged and continue to use the cycle deadline.
ALTER TABLE assignments ADD COLUMN supplement_due_at TIMESTAMPTZ;
ALTER TABLE assignments ADD COLUMN supplement_authorized_by UUID REFERENCES users(id);
ALTER TABLE assignments ADD CONSTRAINT ck_assignment_supplement_authorization CHECK (
  (supplement_due_at IS NULL AND supplement_authorized_by IS NULL)
  OR (source_type='REPLACEMENT' AND replaces_id IS NOT NULL AND supplement_due_at IS NOT NULL AND supplement_authorized_by IS NOT NULL)
);
