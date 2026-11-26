-- Additive only: formal scores/publications and existing analyses remain untouched.
ALTER TABLE growth_analyses ADD COLUMN input_snapshot jsonb;
ALTER TABLE growth_analyses ADD COLUMN input_hash text;
ALTER TABLE growth_analyses ADD COLUMN schema_version integer NOT NULL DEFAULT 1;
