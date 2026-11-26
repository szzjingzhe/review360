-- Existing rule versions retain their values; missing descriptions stay NULL.
ALTER TABLE template_items ADD COLUMN IF NOT EXISTS description text;
