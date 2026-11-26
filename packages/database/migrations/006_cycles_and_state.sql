-- M2-006 周期状态机、阶段、锁定与状态日志（前向补充 M1-003/M1-004）

-- cycles 补充展示与审计字段
ALTER TABLE cycles
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 回填现有 cycles 的 title（如有旧数据）
UPDATE cycles SET title = COALESCE(title, '周期 ' || to_char(month, 'YYYY-MM')) WHERE title IS NULL OR title = '';
ALTER TABLE cycles ALTER COLUMN title SET NOT NULL;

-- assignment_runs.seed 由 INTEGER 改为 TEXT，便于存储组合种子/UUID/版本签名
ALTER TABLE assignment_runs ALTER COLUMN seed TYPE TEXT USING seed::TEXT;

-- assignment_runs.status 增加 FEASIBLE/INFEASIBLE 用于预览，保留 LOCKED/SUPERSEDED
ALTER TABLE assignment_runs DROP CONSTRAINT IF EXISTS assignment_runs_status_check;
ALTER TABLE assignment_runs ADD CONSTRAINT assignment_runs_status_check
  CHECK (status IN ('DRAFT', 'FEASIBLE', 'INFEASIBLE', 'LOCKED', 'SUPERSEDED'));

-- 周期阶段调度表（worker 按 planned_at 扫描）
CREATE TABLE cycle_phases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    UUID NOT NULL REFERENCES cycles (id) ON DELETE CASCADE,
  phase       TEXT NOT NULL CHECK (phase IN ('OPEN', 'CLOSE', 'REMIND', 'PUBLISH', 'ARCHIVE')),
  planned_at  TIMESTAMPTZ NOT NULL,
  actual_at   TIMESTAMPTZ,
  created_by  UUID REFERENCES users (id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_cycle_phase ON cycle_phases (cycle_id, phase);
CREATE INDEX idx_cycle_phases_planned ON cycle_phases (planned_at, actual_at);

-- 周期锁定：开期时写入，防止同时修改分配/规则
CREATE TABLE cycle_locks (
  cycle_id          UUID PRIMARY KEY REFERENCES cycles (id) ON DELETE CASCADE,
  locked_by         UUID NOT NULL REFERENCES users (id),
  locked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  assignment_run_id UUID REFERENCES assignment_runs (id)
);

-- 周期状态机转换日志
CREATE TABLE cycle_state_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    UUID NOT NULL REFERENCES cycles (id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  actor_id    UUID REFERENCES users (id),
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cycle_state_log_cycle ON cycle_state_log (cycle_id, created_at DESC);

-- cycles.updated_at 自动维护
CREATE OR REPLACE FUNCTION set_cycle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cycle_updated_at ON cycles;
CREATE TRIGGER trg_cycle_updated_at
  BEFORE UPDATE ON cycles
  FOR EACH ROW EXECUTE FUNCTION set_cycle_updated_at();
