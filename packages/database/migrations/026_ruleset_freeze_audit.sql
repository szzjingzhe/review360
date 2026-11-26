-- Existing frozen versions retain unknown publication metadata.
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS frozen_at timestamptz;
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS frozen_by uuid REFERENCES users(id);
