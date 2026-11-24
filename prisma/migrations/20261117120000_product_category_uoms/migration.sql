-- UnitOfMeasure.updatedAt (safe add for existing rows)
ALTER TABLE "units_of_measure" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6);
UPDATE "units_of_measure" SET "updated_at" = COALESCE("updated_at", "created_at", NOW()) WHERE "updated_at" IS NULL;
ALTER TABLE "units_of_measure" ALTER COLUMN "updated_at" SET DEFAULT NOW();
ALTER TABLE "units_of_measure" ALTER COLUMN "updated_at" SET NOT NULL;

-- Product category ↔ UOM mappings (database-driven allowed transaction UOMs)
CREATE TABLE IF NOT EXISTS "product_category_uoms" (
  "id" UUID NOT NULL,
  "plant_id" UUID NOT NULL,
  "product_category_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "product_category_uoms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_category_uoms_plant_id_product_category_id_unit_id_key"
  ON "product_category_uoms"("plant_id", "product_category_id", "unit_id");

CREATE INDEX IF NOT EXISTS "product_category_uoms_plant_id_product_category_id_is_active_idx"
  ON "product_category_uoms"("plant_id", "product_category_id", "is_active");

-- At most one active default UOM per category
CREATE UNIQUE INDEX IF NOT EXISTS "product_category_uoms_one_active_default"
  ON "product_category_uoms"("plant_id", "product_category_id")
  WHERE "is_default" = true AND "is_active" = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_category_uoms_plant_id_fkey'
  ) THEN
    ALTER TABLE "product_category_uoms"
      ADD CONSTRAINT "product_category_uoms_plant_id_fkey"
      FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_category_uoms_product_category_id_fkey'
  ) THEN
    ALTER TABLE "product_category_uoms"
      ADD CONSTRAINT "product_category_uoms_product_category_id_fkey"
      FOREIGN KEY ("product_category_id") REFERENCES "product_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_category_uoms_unit_id_fkey'
  ) THEN
    ALTER TABLE "product_category_uoms"
      ADD CONSTRAINT "product_category_uoms_unit_id_fkey"
      FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
