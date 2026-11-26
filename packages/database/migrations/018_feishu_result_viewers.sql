-- Existing laboratory users keep their original account, department and capabilities.
-- Newly authenticated in-tenant people outside the member roster are result-only viewers.
ALTER TABLE users ADD COLUMN result_view_only BOOLEAN NOT NULL DEFAULT FALSE;
