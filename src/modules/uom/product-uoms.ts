import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { uuidv7 } from "@/lib/ids";

type Db = PrismaClient | Prisma.TransactionClient;

export type ProductUomMappingInput = {
  symbols: string[];
  defaultSymbol?: string | null;
};

/**
 * Replace active allowed UOMs for a product. Symbols resolve within the product's plant.
 * Default falls back to the first symbol when omitted / invalid.
 */
export async function setProductAllowedUoms(
  db: Db,
  productId: string,
  plantId: string,
  input: ProductUomMappingInput,
) {
  const symbols = [...new Set(input.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!symbols.length) {
    throw new AppError(400, "VALIDATION", "Select at least one allowed UOM.");
  }

  const units = await db.unitOfMeasure.findMany({
    where: { plantId, isActive: true, symbol: { in: symbols } },
  });
  if (units.length !== symbols.length) {
    const found = new Set(units.map((u) => u.symbol.toUpperCase()));
    const missing = symbols.filter((s) => !found.has(s));
    throw new AppError(400, "VALIDATION", `Unknown or inactive UOM(s): ${missing.join(", ")}.`);
  }

  const bySymbol = new Map(units.map((u) => [u.symbol.toUpperCase(), u]));
  const defaultSymbol =
    (input.defaultSymbol?.trim().toUpperCase() && bySymbol.has(input.defaultSymbol.trim().toUpperCase())
      ? input.defaultSymbol.trim().toUpperCase()
      : symbols[0])!;

  const existing = await db.productUom.findMany({
    where: { plantId, productId },
  });
  const incomingUnitIds = new Set(units.map((u) => u.id));

  await db.productUom.updateMany({
    where: { plantId, productId, isDefault: true },
    data: { isDefault: false },
  });

  for (const row of existing) {
    if (!incomingUnitIds.has(row.unitId)) {
      await db.productUom.update({
        where: { id: row.id },
        data: { isActive: false, isDefault: false },
      });
    }
  }

  for (const symbol of symbols) {
    const unit = bySymbol.get(symbol)!;
    const isDefault = symbol === defaultSymbol;
    const found = existing.find((row) => row.unitId === unit.id);
    if (found) {
      await db.productUom.update({
        where: { id: found.id },
        data: { isActive: true, isDefault },
      });
    } else {
      await db.productUom.create({
        data: {
          id: uuidv7(),
          plantId,
          productId,
          unitId: unit.id,
          isActive: true,
          isDefault,
        },
      });
    }
  }

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
  const products = await db.product.findMany({
    where: { sku: { equals: sku, mode: "insensitive" }, isActive: true },
    select: { id: true, plantId: true },
  });
  for (const product of products) {
    await setProductAllowedUoms(db, product.id, product.plantId, {
      symbols,
      defaultSymbol,
    });
  }
}
