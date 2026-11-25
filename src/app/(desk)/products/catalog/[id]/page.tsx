import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, Pencil } from "lucide-react";
import { BusinessKindBadge } from "@/components/masters/business-kind-badge";
import { requirePage, plantIdsForSession } from "@/lib/access";
import { inferBusinessKindForProduct } from "@/lib/domain/business-categories";
import { getCatalogProduct, listDistinctUnits } from "@/modules/masters/product-catalog";
import { listCompatibleGradesForProduct, listCompatibleFinishesForProduct } from "@/modules/masters/grades-finishes";
import { ProductVariantManager } from "@/components/masters/product-variant-manager";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function catalogRateFromVariant(variant: {
  materialMaster?: { sellingPrice?: { toString(): string } | string | null } | null;
  attributes?: unknown;
}) {
  const materialRate =
    variant.materialMaster?.sellingPrice != null &&
    String(variant.materialMaster.sellingPrice).trim() !== ""
      ? String(variant.materialMaster.sellingPrice)
      : null;
  if (materialRate) return materialRate;
  const attrs =
    variant.attributes && typeof variant.attributes === "object" && !Array.isArray(variant.attributes)
      ? (variant.attributes as Record<string, unknown>)
      : null;
  const attrRate = attrs?.catalogSellingPrice;
  if (attrRate != null && String(attrRate).trim() !== "") return String(attrRate);
  return null;
}

function MetaLabel({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ink-muted)]">
      {children}
    </dt>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-[var(--surface-muted)] px-2 py-0.5 text-xs font-medium text-[var(--ink)]">
      {children}
    </span>
  );
}

export default async function CatalogProductPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePage("plant.manage");
  const { id } = await params;
  const plantIds = await plantIdsForSession(session);
  const [product, units, compatibleGrades, compatibleFinishes] = await Promise.all([
    getCatalogProduct(id, plantIds),
    listDistinctUnits(),
    listCompatibleGradesForProduct(id, plantIds),
    listCompatibleFinishesForProduct(id, plantIds),
  ]);
  if (!product) notFound();

  const businessKind = inferBusinessKindForProduct({
    sku: product.sku,
    name: product.name,
    productType: product.productType,
    supplyMode: product.supplyMode,
    category: product.category,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-1 pb-8">
      <div className="flex flex-wrap items-center gap-1 text-sm text-[var(--ink-muted)]">
        <Link href="/products?tab=products" className="hover:text-[var(--ink)] hover:underline">
          Products
        </Link>
        <ChevronRight className="size-3.5 opacity-60" aria-hidden />
        <span className="font-medium text-[var(--ink)]">{product.name}</span>
      </div>

      <section className="rounded-2xl border border-border bg-[var(--surface)] p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--ink)]">{product.name}</h1>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  product.isActive
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${product.isActive ? "bg-emerald-500" : "bg-muted-foreground"}`}
                />
                {product.isActive ? "Active" : "Inactive"}
              </span>
            </div>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">
              {product.sku} · {product.supplyMode} · {product.productType.replaceAll("_", " ")}
            </p>
          </div>
          <Link
            href={`/products/catalog/${product.id}/edit`}
            className="btn-secondary inline-flex h-9 items-center gap-1.5 px-3 text-sm"
          >
            <Pencil className="size-3.5" strokeWidth={1.8} aria-hidden />
            Edit product
          </Link>
        </div>

        <dl className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div>
            <MetaLabel>Business category</MetaLabel>
            <dd className="mt-1.5">
              <BusinessKindBadge kind={businessKind} />
            </dd>
          </div>
          <div>
            <MetaLabel>SKU / Product code</MetaLabel>
            <dd className="mt-1.5 font-mono text-sm font-medium text-[var(--ink)]">{product.sku}</dd>
          </div>
          <div>
            <MetaLabel>Subcategory</MetaLabel>
            <dd className="mt-1.5 text-sm font-medium text-[var(--ink)]">
              {product.category ? (
                <Link className="text-accent hover:underline" href={`/categories/${product.category.id}`}>
                  {product.category.name}
                </Link>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <MetaLabel>Base unit</MetaLabel>
            <dd className="mt-1.5 text-sm font-medium text-[var(--ink)]">
              {product.baseUnit?.symbol ?? "—"}
            </dd>
          </div>
          <div>
            <MetaLabel>GST</MetaLabel>
            <dd className="mt-1.5 text-sm font-medium text-[var(--ink)]">
              {Number(product.gstPercent) === 5 ? "5%" : "18%"}
            </dd>
          </div>
          <div>
            <MetaLabel>Status</MetaLabel>
            <dd className="mt-1.5 text-sm font-medium text-[var(--ink)]">
              {product.isActive ? "Active" : "Inactive"}
            </dd>
          </div>
        </dl>

        {product.description ? (
          <div className="mt-5 border-t border-border/70 pt-4">
            <MetaLabel>Description</MetaLabel>
            <p className="mt-1.5 text-sm text-[var(--ink)]">{product.description}</p>
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 border-t border-border/70 pt-4 sm:grid-cols-2">
          <div>
            <MetaLabel>Compatible material grades</MetaLabel>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {compatibleGrades.length ? (
                compatibleGrades.map((grade) => <Chip key={grade.id}>{grade.name}</Chip>)
              ) : (
                <span className="text-sm text-muted">No compatible grades configured</span>
              )}
            </div>
          </div>
          <div>
            <MetaLabel>Compatible surface finishes</MetaLabel>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {compatibleFinishes.length ? (
                compatibleFinishes.map((finish) => <Chip key={finish.id}>{finish.name}</Chip>)
              ) : (
                <span className="text-sm text-muted">No compatible finishes configured</span>
              )}
            </div>
          </div>
        </div>

      </section>

      <ProductVariantManager
        productId={product.id}
        productName={product.name}
        productSku={product.sku}
        units={units.map((unit) => unit.symbol)}
        compatibleGrades={compatibleGrades.map((g) => ({ id: g.id, name: g.name }))}
        compatibleFinishes={compatibleFinishes.map((f) => ({ id: f.id, name: f.name }))}
        variants={product.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          displayName: variant.displayName,
          grade: variant.grade,
          finish: variant.finish,
          thicknessMm: variant.thicknessMm?.toString() ?? null,
          widthMm: variant.widthMm?.toString() ?? null,
          lengthMm: variant.lengthMm?.toString() ?? null,
          diameterMm: variant.diameterMm?.toString() ?? null,
          isActive: variant.isActive,
          unit: variant.unit ? { symbol: variant.unit.symbol } : null,
          sellingPrice: catalogRateFromVariant(variant),
          attributes: (variant.attributes &&
          typeof variant.attributes === "object" &&
          !Array.isArray(variant.attributes)
            ? variant.attributes
            : {}) as Record<string, unknown>,
        }))}
      />
    </div>
  );
}
