-- M1-003 规则、模板与周期（技术文档 5.2：rulesets / template_versions / template_items / cycles / cycle_participants）

CREATE TABLE rulesets (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations (id),
  version     INTEGER NOT NULL CHECK (version > 0),
  status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FROZEN', 'ARCHIVED')),
  config_json JSONB NOT NULL,
  checksum    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_ruleset_version ON rulesets (org_id, version);
-- 冻结后不可 UPDATE 配置：由服务层禁止；此处阻止直接篡改 status 之外的关键字段不可能用触发器完全覆盖，
-- 应用账号不应拥有对 rulesets 的 UPDATE 权限（部署层最小权限）。

CREATE TABLE template_versions (
  id           UUID PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations (id),
  ruleset_id   UUID NOT NULL REFERENCES rulesets (id),
  role_code    TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_template_role ON template_versions (ruleset_id, role_code);

CREATE TABLE template_items (
  id           UUID PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations (id),
  template_id  UUID NOT NULL REFERENCES template_versions (id),
  code         TEXT NOT NULL,
  label        TEXT NOT NULL,
  weight       INTEGER NOT NULL CHECK (weight BETWEEN 0 AND 100),
  position     INTEGER NOT NULL CHECK (position >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_template_item_code ON template_items (template_id, code);
-- 同模板权重合计 = 100 属跨行约束，由发布规则在事务中校验（技术文档 5.5 明确不写成单行 CHECK）。

CREATE TABLE cycles (
  id                   UUID PRIMARY KEY,
  org_id               UUID NOT NULL REFERENCES organizations (id),
  month                DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  status               TEXT NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT', 'PENDING_OPEN', 'REVIEWING', 'CALIBRATING',
                                          'PARTIALLY_PUBLISHED', 'PUBLISHED', 'ARCHIVED', 'CANCELLED')),
  open_at              TIMESTAMPTZ,
  close_at             TIMESTAMPTZ,
  calibration_at       TIMESTAMPTZ,
  publish_at           TIMESTAMPTZ,
  ruleset_id           UUID REFERENCES rulesets (id),
  assignment_version   INTEGER,
  row_version          INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_cycle_month ON cycles (org_id, month);
-- 时间先后：允许短月模板中校准与截止同日，但发布必须晚于开启与截止。
ALTER TABLE cycles ADD CONSTRAINT ck_cycle_time_order
  CHECK (open_at IS NULL OR close_at IS NULL OR open_at < close_at);
ALTER TABLE cycles ADD CONSTRAINT ck_cycle_publish_order
  CHECK (publish_at IS NULL OR close_at IS NULL OR close_at <= publish_at);

CREATE TABLE cycle_participants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id          UUID NOT NULL REFERENCES cycles (id),
  org_id            UUID NOT NULL REFERENCES organizations (id),
  user_id           UUID NOT NULL REFERENCES users (id),
  dept_snapshot     UUID NOT NULL,
  role_snapshot     TEXT NOT NULL,
  station_snapshot  TEXT,
  template_id       UUID REFERENCES template_versions (id),
  eligibility       TEXT NOT NULL DEFAULT 'ELIGIBLE'
                    CHECK (eligibility IN ('ELIGIBLE', 'EXCLUDED', 'PENDING')),
  exclusion_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_cycle_participant ON cycle_participants (cycle_id, user_id);
