import type { Prisma } from "@prisma/client";
import { prisma } from "@/db";

type Db = Prisma.TransactionClient | typeof prisma;

export async function materialAvailableQty(db: Db, plantId: string, materialId: string) {
  const map = await materialAvailableQtyMap(db, plantId, [materialId]);
  return map.get(materialId) ?? 0;
}

/** Single-pass stock totals for many materials (detail/convert dropdowns). */
export async function materialAvailableQtyMap(db: Db, plantId: string, materialIds: string[]) {
  const uniqueIds = [...new Set(materialIds.filter(Boolean))];
  const result = new Map<string, number>();
  for (const id of uniqueIds) result.set(id, 0);
  if (!uniqueIds.length) return result;

  const balances = await db.stockBalance.findMany({
    where: {
      plantId,
      batch: { plantId, materialId: { in: uniqueIds } },
    },
    select: {
      availableQty: true,
      batch: { select: { materialId: true } },
    },
  });

  for (const row of balances) {
    const materialId = row.batch.materialId;
    const prev = result.get(materialId) ?? 0;
    result.set(materialId, prev + Number(row.availableQty.toString()));
  }
  return result;
}

export type ConvertLinePlan = {
  leadItemId: string;
  quantity: number;
  uom: string;
  productId: string | null;
  availableQty: number;
  suggestedInStock: boolean;
  minOrderQty: number | null;
  belowMoq: boolean;
  mustProduce: boolean;
};

export async function buildConvertLinePlans(input: {
  plantId: string;
  lines: {
    leadItemId: string;
    quantity: { toString(): string };
    uom: string;
    productId: string | null;
    inStock: boolean | null;
    estimatedLeadTimeDays: number | null;
  }[];
  selectedProductIds: Record<string, string | undefined>;
  productMeta: Map<string, { minOrderQty: number | null }>;
}) {
  const productIds = input.lines
    .map((line) => input.selectedProductIds[line.leadItemId] ?? line.productId ?? null)
    .filter((id): id is string => Boolean(id));
  const stockByProduct = await materialAvailableQtyMap(prisma, input.plantId, productIds);

  const plans: ConvertLinePlan[] = [];
  for (const line of input.lines) {
    const productId = input.selectedProductIds[line.leadItemId] ?? line.productId ?? null;
    const qty = Number(line.quantity.toString());
    const availableQty = productId ? (stockByProduct.get(productId) ?? 0) : 0;
    const minOrderQty = productId ? (input.productMeta.get(productId)?.minOrderQty ?? null) : null;
    const suggestedInStock = productId ? availableQty >= qty && qty > 0 : false;
    const belowMoq = minOrderQty != null && qty > 0 && qty < minOrderQty;
    const mustProduce = line.inStock === false || (!suggestedInStock && line.inStock !== true);
    plans.push({
      leadItemId: line.leadItemId,
      quantity: qty,
      uom: line.uom,
      productId,
      availableQty,
      suggestedInStock,
      minOrderQty,
      belowMoq,
      mustProduce,
    });
  }
  return plans;
}
