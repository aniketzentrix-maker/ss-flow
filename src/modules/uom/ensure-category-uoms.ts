import type { Prisma, PrismaClient } from "@prisma/client";
import { BUSINESS_ROOTS } from "@/lib/domain/business-categories";
import { uuidv7 } from "@/lib/ids";

type Db = PrismaClient | Prisma.TransactionClient;

const MASTER_UOMS = [
  { symbol: "KG", name: "Kilogram", unitType: "weight" },
  { symbol: "PCS", name: "Pieces", unitType: "count" },
  { symbol: "FT", name: "Feet", unitType: "length" },
  { symbol: "IN", name: "Inch", unitType: "length" },
] as const;

/** Leaf product-type categories used for UOM mapping (under TRADING / MFG). */
const TYPE_CATEGORIES = [
  {
    code: "COIL",
    name: "Coil",
    parent: "TRADING" as const,
    categoryType: "raw_material",
    allowed: ["KG", "FT", "IN"] as const,
    defaultSymbol: "KG",
    productSkus: ["SSM-TRD-COIL", "COIL"],
  },
  {
    code: "WIRE",
    name: "Wire",
    parent: "TRADING" as const,
    categoryType: "raw_material",
    allowed: ["KG", "PCS"] as const,
    defaultSymbol: "KG",
    productSkus: ["SSM-TRD-WIRE", "SSM-TRD-WIRE-PCS", "WIRE"],
  },
  {
    code: "ROD",
    name: "Rod",
    parent: "TRADING" as const,
    categoryType: "raw_material",
    allowed: ["KG", "PCS"] as const,
    defaultSymbol: "KG",
    productSkus: ["SSM-TRD-ROD", "ROD"],
  },
  {
    code: "CIRCLE",
    name: "Circle",
    parent: "MFG" as const,
    categoryType: "finished_goods",
    allowed: ["IN", "KG"] as const,
    defaultSymbol: "KG",
    productSkus: ["SSM-MFG-CIRCLE", "CIRCLE"],
  },
  {
    code: "LASER",
    name: "Laser Items",
    parent: "MFG" as const,
    categoryType: "finished_goods",
    allowed: ["KG", "PCS"] as const,
    defaultSymbol: "KG",
    productSkus: ["SSM-MFG-LASER-FARMA"],
  },
] as const;

/** Manufactured Products root gets KG/PCS as the catch-all for other MFG products. */
const MFG_ROOT_ALLOWED = ["KG", "PCS"] as const;

async function ensureUnit(
  db: Db,
  plantId: string,
  spec: (typeof MASTER_UOMS)[number],
) {
  const existing = await db.unitOfMeasure.findUnique({
    where: { plantId_symbol: { plantId, symbol: spec.symbol } },
  });
  if (existing) {
    if (!existing.isActive || existing.name !== spec.name || existing.unitType !== spec.unitType) {
      return db.unitOfMeasure.update({
        where: { id: existing.id },
        data: { isActive: true, name: spec.name, unitType: spec.unitType },
      });
    }
    return existing;
  }
  return db.unitOfMeasure.create({
    data: {
      id: uuidv7(),
      plantId,
      symbol: spec.symbol,
      name: spec.name,
      unitType: spec.unitType,
      isActive: true,
    },
  });
}

async function ensureTypeCategory(
  db: Db,
  plantId: string,
  parentId: string,
  spec: (typeof TYPE_CATEGORIES)[number],
) {
  const existing = await db.productCategory.findFirst({
    where: { plantId, code: spec.code },
  });
  if (existing) {
    return db.productCategory.update({
      where: { id: existing.id },
      data: {
        name: spec.name,
        parentId,
        categoryType: spec.categoryType,
        status: "active",
      },
    });
  }
  return db.productCategory.create({
    data: {
      id: uuidv7(),
      plantId,
      code: spec.code,
      name: spec.name,
      parentId,
      categoryType: spec.categoryType,
      status: "active",
      description: `UOM mapping category for ${spec.name}`,
    },
  });
}

async function syncCategoryUoms(
  db: Db,
  plantId: string,
  categoryId: string,
  allowedSymbols: readonly string[],
  defaultSymbol: string,
  unitsBySymbol: Map<string, { id: string }>,
) {
  const existing = await db.productCategoryUom.findMany({
    where: { plantId, productCategoryId: categoryId },
    include: { unit: { select: { symbol: true } } },
  });
  const byUnitId = new Map(existing.map((row) => [row.unitId, row]));

  for (const symbol of allowedSymbols) {
    const unit = unitsBySymbol.get(symbol);
    if (!unit) continue;
    const row = byUnitId.get(unit.id);
    const isDefault = symbol === defaultSymbol;
    if (row) {
      if (!row.isActive || row.isDefault !== isDefault) {
        // Clear other defaults first when promoting this one
        if (isDefault && !row.isDefault) {
          await db.productCategoryUom.updateMany({
            where: { plantId, productCategoryId: categoryId, isDefault: true },
            data: { isDefault: false },
          });
        }
        await db.productCategoryUom.update({
          where: { id: row.id },
          data: { isActive: true, isDefault },
        });
      }
    } else {
      if (isDefault) {
        await db.productCategoryUom.updateMany({
          where: { plantId, productCategoryId: categoryId, isDefault: true },
          data: { isDefault: false },
        });
      }
      await db.productCategoryUom.create({
        data: {
          id: uuidv7(),
          plantId,
          productCategoryId: categoryId,
          unitId: unit.id,
          isDefault,
          isActive: true,
        },
      });
    }
  }
}

async function alignProductsToTypeCategories(
  db: Db,
  plantId: string,
  typeCategoryIdByCode: Map<string, string>,
) {
  for (const spec of TYPE_CATEGORIES) {
    const categoryId = typeCategoryIdByCode.get(spec.code);
    if (!categoryId) continue;
    await db.product.updateMany({
      where: {
        plantId,
        sku: { in: [...spec.productSkus] },
      },
      data: { categoryId },
    });
  }
}

/**
 * Ensures plant UOM masters, type categories, and category↔UOM mappings exist.
 * Idempotent — safe to run on seed / deploy.
 */
export async function ensureCategoryUoms(db: Db) {
  const plants = await db.plant.findMany({ select: { id: true, code: true } });
  const report = {
    plants: plants.length,
    unitsEnsured: 0,
    categoriesEnsured: 0,
    mappingsTouched: 0,
  };

  for (const plant of plants) {
    const unitsBySymbol = new Map<string, { id: string }>();
    for (const spec of MASTER_UOMS) {
      const unit = await ensureUnit(db, plant.id, spec);
      unitsBySymbol.set(spec.symbol, unit);
      report.unitsEnsured += 1;
    }

    const trading = await db.productCategory.findFirst({
      where: { plantId: plant.id, code: BUSINESS_ROOTS.trading.code },
    });
    const manufactured = await db.productCategory.findFirst({
      where: { plantId: plant.id, code: BUSINESS_ROOTS.manufactured.code },
    });
    if (!trading || !manufactured) continue;

    const typeCategoryIdByCode = new Map<string, string>();
    for (const spec of TYPE_CATEGORIES) {
      const parentId = spec.parent === "TRADING" ? trading.id : manufactured.id;
      const category = await ensureTypeCategory(db, plant.id, parentId, spec);
      typeCategoryIdByCode.set(spec.code, category.id);
      report.categoriesEnsured += 1;
      await syncCategoryUoms(
        db,
        plant.id,
        category.id,
        spec.allowed,
        spec.defaultSymbol,
        unitsBySymbol,
      );
      report.mappingsTouched += spec.allowed.length;
    }

    // Manufactured Products root: KG, PCS (default KG)
    await syncCategoryUoms(
      db,
      plant.id,
      manufactured.id,
      MFG_ROOT_ALLOWED,
      "KG",
      unitsBySymbol,
    );
    report.mappingsTouched += MFG_ROOT_ALLOWED.length;

    await alignProductsToTypeCategories(db, plant.id, typeCategoryIdByCode);
    await backfillProductUomsFromCategories(db, plant.id, unitsBySymbol);
  }

  return report;
}

/** Copy category (or seed-type) UOMs onto products that have no ProductUom rows yet. */
async function backfillProductUomsFromCategories(
  db: Db,
  plantId: string,
  unitsBySymbol: Map<string, { id: string }>,
) {
  const { setProductAllowedUoms } = await import("@/modules/uom/product-uoms");
  const products = await db.product.findMany({
    where: { plantId, isActive: true },
    select: {
      id: true,
      sku: true,
      name: true,
      categoryId: true,
      baseUnit: { select: { symbol: true } },
      allowedUoms: { where: { isActive: true }, select: { id: true } },
      category: { select: { code: true, parent: { select: { code: true } } } },
    },
  });

  for (const product of products) {
    if (product.allowedUoms.length) continue;

    const type = TYPE_CATEGORIES.find(
      (row) =>
        row.productSkus.some((sku) => sku.toUpperCase() === product.sku.toUpperCase()) ||
        product.name.toLowerCase().includes(row.name.toLowerCase()) ||
        product.category?.code === row.code,
    );

    let symbols: string[] = [];
    let defaultSymbol = product.baseUnit?.symbol?.toUpperCase() || "KG";

    if (type) {
      symbols = [...type.allowed];
      defaultSymbol = type.defaultSymbol;
    } else if (product.category?.code === BUSINESS_ROOTS.manufactured.code) {
      symbols = [...MFG_ROOT_ALLOWED];
      defaultSymbol = "KG";
    } else if (product.categoryId) {
      const mapped = await db.productCategoryUom.findMany({
        where: { plantId, productCategoryId: product.categoryId, isActive: true },
        include: { unit: { select: { symbol: true } } },
      });
      if (mapped.length) {
        symbols = mapped.map((row) => row.unit.symbol.toUpperCase());
        defaultSymbol =
          mapped.find((row) => row.isDefault)?.unit.symbol.toUpperCase() || symbols[0] || defaultSymbol;
      }
    }

    if (!symbols.length && product.baseUnit?.symbol) {
      symbols = [product.baseUnit.symbol.toUpperCase()];
    }
    if (!symbols.length) continue;
    // Ensure units exist in map
    symbols = symbols.filter((s) => unitsBySymbol.has(s));
    if (!symbols.length) continue;
    if (!symbols.includes(defaultSymbol)) defaultSymbol = symbols[0]!;

    await setProductAllowedUoms(db, product.id, plantId, {
      symbols,
      defaultSymbol,
    });
  }
}

export const UOM_TYPE_CATEGORY_CODES = TYPE_CATEGORIES.map((row) => row.code);

/** Seed matrix for tests and docs — runtime dropdowns always read ProductCategoryUom. */
export const CATEGORY_UOM_SEED = {
  masters: MASTER_UOMS,
  types: TYPE_CATEGORIES.map((row) => ({
    code: row.code,
    name: row.name,
    allowed: [...row.allowed],
    defaultSymbol: row.defaultSymbol,
  })),
  manufacturedRoot: { allowed: [...MFG_ROOT_ALLOWED], defaultSymbol: "KG" as const },
};
