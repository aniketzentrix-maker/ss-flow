-- Normalized pricing key for Product Master rates (product + specification combination).
ALTER TABLE "product_variants"
  ADD COLUMN IF NOT EXISTS "pricing_fingerprint" TEXT;

CREATE INDEX IF NOT EXISTS "product_variants_product_id_pricing_fingerprint_idx"
  ON "product_variants" ("product_id", "pricing_fingerprint");

-- Only one ACTIVE rate per product + normalized pricing combination.
CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_product_pricing_fingerprint_active_uidx"
  ON "product_variants" ("product_id", "pricing_fingerprint")
  WHERE "is_active" = true AND "pricing_fingerprint" IS NOT NULL;
