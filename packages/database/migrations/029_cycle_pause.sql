-- Preserve existing cycle records while allowing a reversible review pause.
ALTER TABLE cycles DROP CONSTRAINT cycles_status_check;
ALTER TABLE cycles ADD CONSTRAINT cycles_status_check CHECK (status IN
  ('DRAFT','PENDING_OPEN','REVIEWING','PAUSED','CALIBRATING',
   'PARTIALLY_PUBLISHED','PUBLISHED','ARCHIVED','CANCELLED'));
