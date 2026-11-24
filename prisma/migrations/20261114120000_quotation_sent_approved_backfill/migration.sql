-- Legacy sent quotations predate mandatory pricing approval; treat as approved at send time.
UPDATE "quotations"
SET
  "approved_at" = COALESCE("approved_at", "sent_at", "updated_at"),
  "approval_required" = true
WHERE
  "status" IN ('SENT', 'ACCEPTED', 'EXPIRED', 'SUPERSEDED')
  AND "approved_at" IS NULL;