import { notFound } from "next/navigation";
import { ProductCreateForm } from "@/components/master-forms";
import { DeskFormPage } from "@/components/desk";
import { requirePage, plantIdsForSession } from "@/lib/access";
import { inferBusinessKindForProduct } from "@/lib/domain/business-categories";
import { getCatalogProduct, listDistinctUnits } from "@/modules/masters/product-catalog";
import {
  listCompatibleGradesForProduct,
  listCompatibleFinishesForProduct,
  listAllGrades,
  listAllFinishes,
} from "@/modules/masters/grades-finishes";

export default async function EditCatalogProductPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePage("plant.manage");
  const { id } = await params;
  // plantIdsForSession expands to all plants for admins / plant managers.
  const plantIds = await plantIdsForSession(session);
  const [product, units, compatibleGrades, compatibleFinishes, allGrades, allFinishes] = await Promise.all([
    getCatalogProduct(id, plantIds),
    listDistinctUnits(),
    listCompatibleGradesForProduct(id, plantIds),
    listCompatibleFinishesForProduct(id, plantIds),
    listAllGrades({ plantIds, activeOnly: true }),
    listAllFinishes({ plantIds, activeOnly: true }),
  ]);
  if (!product) notFound();
  const editableId = product.id;
  const kind = inferBusinessKindForProduct({
    sku: product.sku,
    name: product.name,
    productType: product.productType,
    supplyMode: product.supplyMode,
    category: product.category,
  });

  const initialGrades = compatibleGrades.length ? compatibleGrades : allGrades;
  const initialFinishes = compatibleFinishes.length ? compatibleFinishes : allFinishes;
  const defaultAttrs = (product.variants[0]?.attributes ?? {}) as Record<string, string>;

  return (
    <DeskFormPage
      title="Edit product"
      detail={product.sku}
      backHref={`/products/catalog/${editableId}`}
      backLabel="Back to product"
    >
      <ProductCreateForm
        productId={editableId}
        units={units.map((row) => ({ symbol: row.symbol, name: row.name }))}
        initialGrades={initialGrades.map((g) => ({ id: g.id, name: g.name }))}
        initialFinishes={initialFinishes.map((f) => ({ id: f.id, name: f.name }))}
        initial={{
          businessKind: kind,
          name: product.name,
          sku: product.sku,
          specs: defaultAttrs,
          baseUnitSymbol: product.baseUnit?.symbol ?? units[0]?.symbol ?? "",
          allowedUomSymbols: product.allowedUoms?.length
            ? product.allowedUoms.map((row) => row.unit.symbol)
            : product.baseUnit?.symbol
              ? [product.baseUnit.symbol]
              : [],
          gstPercent: Number(product.gstPercent) === 5 ? "5" : "18",
          description: product.description ?? "",
        }}
      />
    </DeskFormPage>
  );
}
