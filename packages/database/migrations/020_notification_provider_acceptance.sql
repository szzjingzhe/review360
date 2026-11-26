-- ACCEPTED means the provider accepted the message, not that the recipient received/read it.
ALTER TABLE notification_outbox ADD COLUMN provider_message_id TEXT;
ALTER TABLE notification_outbox ADD COLUMN accepted_at TIMESTAMPTZ;
ALTER TABLE notification_outbox ADD COLUMN last_error TEXT;
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_status_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK(status IN ('PENDING','SENT','ACCEPTED','FAILED','DEAD'));
