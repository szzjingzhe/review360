-- Additive: legacy manual relations remain valid with an unknown reason.
ALTER TABLE assignment_manual_edges ADD COLUMN IF NOT EXISTS reason text;
