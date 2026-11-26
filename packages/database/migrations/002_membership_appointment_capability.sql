-- M1-002 归属、任命与授权（技术文档 5.2：department_memberships / appointments / capability_grants）

CREATE TABLE department_memberships (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations (id),
  user_id        UUID NOT NULL REFERENCES users (id),
  department_id  UUID NOT NULL REFERENCES departments (id),
  valid_from     DATE NOT NULL,
  valid_to       DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 同一用户同一时段最多一个正式部门（时间重叠用排他约束表达，含开放式区间）。
CREATE INDEX idx_memberships_user ON department_memberships (user_id);
CREATE INDEX idx_memberships_dept ON department_memberships (department_id);
ALTER TABLE department_memberships
  ADD CONSTRAINT excl_one_primary_dept
  EXCLUDE USING gist (
    user_id WITH =,
    daterange(valid_from, COALESCE(valid_to, 'infinity'::date)) WITH &&
  );

CREATE TABLE appointments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations (id),
  user_id        UUID NOT NULL REFERENCES users (id),
  role           TEXT NOT NULL CHECK (role IN ('HEAD', 'HRPB', 'SUPERVISOR')),
  scope_dept_id  UUID REFERENCES departments (id),
  valid_from     DATE NOT NULL,
  valid_to       DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointments_user ON appointments (user_id);
CREATE INDEX idx_appointments_dept ON appointments (scope_dept_id);
-- 时间段的唯一性（同部门同期一名部长、一名派驻 HRPB）由服务事务校验；
-- 这里只对"当前开放式任职"做部分唯一索引，作为最后防线。
CREATE UNIQUE INDEX uq_active_head_per_dept
  ON appointments (scope_dept_id) WHERE role = 'HEAD' AND valid_to IS NULL;
CREATE UNIQUE INDEX uq_active_hrpb_per_dept
  ON appointments (scope_dept_id) WHERE role = 'HRPB' AND valid_to IS NULL;

CREATE TABLE capability_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations (id),
  user_id      UUID NOT NULL REFERENCES users (id),
  capability   TEXT NOT NULL CHECK (capability <> ''),
  scope_type   TEXT NOT NULL DEFAULT 'ORG'
               CHECK (scope_type IN ('ORG', 'DEPARTMENT', 'STATION', 'CYCLE')),
  scope_id     UUID,
  reason       TEXT,
  granted_by   UUID REFERENCES users (id),
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to     TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_capability_grants_lookup
  ON capability_grants (user_id, capability);
-- scope 语义（部门/派驻/周期）由服务层展开，scope_id 不做外键：不同 scope_type 指向不同表。
