CREATE TABLE installation_setup (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  consumed_at timestamptz
);

CREATE TABLE feishu_connections (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  app_id text NOT NULL,
  tenant_key text NOT NULL,
  encrypted_secret text NOT NULL
);
