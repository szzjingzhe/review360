-- Forward-compatible metadata; historical cases/actions remain unchanged.
ALTER TABLE calibration_cases ADD COLUMN IF NOT EXISTS severity text CHECK (severity IN ('HIGH','MEDIUM','LOW'));
ALTER TABLE calibration_cases ADD COLUMN IF NOT EXISTS evidence_json jsonb;
ALTER TABLE calibration_cases ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
ALTER TABLE calibration_cases ADD COLUMN IF NOT EXISTS input_hash text;
DROP INDEX IF EXISTS uq_calibration_case;
CREATE UNIQUE INDEX uq_calibration_revision_reason ON calibration_cases(review_revision_id,reason_code) WHERE reason_code <> 'SELF_PEER_DIFF';
CREATE UNIQUE INDEX uq_calibration_difference_input ON calibration_cases(cycle_id,review_revision_id,input_hash) WHERE reason_code = 'SELF_PEER_DIFF';
ALTER TABLE calibration_actions ADD COLUMN IF NOT EXISTS previous_status text;
ALTER TABLE calibration_actions ADD COLUMN IF NOT EXISTS next_status text;
