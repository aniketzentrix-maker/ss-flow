import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";

type Db = PrismaClient | Prisma.TransactionClient;

export type ProductUomMappingInput = {
  symbols: string[];
  defaultSymbol?: string | null;
};

type ExistingUomRow = { id: string; unitId: string; isActive: boolean; isDefault: boolean };

/**
 * Replace active allowed UOMs for a product. Symbols resolve within the product's plant.
 * Default falls back to the first symbol when omitted / invalid.
 */
export async function setProductAllowedUoms(
  db: Db,
  productId: string,
  plantId: string,
  input: ProductUomMappingInput,
  preloaded?: {
    unitsBySymbol?: Map<string, { id: string; symbol: string }>;
    existing?: ExistingUomRow[];
  },
) {
  const symbols = [...new Set(input.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!symbols.length) {
    throw new AppError(400, "VALIDATION", "Select at least one allowed UOM.");
  }

  let units: { id: string; symbol: string }[];
  if (preloaded?.unitsBySymbol) {
    const missing: string[] = [];
    units = [];
    for (const symbol of symbols) {
      const unit = preloaded.unitsBySymbol.get(symbol);
      if (!unit) missing.push(symbol);
      else units.push(unit);
    }
    if (missing.length) {
      throw new AppError(400, "VALIDATION", `Unknown or inactive UOM(s): ${missing.join(", ")}.`);
    }
  } else {
    const found = await db.unitOfMeasure.findMany({
      where: { plantId, isActive: true, symbol: { in: symbols } },
      select: { id: true, symbol: true },
    });
    if (found.length !== symbols.length) {
      const foundSet = new Set(found.map((u) => u.symbol.toUpperCase()));
      const missing = symbols.filter((s) => !foundSet.has(s));
      throw new AppError(400, "VALIDATION", `Unknown or inactive UOM(s): ${missing.join(", ")}.`);
    }
    units = found;
  }

  const bySymbol = new Map(units.map((u) => [u.symbol.toUpperCase(), u]));
  const defaultSymbol =
    (input.defaultSymbol?.trim().toUpperCase() && bySymbol.has(input.defaultSymbol.trim().toUpperCase())
      ? input.defaultSymbol.trim().toUpperCase()
      : symbols[0])!;
  const defaultUnitId = bySymbol.get(defaultSymbol)!.id;

  const existing =
    preloaded?.existing ??
    (await db.productUom.findMany({
      where: { plantId, productId },
      select: { id: true, unitId: true, isActive: true, isDefault: true },
    }));
  const incomingUnitIds = new Set(units.map((u) => u.id));
  const existingByUnitId = new Map(existing.map((row) => [row.unitId, row]));

  const toDeactivateIds = existing
    .filter((row) => !incomingUnitIds.has(row.unitId) && (row.isActive || row.isDefault))
    .map((row) => row.id);
  if (toDeactivateIds.length) {
    await db.productUom.updateMany({
      where: { id: { in: toDeactivateIds } },
      data: { isActive: false, isDefault: false },
    });
  }

  const toReactivateIds = existing
    .filter((row) => incomingUnitIds.has(row.unitId))
    .map((row) => row.id);
  if (toReactivateIds.length) {
    await db.productUom.updateMany({
      where: { id: { in: toReactivateIds } },
      data: { isActive: true, isDefault: false },
    });
  }

  const toCreate = symbols
    .map((symbol) => bySymbol.get(symbol)!)
    .filter((unit) => !existingByUnitId.has(unit.id))
    .map((unit) => ({
      id: uuidv7(),
      plantId,
      productId,
      unitId: unit.id,
      isActive: true,
      isDefault: unit.id === defaultUnitId,
    }));
  if (toCreate.length) {
    await db.productUom.createMany({ data: toCreate });
  }

  // Ensure exactly one default among active rows (createMany may already have set it for new rows).
  await db.productUom.updateMany({
    where: { plantId, productId, isDefault: true, unitId: { not: defaultUnitId } },
    data: { isDefault: false },
  });
  await db.productUom.updateMany({
    where: { plantId, productId, unitId: defaultUnitId },
    data: { isActive: true, isDefault: true },
  });

  return listProductAllowedUoms(db, productId, plantId);
}

export async function listProductAllowedUoms(db: Db, productId: string, plantId: string) {
  return db.productUom.findMany({
    where: { plantId, productId, isActive: true, unit: { isActive: true } },
    include: {
      unit: { select: { id: true, name: true, symbol: true, unitType: true, isActive: true } },
    },
    orderBy: [{ isDefault: "desc" }, { unit: { symbol: "asc" } }],
  });
}

/** Apply the same symbol set to every active product sharing this SKU (universal catalog). */
export async function syncAllowedUomsBySku(
  db: Db,
  sku: string,
  symbols: string[],
  defaultSymbol: string,
) {
  const normalizedSymbols = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!normalizedSymbols.length) {
    throw new AppError(400, "VALIDATION", "Select at least one allowed UOM.");
  }

  const products = await db.product.findMany({
    where: { sku: { equals: sku, mode: "insensitive" }, isActive: true },
    select: { id: true, plantId: true },
  });
  if (!products.length) return;

  const plantIds = [...new Set(products.map((p) => p.plantId))];
  const [units, existingRows] = await Promise.all([
    db.unitOfMeasure.findMany({
      where: { plantId: { in: plantIds }, isActive: true, symbol: { in: normalizedSymbols } },
      select: { id: true, symbol: true, plantId: true },
    }),
    db.productUom.findMany({
      where: { productId: { in: products.map((p) => p.id) } },
      select: { id: true, productId: true, plantId: true, unitId: true, isActive: true, isDefault: true },
    }),
  ]);

  const unitsByPlant = new Map<string, Map<string, { id: string; symbol: string }>>();
  for (const unit of units) {
    const symbol = unit.symbol.toUpperCase();
    let map = unitsByPlant.get(unit.plantId);
    if (!map) {
      map = new Map();
      unitsByPlant.set(unit.plantId, map);
    }
    map.set(symbol, { id: unit.id, symbol });
  }

  const existingByProduct = new Map<string, ExistingUomRow[]>();
  for (const row of existingRows) {
    const list = existingByProduct.get(row.productId) ?? [];
    list.push(row);
    existingByProduct.set(row.productId, list);
  }

  for (const product of products) {
    await setProductAllowedUoms(
      db,
      product.id,
      product.plantId,
      { symbols: normalizedSymbols, defaultSymbol },
      {
        unitsBySymbol: unitsByPlant.get(product.plantId) ?? new Map(),
        existing: existingByProduct.get(product.id) ?? [],
      },
    );
  }
}
