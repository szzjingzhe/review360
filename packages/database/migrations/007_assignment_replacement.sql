-- M2-007 分配替补边类型（M2.4：开期锁定后的单边替补）
ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_source_type_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_source_type_check
  CHECK (source_type IN ('HEAD', 'HRPB', 'PEER', 'SUPERVISOR', 'UPWARD', 'REPLACEMENT'));
