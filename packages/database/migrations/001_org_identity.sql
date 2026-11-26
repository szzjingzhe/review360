-- M1-001 组织与身份（技术文档 5.2：organizations / users / external_identities / sessions / departments）

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE organizations (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL CHECK (timezone <> ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations (id),
  display_name  TEXT NOT NULL CHECK (display_name <> ''),
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
  row_version   INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_org ON users (org_id);
-- 姓名允许重复（技术文档 4.1：姓名不是主键），不加 display_name 唯一约束。

CREATE TABLE external_identities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users (id),
  provider         TEXT NOT NULL,
  tenant_key       TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  approved         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 禁止同名自动匹配：外部三元组唯一，绑定必须走显式批准。
CREATE UNIQUE INDEX uq_external_identity
  ON external_identities (provider, tenant_key, external_id);
CREATE INDEX idx_external_identities_user ON external_identities (user_id);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,            -- 仅存 SHA-256，不存明文令牌
  user_id     UUID NOT NULL REFERENCES users (id),
  org_id      UUID NOT NULL REFERENCES organizations (id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE departments (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations (id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL CHECK (name <> ''),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_department_code ON departments (org_id, code);
