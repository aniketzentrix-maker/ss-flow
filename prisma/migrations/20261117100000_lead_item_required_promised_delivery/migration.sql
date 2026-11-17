-- Per-product required (customer) and promised (company) delivery dates on lead items
ALTER TABLE "lead_items" ADD COLUMN IF NOT EXISTS "required_delivery_date" DATE;
ALTER TABLE "lead_items" ADD COLUMN IF NOT EXISTS "promised_delivery_date" DATE;

-- Backfill from legacy expected_delivery_date (treated as customer required date)
UPDATE "lead_items"
SET "required_delivery_date" = "expected_delivery_date"
WHERE "required_delivery_date" IS NULL
  AND "expected_delivery_date" IS NOT NULL;
