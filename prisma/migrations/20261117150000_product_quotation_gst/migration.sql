-- Product GST slab (5% or 18%) for quotations
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "gst_percent" DECIMAL(5, 2);
UPDATE "products" SET "gst_percent" = 18 WHERE "gst_percent" IS NULL;
ALTER TABLE "products" ALTER COLUMN "gst_percent" SET DEFAULT 18;
ALTER TABLE "products" ALTER COLUMN "gst_percent" SET NOT NULL;

-- Quotation line GST snapshot
ALTER TABLE "quotation_items" ADD COLUMN IF NOT EXISTS "gst_percent" DECIMAL(5, 2);
UPDATE "quotation_items" SET "gst_percent" = 18 WHERE "gst_percent" IS NULL;
ALTER TABLE "quotation_items" ALTER COLUMN "gst_percent" SET DEFAULT 18;
ALTER TABLE "quotation_items" ALTER COLUMN "gst_percent" SET NOT NULL;
