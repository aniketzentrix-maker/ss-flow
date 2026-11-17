-- Product-level allowed UOMs (lead / transaction dropdown source)
CREATE TABLE IF NOT EXISTS "product_uoms" (
  "id" UUID NOT NULL,
  "plant_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "product_uoms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_uoms_plant_id_product_id_unit_id_key"
  ON "product_uoms"("plant_id", "product_id", "unit_id");

CREATE INDEX IF NOT EXISTS "product_uoms_plant_id_product_id_is_active_idx"
  ON "product_uoms"("plant_id", "product_id", "is_active");

CREATE UNIQUE INDEX IF NOT EXISTS "product_uoms_one_active_default"
  ON "product_uoms"("plant_id", "product_id")
  WHERE "is_default" = true AND "is_active" = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_uoms_plant_id_fkey'
  ) THEN
    ALTER TABLE "product_uoms"
      ADD CONSTRAINT "product_uoms_plant_id_fkey"
      FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_uoms_product_id_fkey'
  ) THEN
    ALTER TABLE "product_uoms"
      ADD CONSTRAINT "product_uoms_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_uoms_unit_id_fkey'
  ) THEN
    ALTER TABLE "product_uoms"
      ADD CONSTRAINT "product_uoms_unit_id_fkey"
      FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
