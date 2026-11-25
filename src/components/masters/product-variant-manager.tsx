"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { usePost } from "@/components/use-post";
import { toast } from "@/components/toast";
import { CreatableSpecSelect } from "@/components/ui/creatable-spec-select";
import {
  FIRST_CLASS_VARIANT_SPEC_KEYS,
  descriptiveProductFields,
  fieldIsVisible,
  isFirstClassVariantSpecKey,
  pricingProductFields,
  resolveProductFieldConfig,
  type ProductSpecField,
} from "@/lib/domain/product-spec-fields";

function normalizePriceText(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const num = Number(trimmed);
  // Match Decimal(18,2) storage so "20" and "20.00" compare equal.
  return Number.isFinite(num) ? num.toFixed(2) : trimmed;
}

/** Internal denormalized rate key persisted on variant.attributes — not a user-facing spec. */
const INTERNAL_ATTR_KEYS = new Set(["catalogSellingPrice"]);

type Variant = {
  id: string; sku: string; displayName: string | null; grade: string | null; finish: string | null;
  thicknessMm: string | null; widthMm: string | null; lengthMm: string | null; diameterMm: string | null;
  isActive: boolean; unit: { symbol: string } | null;
  sellingPrice: string | null;
  attributes: Record<string, unknown>;
};

type OptionItem = { id: string; name: string };

const FIRST_CLASS_SET = new Set<string>(FIRST_CLASS_VARIANT_SPEC_KEYS);

function attrString(attributes: Record<string, unknown>, key: string) {
  const value = attributes[key];
  if (value == null || typeof value === "object") return "";
  return String(value);
}

function draftFromVariant(variant: Variant, units: string[]): Record<string, string> {
  const draft: Record<string, string> = {
    displayName: variant.displayName ?? "",
    grade: variant.grade ?? "",
    finish: variant.finish ?? "",
    thickness: variant.thicknessMm ?? "",
    width: variant.widthMm ?? "",
    length: variant.lengthMm ?? "",
    diameter: variant.diameterMm ?? "",
    uom: variant.unit?.symbol ?? units[0] ?? "",
    sellingPrice: variant.sellingPrice ?? "",
  };
  for (const [key, value] of Object.entries(variant.attributes)) {
    if (FIRST_CLASS_SET.has(key) || INTERNAL_ATTR_KEYS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number") {
      draft[key] = String(value);
    }
  }
  return draft;
}

export function ProductVariantManager({
  productId,
  productName,
  productSku,
  variants,
  units,
  compatibleGrades: initialGrades = [],
  compatibleFinishes: initialFinishes = [],
}: {
  productId: string;
  productName?: string;
  productSku?: string;
  variants: Variant[];
  units: string[];
  compatibleGrades?: OptionItem[];
  compatibleFinishes?: OptionItem[];
}) {
  const router = useRouter();
  const { post, pending, error } = usePost();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [extraSpecs, setExtraSpecs] = useState("");
  const [search, setSearch] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [rows, setRows] = useState<Variant[]>(variants);
  // Survives stale RSC refresh: keep the rate the user just saved until the server agrees.
  // Keys are variant id and `sku:<SKU>` so twin remaps still hold the locked rate.
  const priceLockRef = useRef<Map<string, string | null>>(new Map());

  const lockPrice = (keys: Array<string | null | undefined>, price: string | null) => {
    for (const key of keys) {
      if (!key) continue;
      priceLockRef.current.set(key, price);
    }
  };

  useEffect(() => {
    setRows(() =>
      variants.map((row) => {
        const lockKey = priceLockRef.current.has(row.id)
          ? row.id
          : row.sku && priceLockRef.current.has(`sku:${row.sku}`)
            ? `sku:${row.sku}`
            : null;
        if (!lockKey) return row;
        const locked = priceLockRef.current.get(lockKey);
        if (locked === undefined) return row;
        if (normalizePriceText(row.sellingPrice) === normalizePriceText(locked)) {
          priceLockRef.current.delete(row.id);
          if (row.sku) priceLockRef.current.delete(`sku:${row.sku}`);
          return row;
        }
        // Server still stale (cache / twin lag) — keep the value the user saved.
        return { ...row, sellingPrice: locked };
      }),
    );
  }, [variants]);

  const [grades, setGrades] = useState<OptionItem[]>(initialGrades);
  const [finishes, setFinishes] = useState<OptionItem[]>(initialFinishes);

  const [modalType, setModalType] = useState<"grade" | "finish" | null>(null);
  const [quickName, setQuickName] = useState("");
  const [quickDesc, setQuickDesc] = useState("");
  const [quickError, setQuickError] = useState("");
  const [quickPending, setQuickPending] = useState(false);

  const config = useMemo(
    () => resolveProductFieldConfig({ sku: productSku, name: productName }),
    [productSku, productName],
  );

  const draftSpecs = useMemo(() => {
    const specs: Record<string, string> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (["displayName", "uom", "sellingPrice"].includes(key)) continue;
      if (value?.trim()) specs[key] = value.trim();
    }
    return specs;
  }, [draft]);

  const pricingFields = config ? pricingProductFields(config, draftSpecs) : [];
  const noteFields = config ? descriptiveProductFields(config, draftSpecs) : [];
  const configuredKeys = new Set(
    config?.fields.map((field) => field.key) ?? [],
  );

  const visibleVariants = rows.filter((variant) =>
    `${variant.sku} ${variant.displayName ?? ""} ${variant.grade ?? ""} ${variant.finish ?? ""} ${variant.thicknessMm ?? ""} ${variant.widthMm ?? ""} ${variant.lengthMm ?? ""} ${variant.diameterMm ?? ""} ${Object.values(variant.attributes).join(" ")}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  const blank = (): Record<string, string> => ({
    displayName: "",
    grade: "",
    finish: "",
    thickness: "",
    width: "",
    length: "",
    diameter: "",
    uom: units[0] ?? "",
    sellingPrice: "",
  });

  const begin = (variant?: Variant) => {
    setEditing(variant?.id ?? "new");
    setLocalError(null);
    if (variant) {
      const next = draftFromVariant(variant, units);
      setDraft(next);
      const known = new Set([
        ...FIRST_CLASS_VARIANT_SPEC_KEYS,
        ...(config?.fields.map((field) => field.key) ?? []),
      ]);
      setExtraSpecs(
        Object.entries(variant.attributes)
          .filter(
            ([key, value]) =>
              !known.has(key) &&
              !INTERNAL_ATTR_KEYS.has(key) &&
              (typeof value === "string" || typeof value === "number"),
          )
          .map(([key, value]) => `${key}=${String(value)}`)
          .join("\n"),
      );
    } else {
      setDraft(blank());
      setExtraSpecs("");
    }
  };

  const setDraftField = (key: string, value: string) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      if (config?.id === "sheet" && key === "finish" && !/pvd|mirror|matt/i.test(value)) {
        delete next.decorativeSubtype;
      }
      if (config?.id === "wire" && key === "productForm" && !/cut/i.test(value)) {
        delete next.cutLengthMm;
      }
      return next;
    });
  };

  const handleQuickAdd = async () => {
    setQuickError("");
    if (!quickName.trim()) {
      setQuickError(`${modalType === "grade" ? "Grade" : "Finish"} name is required.`);
      return;
    }
    setQuickPending(true);
    try {
      if (modalType === "grade") {
        const res = await post<{ grade: { id: string; name: string } }>(
          "/api/v1/masters/grades",
          { productId, name: quickName.trim(), description: quickDesc.trim() || undefined },
          { silent: true, successMessage: "Grade added and associated." }
        );
        if (res?.grade) {
          setGrades((prev) => (prev.some((g) => g.id === res.grade.id) ? prev : [...prev, { id: res.grade.id, name: res.grade.name }]));
          setDraftField("grade", res.grade.name);
          setModalType(null);
          setQuickName("");
          setQuickDesc("");
        }
      } else if (modalType === "finish") {
        const res = await post<{ finish: { id: string; name: string } }>(
          "/api/v1/masters/finishes",
          { productId, name: quickName.trim(), description: quickDesc.trim() || undefined },
          { silent: true, successMessage: "Finish added and associated." }
        );
        if (res?.finish) {
          setFinishes((prev) => (prev.some((f) => f.id === res.finish.id) ? prev : [...prev, { id: res.finish.id, name: res.finish.name }]));
          setDraftField("finish", res.finish.name);
          setModalType(null);
          setQuickName("");
          setQuickDesc("");
        }
      }
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : "Failed to add.");
    } finally {
      setQuickPending(false);
    }
  };

  const optionsForField = (field: ProductSpecField) => {
    if (field.key === "grade") return grades.map((g) => g.name);
    if (field.key === "finish") return finishes.map((f) => f.name);
    const fromVariants = rows.flatMap((variant) => {
      if (isFirstClassVariantSpecKey(field.key)) {
        const map: Record<string, string | null> = {
          grade: variant.grade,
          finish: variant.finish,
          thickness: variant.thicknessMm,
          width: variant.widthMm,
          length: variant.lengthMm,
          diameter: variant.diameterMm,
        };
        const value = map[field.key];
        return value ? [value] : [];
      }
      const value = attrString(variant.attributes, field.key);
      return value ? [value] : [];
    });
    return Array.from(new Set(fromVariants));
  };

  const save = async (id?: string) => {
    setLocalError(null);
    const attributes: Record<string, string> = {};

    for (const field of [...pricingFields, ...noteFields]) {
      if (isFirstClassVariantSpecKey(field.key)) continue;
      const value = (draft[field.key] ?? "").trim();
      if (value) attributes[field.key] = value;
    }

    for (const entry of extraSpecs.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const split = entry.indexOf("=");
      if (split < 1) {
        setLocalError("Enter additional specifications as field=value, one per line.");
        return;
      }
      const key = entry.slice(0, split).trim();
      const value = entry.slice(split + 1).trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || !value || key in attributes) {
        setLocalError("Specification names must be unique and use letters, numbers, and underscores.");
        return;
      }
      if (configuredKeys.has(key) || FIRST_CLASS_SET.has(key) || INTERNAL_ATTR_KEYS.has(key)) continue;
      attributes[key] = value;
    }

    const sellingPrice = (draft.sellingPrice ?? "").trim();
    const payload = {
      ...(id ? { id } : {}),
      displayName: draft.displayName ?? "",
      grade: draft.grade ?? "",
      finish: draft.finish ?? "",
      thickness: draft.thickness ?? "",
      width: draft.width ?? "",
      length: draft.length ?? "",
      diameter: draft.diameter ?? "",
      uom: draft.uom ?? "",
      sellingPrice,
      attributes,
    };

    const result = await post<{
      id?: string;
      displayName?: string;
      isActive?: boolean;
      sellingPrice?: string | null;
      sku?: string;
    }>(`/api/v1/masters/catalog-products/${productId}/variants`, payload, {
      successMessage: id ? "Variant price/specs saved." : "Variant added.",
    });
    if (!result?.id) {
      // Keep modal open; usePost already toasted the API error.
      return;
    }

    // Prefer the DB-verified rate from the API; fall back to what the user typed.
    const nextPrice =
      result.sellingPrice != null && String(result.sellingPrice).trim() !== ""
        ? String(result.sellingPrice)
        : sellingPrice || null;
    if (sellingPrice && normalizePriceText(nextPrice) !== normalizePriceText(sellingPrice)) {
      setLocalError(
        `Saved rate came back as ₹${nextPrice ?? "blank"} instead of ₹${sellingPrice}. Try save again.`,
      );
      return;
    }
    const edited = id ? rows.find((row) => row.id === id) : undefined;
    lockPrice(
      [id, result.id, edited?.sku ? `sku:${edited.sku}` : null, result.sku ? `sku:${result.sku}` : null],
      nextPrice,
    );
    if (id) {
      setRows((prev) =>
        prev.map((row) =>
          row.id === id || row.id === result.id
            ? {
                ...row,
                id: result.id ?? row.id,
                displayName: result.displayName ?? draft.displayName ?? row.displayName,
                grade: draft.grade || null,
                finish: draft.finish || null,
                thicknessMm: draft.thickness || null,
                widthMm: draft.width || null,
                lengthMm: draft.length || null,
                diameterMm: draft.diameter || null,
                unit: draft.uom ? { symbol: draft.uom } : row.unit,
                sellingPrice: nextPrice,
                attributes: { ...row.attributes, ...attributes },
                isActive: result.isActive ?? row.isActive,
              }
            : row,
        ),
      );
    } else {
      setRows((prev) => [
        ...prev,
        {
          id: result.id!,
          sku: result.sku ?? "—",
          displayName: result.displayName ?? draft.displayName ?? null,
          grade: draft.grade || null,
          finish: draft.finish || null,
          thicknessMm: draft.thickness || null,
          widthMm: draft.width || null,
          lengthMm: draft.length || null,
          diameterMm: draft.diameter || null,
          isActive: result.isActive ?? true,
          unit: draft.uom ? { symbol: draft.uom } : null,
          sellingPrice: nextPrice,
          attributes,
        },
      ]);
    }
    setEditing(null);
    toast.success(
      nextPrice
        ? `Rate saved: ₹${nextPrice}/${draft.uom || "UOM"}`
        : "Variant saved (rate pending).",
    );
    // usePost already calls router.refresh() — avoid a second full RSC refetch.
  };

  const deactivate = async (variant: Variant) => {
    const known = new Set([
      ...FIRST_CLASS_VARIANT_SPEC_KEYS,
      ...(config?.fields.map((field) => field.key) ?? []),
    ]);
    const attributes = Object.fromEntries(
      Object.entries(variant.attributes)
        .filter(
          ([key, value]) =>
            !FIRST_CLASS_SET.has(key) &&
            (typeof value === "string" || typeof value === "number"),
        )
        .map(([key, value]) => [key, String(value)]),
    );
    const result = await post<{ id?: string; isActive?: boolean; sellingPrice?: string | null }>(
      `/api/v1/masters/catalog-products/${productId}/variants`,
      {
        id: variant.id,
        isActive: !variant.isActive,
        displayName: variant.displayName ?? "",
        grade: variant.grade ?? "",
        finish: variant.finish ?? "",
        thickness: variant.thicknessMm ?? "",
        width: variant.widthMm ?? "",
        length: variant.lengthMm ?? "",
        diameter: variant.diameterMm ?? "",
        uom: variant.unit?.symbol ?? units[0] ?? "",
        // Preserve existing catalog rate — do not send blank and wipe sellingPrice.
        ...(variant.sellingPrice?.trim() ? { sellingPrice: variant.sellingPrice.trim() } : {}),
        attributes: {
          ...attributes,
          ...Object.fromEntries(
            Object.entries(variant.attributes)
              .filter(
                ([key, value]) =>
                  known.has(key) &&
                  !FIRST_CLASS_SET.has(key) &&
                  (typeof value === "string" || typeof value === "number"),
              )
              .map(([key, value]) => [key, String(value)]),
          ),
        },
      },
      {
        silent: true,
        successMessage: variant.isActive ? "Variant deactivated." : "Variant activated.",
      },
    );
    if (!result) return;
    setRows((prev) =>
      prev.map((row) =>
        row.id === variant.id
          ? {
              ...row,
              isActive: result.isActive ?? !variant.isActive,
              sellingPrice:
                result.sellingPrice !== undefined ? result.sellingPrice : row.sellingPrice,
            }
          : row,
      ),
    );
    router.refresh();
  };

  const inputClass = "h-10 w-full rounded-lg border border-border bg-card px-3 text-sm";

  const renderSpecField = (field: ProductSpecField) => {
    const unitSuffix = field.unit ? ` (${field.unit})` : "";
    const label = `${field.label}${unitSuffix}${field.pricing === false ? "" : ""}`;
    const value = draft[field.key] ?? "";

    if (field.type === "select" || field.key === "grade" || field.key === "finish") {
      return (
        <label key={field.key} className="text-xs font-medium text-muted">
          {label}
          {field.pricing !== false ? (
            <span className="ml-1 rounded bg-muted/40 px-1 py-0.5 text-[10px] uppercase tracking-wide">Pricing</span>
          ) : (
            <span className="ml-1 rounded bg-muted/20 px-1 py-0.5 text-[10px] uppercase tracking-wide">Note</span>
          )}
          <CreatableSpecSelect
            fieldName={field.key}
            fieldLabel={field.label}
            unit={field.unit}
            value={value}
            onChange={(val) => setDraftField(field.key, val)}
            options={optionsForField(field)}
            productId={productId}
            placeholder={`Select or add ${field.label.toLowerCase()}…`}
            className="mt-1"
          />
        </label>
      );
    }

    return (
      <label key={field.key} className="text-xs font-medium text-muted">
        {label}
        {field.pricing !== false ? (
          <span className="ml-1 rounded bg-muted/40 px-1 py-0.5 text-[10px] uppercase tracking-wide">Pricing</span>
        ) : null}
        <input
          className={`${inputClass} mt-1`}
          inputMode={field.type === "number" ? "decimal" : undefined}
          value={value}
          onChange={(event) => setDraftField(field.key, event.target.value)}
          placeholder={field.placeholder ?? (field.unit ? `e.g. value in ${field.unit}` : undefined)}
        />
      </label>
    );
  };

  const fallbackFields: ProductSpecField[] = [
    { key: "grade", label: "Grade", type: "select", pricing: true },
    { key: "finish", label: "Finish", type: "select", pricing: true },
    { key: "thickness", label: "Thickness", type: "select", unit: "mm", pricing: true },
    { key: "diameter", label: "Diameter", type: "select", unit: "mm", pricing: true },
    { key: "width", label: "Width", type: "select", unit: "mm", pricing: true },
    { key: "length", label: "Length", type: "select", unit: "mm", pricing: true },
  ];

  const editorFields = config
    ? [...pricingFields, ...noteFields.filter((field) => fieldIsVisible(field, draftSpecs))]
    : fallbackFields;

  const editorCard = (id?: string) => (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="variant-editor-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) setEditing(null);
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h3 id="variant-editor-title" className="text-lg font-semibold text-[var(--ink)]">
              {id ? "Edit variant" : "Add variant"}
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              {config
                ? `Set pricing specs and catalog rate for this ${config.id.replaceAll("_", " ")} combination.`
                : "Set pricing specs and catalog rate for this specification combination."}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-muted/40 hover:text-foreground"
            onClick={() => setEditing(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 sm:px-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs font-medium text-muted sm:col-span-2 lg:col-span-3">
              Display name (optional)
              <input
                className={`${inputClass} mt-1`}
                value={draft.displayName ?? ""}
                onChange={(e) => setDraftField("displayName", e.target.value)}
                placeholder="Auto-generated if empty"
              />
            </label>

            {editorFields.map(renderSpecField)}

            <label className="text-xs font-medium text-muted">
              Rate unit (UOM)
              <select
                className={`${inputClass} mt-1`}
                value={draft.uom ?? ""}
                onChange={(event) => setDraftField("uom", event.target.value)}
              >
                {units.map((unit) => (
                  <option key={unit}>{unit}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-muted sm:col-span-2">
              Selling rate (₹ / {draft.uom || "UOM"})
              <input
                className={`${inputClass} mt-1`}
                inputMode="decimal"
                value={draft.sellingPrice ?? ""}
                onChange={(event) => setDraftField("sellingPrice", event.target.value)}
                placeholder="Leave blank if rate pending"
              />
              <span className="mt-1 block font-normal">
                Catalog list rate for this exact pricing combination. Blank = rate pending (not inherited).
              </span>
            </label>
            <label className="text-xs font-medium text-muted sm:col-span-2 lg:col-span-3">
              Additional non-pricing attributes
              <textarea
                className="mt-1 min-h-20 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
                value={extraSpecs}
                onChange={(event) => setExtraSpecs(event.target.value)}
                placeholder={"capacityLitres=2.5\nmaterialFamily=stainless steel"}
              />
              <span className="mt-1 block font-normal">
                Optional extras as field=value (one per line). Family pricing fields above are saved separately.
              </span>
            </label>
          </div>
          {localError || error ? (
            <p className="mt-3 text-sm text-danger">{localError || error}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4 sm:px-6">
          <button type="button" className="btn-secondary h-10 px-4" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            className="btn-primary h-10 px-4"
            onClick={() => void save(id)}
          >
            {pending ? "Saving…" : id ? "Save variant" : "Add variant"}
          </button>
        </div>
      </div>
    </div>
  );

  const pricingColumns = config
    ? config.fields.filter((field) => field.pricing !== false).slice(0, 6)
    : fallbackFields;

  const renderCell = (variant: Variant, key: string) => {
    if (key === "grade") {
      return variant.grade ? (
        <span className="font-medium text-sky-700 dark:text-sky-400">{variant.grade}</span>
      ) : (
        "—"
      );
    }
    if (key === "finish") {
      return variant.finish ? (
        <span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-[var(--ink)]">
          {variant.finish}
        </span>
      ) : (
        "—"
      );
    }
    if (key === "thickness") return variant.thicknessMm ? `${variant.thicknessMm} mm` : "—";
    if (key === "width") return variant.widthMm ? `${variant.widthMm} mm` : "—";
    if (key === "length") return variant.lengthMm ? `${variant.lengthMm} mm` : "—";
    if (key === "diameter") return variant.diameterMm ? `${variant.diameterMm} mm` : "—";
    const raw = attrString(variant.attributes, key);
    return raw || "—";
  };

  return (
    <section className="rounded-2xl border border-border bg-[var(--surface)] p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-[var(--ink)]">Product variants / specifications</h2>
            <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
              {rows.length}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            {config
              ? `Pricing combination for ${config.id.replaceAll("_", " ")}: ${pricingColumns.map((f) => f.label).join(", ")}`
              : "Set sellable specification combinations and their catalog rates."}
          </p>
        </div>
        <button
          type="button"
          className="btn-primary inline-flex h-9 items-center gap-1.5 px-3 text-sm"
          onClick={() => begin()}
        >
          <Plus className="size-4" strokeWidth={2} aria-hidden />
          Add variant
        </button>
      </div>

      {rows.length ? (
        <>
          <div className="relative mb-3 max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <input
              className="h-10 w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search variant specifications"
              aria-label="Search variants"
            />
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-[var(--surface-muted)] text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
                <tr>
                  <th className="px-3 py-2.5">Name</th>
                  <th className="px-3 py-2.5">SKU</th>
                  {pricingColumns.map((field) => (
                    <th key={field.key} className="px-3 py-2.5">
                      {field.label}
                    </th>
                  ))}
                  <th className="px-3 py-2.5">UOM</th>
                  <th className="px-3 py-2.5">Price</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleVariants.map((variant) => {
                  const cleanName = variant.displayName?.includes(" · ")
                    ? variant.displayName.split(" · ")[0].trim()
                    : (variant.displayName?.trim() || productName || "—");
                  const hasPrice = Boolean(variant.sellingPrice?.trim());

                  return (
                    <tr
                      key={variant.id}
                      className="border-t border-border/80 transition-colors hover:bg-muted/20"
                    >
                      <td className="px-3 py-3 font-medium text-[var(--ink)]">{cleanName}</td>
                      <td className="px-3 py-3 font-mono text-[11px] text-muted whitespace-nowrap">
                        {variant.sku}
                      </td>
                      {pricingColumns.map((field) => (
                        <td key={field.key} className="px-3 py-3 whitespace-nowrap">
                          {renderCell(variant, field.key)}
                        </td>
                      ))}
                      <td className="px-3 py-3 text-[var(--ink)]">{variant.unit?.symbol || "—"}</td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {hasPrice ? (
                          <span className="font-semibold tabular-nums text-[var(--ink)]">
                            ₹{variant.sellingPrice}/{variant.unit?.symbol || "UOM"}
                          </span>
                        ) : (
                          <span className="inline-flex rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                            Rate pending
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            variant.isActive
                              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {variant.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right">
                        <button
                          type="button"
                          className="mr-3 font-medium text-sky-700 hover:underline dark:text-sky-400"
                          onClick={() => begin(variant)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          className="text-muted hover:text-danger hover:underline"
                          onClick={() => void deactivate(variant)}
                        >
                          {variant.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!visibleVariants.length ? (
              <p className="p-4 text-sm text-muted">No variants match this search.</p>
            ) : null}
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-muted/10 px-5 py-8 text-center">
          <p className="text-sm text-muted">
            No variants yet. Add a sellable specification combination and its catalog rate.
          </p>
          <button
            type="button"
            className="btn-primary mt-4 inline-flex h-9 items-center gap-1.5 px-3 text-sm"
            onClick={() => begin()}
          >
            <Plus className="size-4" strokeWidth={2} aria-hidden />
            Add variant
          </button>
        </div>
      )}
      {editing === "new" ? editorCard() : null}
      {editing && editing !== "new" ? editorCard(editing) : null}

      {modalType ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl space-y-4">
            <h3 className="text-lg font-semibold text-[var(--ink)]">
              {modalType === "grade" ? "Add New Grade" : "Add New Finish"}
            </h3>
            <p className="text-xs text-muted">
              Creates a permanent {modalType} in the master catalog and associates it with this product. If it already exists, the record is safely reused.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-[var(--ink)]">
                  {modalType === "grade" ? "Grade Name *" : "Finish Name *"}
                </label>
                <input
                  className={`${inputClass} mt-1`}
                  placeholder={modalType === "grade" ? "e.g. SS 304, SS 316L, SS 202" : "e.g. 2B, BA, No. 4, Mirror"}
                  value={quickName}
                  onChange={(e) => setQuickName(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--ink)]">Description (optional)</label>
                <textarea
                  className="mt-1 min-h-20 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  placeholder="Specification details, standards…"
                  value={quickDesc}
                  onChange={(e) => setQuickDesc(e.target.value)}
                />
              </div>
            </div>
            {quickError ? <p className="text-xs text-danger">{quickError}</p> : null}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-secondary h-9 px-4 text-sm" onClick={() => setModalType(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={quickPending}
                className="btn-primary h-9 px-4 text-sm"
                onClick={() => void handleQuickAdd()}
              >
                {quickPending ? "Saving…" : "Save & Associate"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
