import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/db";
import { AppError } from "@/lib/errors";

type Db = PrismaClient | Prisma.TransactionClient;

export type UomOption = {
  id: string;
  name: string;
  symbol: string;
  unitType: string;
  isDefault: boolean;
};

function toOption(row: {
  isDefault: boolean;
  unit: { id: string; name: string; symbol: string; unitType: string; isActive: boolean };
}): UomOption | null {
  if (!row.unit.isActive) return null;
  return {
    id: row.unit.id,
    name: row.unit.name,
    symbol: row.unit.symbol,
    unitType: row.unit.unitType,
    isDefault: row.isDefault,
  };
}

export async function getActiveUoms(plantId: string, db: Db = prisma): Promise<UomOption[]> {
  const rows = await db.unitOfMeasure.findMany({
    where: { plantId, isActive: true },
    orderBy: { symbol: "asc" },
  });
  return rows.map((unit) => ({
    id: unit.id,
    name: unit.name,
    symbol: unit.symbol,
    unitType: unit.unitType,
    isDefault: false,
  }));
}

async function categoryChainIds(db: Db, plantId: string, categoryId: string | null | undefined) {
  if (!categoryId) return [] as string[];
  // One plant-scoped read, then walk parents in memory (avoids N round-trips per depth).
  const categories = await db.productCategory.findMany({
    where: { plantId },
    select: { id: true, parentId: true },
  });
  const parentById = new Map(categories.map((row) => [row.id, row.parentId]));
  const ids: string[] = [];
  let currentId: string | null = categoryId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    ids.push(currentId);
    if (!parentById.has(currentId)) break;
    currentId = parentById.get(currentId) ?? null;
  }
  return ids;
}

async function mappingsForCategories(db: Db, plantId: string, categoryIds: string[]) {
  if (!categoryIds.length) return [] as UomOption[];
  const rows = await db.productCategoryUom.findMany({
    where: {
      plantId,
      productCategoryId: { in: categoryIds },
      isActive: true,
      unit: { isActive: true, plantId },
    },
    include: {
      unit: { select: { id: true, name: true, symbol: true, unitType: true, isActive: true } },
    },
    orderBy: [{ isDefault: "desc" }, { unit: { symbol: "asc" } }],
  });

  for (const categoryId of categoryIds) {
    const forCategory = rows
      .filter((row) => row.productCategoryId === categoryId)
      .map(toOption)
      .filter((row): row is UomOption => Boolean(row));
    if (forCategory.length) {
      let sawDefault = false;
      return forCategory.map((opt) => {
        if (opt.isDefault && !sawDefault) {
          sawDefault = true;
          return opt;
        }
        return { ...opt, isDefault: false };
      });
    }
  }
  return [];
}

async function mappingsForProduct(db: Db, plantId: string, productId: string): Promise<UomOption[]> {
  const rows = await db.productUom.findMany({
    where: {
      plantId,
      productId,
      isActive: true,
      unit: { isActive: true, plantId },
    },
    include: {
      unit: { select: { id: true, name: true, symbol: true, unitType: true, isActive: true } },
    },
    orderBy: [{ isDefault: "desc" }, { unit: { symbol: "asc" } }],
  });
  let sawDefault = false;
  return rows
    .map(toOption)
    .filter((row): row is UomOption => Boolean(row))
    .map((opt) => {
      if (opt.isDefault && !sawDefault) {
        sawDefault = true;
        return opt;
      }
      return { ...opt, isDefault: false };
    });
}

/**
 * Allowed transaction UOMs for a catalog product.
 * Prefers product-level ProductUom rows; falls back to category mappings, then base unit.
 */
export async function getAllowedUomsForProduct(
  productId: string,
  plantId: string,
  db: Db = prisma,
): Promise<UomOption[]> {
  const product = await db.product.findFirst({
    where: { id: productId, plantId, isActive: true },
    select: {
      id: true,
      categoryId: true,
      baseUnit: { select: { id: true, name: true, symbol: true, unitType: true, isActive: true } },
    },
  });
  if (!product) throw new AppError(404, "NOT_FOUND", "Product not found for this plant.");

  const productMapped = await mappingsForProduct(db, plantId, productId);
  if (productMapped.length) return productMapped;

  const chain = await categoryChainIds(db, plantId, product.categoryId);
  const mapped = await mappingsForCategories(db, plantId, chain);
  if (mapped.length) return mapped;

  if (product.baseUnit?.isActive) {
    return [
      {
        id: product.baseUnit.id,
        name: product.baseUnit.name,
        symbol: product.baseUnit.symbol,
        unitType: product.baseUnit.unitType,
        isDefault: true,
      },
    ];
  }
  return [];
}

export async function getDefaultUomForProduct(
  productId: string,
  plantId: string,
  db: Db = prisma,
): Promise<UomOption | null> {
  const allowed = await getAllowedUomsForProduct(productId, plantId, db);
  return allowed.find((row) => row.isDefault) ?? allowed[0] ?? null;
}

export async function getAllowedUomsForCategory(
  productCategoryId: string,
  plantId: string,
  db: Db = prisma,
): Promise<UomOption[]> {
  const category = await db.productCategory.findFirst({
    where: { id: productCategoryId, plantId, status: "active" },
    select: { id: true },
  });
  if (!category) throw new AppError(404, "NOT_FOUND", "Category not found for this plant.");
  const chain = await categoryChainIds(db, plantId, productCategoryId);
  return mappingsForCategories(db, plantId, chain);
}

/**
 * Validates a unit (by id or symbol) is allowed for the product in this plant.
 */
export async function validateProductUom(
  productId: string,
  plantId: string,
  input: { unitId?: string | null; uomSymbol?: string | null },
  db: Db = prisma,
) {
  const allowed = await getAllowedUomsForProduct(productId, plantId, db);
  if (!allowed.length) {
    throw new AppError(400, "VALIDATION", "No active UOMs are configured for this product category.");
  }

  const unitId = input.unitId?.trim() || "";
  const symbol = input.uomSymbol?.trim().toUpperCase() || "";

  let match = unitId ? allowed.find((row) => row.id === unitId) : undefined;
  if (!match && symbol) match = allowed.find((row) => row.symbol.toUpperCase() === symbol);

  if (!match) {
    const list = allowed.map((row) => row.symbol).join(", ");
    throw new AppError(
      400,
      "VALIDATION",
      `UOM is not permitted for this product. Allowed: ${list}.`,
    );
  }

  // Allowed options already come from active plant UOMs; avoid a redundant round-trip.
  return {
    unit: {
      id: match.id,
      name: match.name,
      symbol: match.symbol,
      unitType: match.unitType,
      isActive: true,
    },
    option: match,
    allowed,
  };
}

export async function listCategoryUomMappings(
  productCategoryId: string,
  plantId: string,
  db: Db = prisma,
) {
  return db.productCategoryUom.findMany({
    where: { plantId, productCategoryId },
    include: {
      unit: { select: { id: true, name: true, symbol: true, unitType: true, isActive: true } },
    },
    orderBy: [{ isDefault: "desc" }, { unit: { symbol: "asc" } }],
  });
}
