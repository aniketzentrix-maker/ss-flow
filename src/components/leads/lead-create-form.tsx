"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Upload, X, FileText, Loader2 } from "lucide-react";
import { CreatableSpecSelect } from "@/components/ui/creatable-spec-select";
import { CustomerSearchSelect } from "@/components/leads/customer-search-select";
import { LeadThicknessField } from "@/components/leads/lead-thickness-field";
import { LeadWidthField } from "@/components/leads/lead-width-field";
import { LeadDimensionMmField } from "@/components/leads/lead-dimension-mm-field";
import { isInchConvertibleSpecKey } from "@/lib/domain/dimension-units";
import { toast } from "@/components/toast";
import {
  resolveProductFieldConfig,
  visibleProductFields,
  missingRequiredSpecFields,
  invalidNumericSpecFields,
  resolveExactPricedVariant,
  isProductComingSoon,
  isAllowedDesignFile,
  DESIGN_FILE_ACCEPT,
  DESIGN_FILE_MAX_COUNT,
  RATE_AMBIGUOUS_MESSAGE,
  RATE_CONFLICT_CODE,
  STALE_SPECIFICATION_CODE,
  activePricingMatchKeys,
  buildNormalizedPricingFingerprint,
} from "@/lib/domain/product-spec-fields";
import {
  useFieldArray,
  useForm,
  useWatch,
  type UseFormRegister,
  type UseFormSetValue,
  type Control,
} from "react-hook-form";
import { FormFeedback } from "@/components/form-feedback";
import { usePost } from "@/components/use-post";
import { deriveLeadOrderTypeFromBusinessCategories, LEAD_GRADE_OPTIONS } from "@/modules/leads/order-type";
import { estimateLeadItemWeightKg } from "@/modules/leads/estimate-item-weight";
import {
  LEAD_PRIORITIES,
  LEAD_SOURCES,
  leadPriorityLabel,
  leadSourceLabel,
} from "@/modules/leads/status";

/** Re-enable when manufacturing & commercial fields should show on lead create. */
const SHOW_LEAD_ITEM_MFG_COMMERCIAL = false;

const CUSTOMER_INPUT_SPEC_KEYS = new Set([
  "pvdColour",
  "dimensions",
  "requiredDimensions",
  "drawingReference",
  "designReference",
  "cutProfile",
  "wireGauge",
  "wireDiameterMm",
  "cutLengthMm",
  "finishOrCondition",
  "capacityLitres",
  "materialGrade",
  "thickness",
  "width",
  "length",
  "diameter",
  "finish",
  "packing",
]);
const NUMERIC_SPEC_KEYS = new Set([
  "thickness",
  "width",
  "length",
  "diameter",
  "weightPerPiece",
  "netWeightKg",
  "innerDiameter",
  "outerDiameter",
  "wireGauge",
  "height",
  "capacityLitres",
  "innerDiameterMm",
  "outerDiameterMm",
  "wireDiameterMm",
  "cutLengthMm",
]);
const CONFIGURABLE_SPEC_VALUE =
  /^(confirm|configure|customer specified|customer supplied|customer drawing|optional\b|per approved)/i;

function isCustomerInputSpecification(key: string, value: unknown) {
  return (
    CUSTOMER_INPUT_SPEC_KEYS.has(key) &&
    typeof value === "string" &&
    CONFIGURABLE_SPEC_VALUE.test(value.trim())
  );
}

type LeadItemValues = {
  categoryId: string;
  productId: string;
  parentProductId: string;
  productVariantId: string;
  specifications: Record<string, string>;
  size: string;
  quantity: string;
  uom: string;
  /** Catalog list rate for the matched variant (₹ per price UOM). */
  unitPrice: string;
  estimatedWeight: string;
  description: string;
  remarks: string;
  mfgGrade: string;
  gaugeThicknessMm: string;
  weightPerPieceGrams: string;
  finish: string;
  sizeOrCapacity: string;
  packing: string;
  logoRequired: boolean;
  artworkUrl: string;
  pricingBasis: "" | "PER_KG" | "PER_PIECE";
  requiredDeliveryDate: string;
  promisedDeliveryDate: string;
};

type FormValues = {
  queryDate: string;
  queryTime: string;
  contactPerson: string;
  contactDesignation: string;
  phone: string;
  email: string;
  address: string;
  companyName: string;
  gstin: string;
  customerId: string;
  source: (typeof LEAD_SOURCES)[number];
  priority: (typeof LEAD_PRIORITIES)[number];
  assigneeId: string;
  notes: string;
  items: LeadItemValues[];
  attendedById: string;
  result: "PENDING" | "SUCCESS" | "FAILURE";
  resultReason: string;
  officeRemarks: string;
};

const fieldClass =
  "h-11 w-full rounded-[10px] border border-border bg-card px-3 text-sm text-foreground outline-none transition placeholder:text-muted/70 focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/25";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function todayStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nowTime() {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function emptyItem(uom: string): LeadItemValues {
  return {
    categoryId: "",
    productId: "",
    parentProductId: "",
    productVariantId: "",
    specifications: {},
    size: "",
    quantity: "1",
    uom,
    unitPrice: "",
    estimatedWeight: "",
    description: "",
    remarks: "",
    mfgGrade: "",
    gaugeThicknessMm: "",
    weightPerPieceGrams: "",
    finish: "",
    sizeOrCapacity: "",
    packing: "",
    logoRequired: false,
    artworkUrl: "",
    pricingBasis: "",
    requiredDeliveryDate: "",
    promisedDeliveryDate: "",
  };
}

function formatInr(value: number) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `₹${rounded.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

type LineAmountResult =
  | { amount: number; basis: "quantity" | "weight"; missing?: undefined }
  | { amount?: undefined; basis?: undefined; missing: string };

/**
 * Line amount from catalog unit rate + demand qty/UOM.
 * ₹/kg with kg demand → qty × rate; ₹/piece with pieces → qty × rate;
 * demand in pieces with ₹/kg rate → est. weight × rate (or explain what's missing).
 */
function leadLineAmount(
  unitPrice: string,
  quantity: string,
  demandUom: string,
  rateUom: string,
  estimatedWeightKg: string,
): LineAmountResult | null {
  const rate = Number(unitPrice);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const qty = Number(quantity);
  const demand = demandUom.trim().toUpperCase();
  const priceUnit = (rateUom || demandUom).trim().toUpperCase();
  const isKg = (symbol: string) => symbol === "KG" || symbol === "KGS";
  const isPiece = (symbol: string) =>
    ["PCS", "PC", "NOS", "NO", "PIECE", "PIECES"].includes(symbol);

  if (isKg(priceUnit)) {
    if (isKg(demand) && Number.isFinite(qty) && qty > 0) {
      return { amount: qty * rate, basis: "quantity" };
    }
    const weight = Number(estimatedWeightKg);
    if (Number.isFinite(weight) && weight > 0) {
      return { amount: weight * rate, basis: "weight" };
    }
    return {
      missing:
        "Amount ke liye estimated weight (kg) chahiye — dimensions / qty complete karke weight auto-calculate hone do.",
    };
  }

  if (isPiece(priceUnit) || !isKg(priceUnit)) {
    if (Number.isFinite(qty) && qty > 0) {
      return { amount: qty * rate, basis: "quantity" };
    }
    return { missing: "Amount ke liye demand quantity chahiye." };
  }

  return null;
}

function LeadField({
  label,
  required,
  detail,
  children,
  className = "",
}: {
  label: string;
  required?: boolean;
  detail?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[13px] font-medium text-muted">
        {label}
        {detail ? <span className="ml-1 text-xs font-normal text-muted/80">({detail})</span> : null}
        {required ? <span className="text-danger"> *</span> : null}
      </span>
      {children}
    </label>
  );
}

function SectionCard({
  step,
  title,
  detail,
  children,
}: {
  step: number;
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <header className="mb-5 flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-info text-sm font-semibold text-white">
          {step}
        </span>
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted">{detail}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

type UploadedDesignFile = {
  id: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  url: string;
};

function DesignFilesField({
  files,
  onChange,
  disabled,
}: {
  files: UploadedDesignFile[];
  onChange: (files: UploadedDesignFile[]) => void;
  disabled?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) return;
    const selected = Array.from(fileList);
    if (files.length + selected.length > DESIGN_FILE_MAX_COUNT) {
      toast.error(`You can attach up to ${DESIGN_FILE_MAX_COUNT} design files.`);
      event.target.value = "";
      return;
    }
    for (const f of selected) {
      if (!isAllowedDesignFile({ name: f.name, type: f.type, size: f.size })) {
        toast.error(`"${f.name}" is not supported. Upload PDF, DXF, DWG, PNG, JPG, or WebP up to 10MB.`);
        return;
      }
    }
    setUploading(true);
    try {
      const formData = new FormData();
      selected.forEach((f) => formData.append("files", f));
      const response = await fetch("/api/v1/leads/design-files", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.data?.files)) {
        throw new Error(data.error?.message || "Failed to upload design file");
      }
      const newFiles = [...files, ...(data.data?.files ?? [])];
      onChange(newFiles);
      toast.success("Design file uploaded successfully");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const removeFile = async (id: string) => {
    setRemovingId(id);
    try {
      const response = await fetch(`/api/v1/leads/design-files?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "Failed to remove design file");
      onChange(files.filter((f) => f.id !== id));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove design file");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label
          className={`inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium cursor-pointer hover:bg-muted/50 ${
            disabled || uploading ? "opacity-50 pointer-events-none" : ""
          }`}
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          ) : (
            <Upload className="h-3.5 w-3.5 text-muted" />
          )}
          <span>{uploading ? "Uploading..." : "Upload drawing (PDF, DXF, DWG, Image)"}</span>
          <input
            type="file"
            className="hidden"
            multiple
            accept={DESIGN_FILE_ACCEPT}
            onChange={handleUpload}
            disabled={disabled || uploading}
          />
        </label>
      </div>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {files.map((file) => (
            <div
              key={file.id}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
            >
              <FileText className="h-3.5 w-3.5 text-accent" />
              <a href={file.url} target="_blank" rel="noreferrer" className="max-w-[140px] truncate underline" title={file.originalName}>
                {file.originalName}
              </a>
              <span className="text-[10px] text-muted">
                ({(file.sizeBytes / 1024).toFixed(0)} KB)
              </span>
              <button
                type="button"
                onClick={() => void removeFile(file.id)}
                disabled={removingId === file.id || disabled}
                className="text-muted hover:text-danger ml-0.5"
                title="Remove file"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type LeadCatalogProduct = {
  id: string;
  name: string;
  sku: string;
  categoryId: string;
  categoryName: string;
  variants: {
    id: string;
    materialMasterId: string;
    sku: string;
    displayName: string;
    uom: string;
    sellingPrice?: string;
    specs: Record<string, unknown>;
  }[];
};

type RateEditorState = {
  mode: "create" | "set_price";
  fingerprint: string;
  specs: Record<string, string>;
  unitRate: string;
  conflictExistingRate?: string;
  saving: boolean;
  error?: string;
};

function LeadItemFields({
  index,
  register,
  control,
  setValue,
  canRemove,
  onRemove,
  categories,
  products,
  canManageProducts,
  onCatalogVariantApplied,
}: {
  index: number;
  register: UseFormRegister<FormValues>;
  control: Control<FormValues>;
  setValue: UseFormSetValue<FormValues>;
  canRemove: boolean;
  onRemove: () => void;
  categories: { id: string; name: string; code: string }[];
  products: LeadCatalogProduct[];
  canManageProducts: boolean;
  onCatalogVariantApplied: (
    productId: string,
    variant: LeadCatalogProduct["variants"][number],
    masters?: { grade?: { id: string; name: string }; finish?: { id: string; name: string } },
  ) => void;
}) {
  const categoryId = useWatch({ control, name: `items.${index}.categoryId` });
  const parentProductId = useWatch({
    control,
    name: `items.${index}.parentProductId`,
  });
  const selectedVariantId = useWatch({
    control,
    name: `items.${index}.productVariantId`,
  });
  const selectedSpecs =
    (useWatch({ control, name: `items.${index}.specifications` }) as Record<string, string>) ?? {};
  const uom = useWatch({ control, name: `items.${index}.uom` });
  const quantity = useWatch({ control, name: `items.${index}.quantity` }) ?? "";
  const unitPrice = useWatch({ control, name: `items.${index}.unitPrice` }) ?? "";
  const mfgGrade = useWatch({ control, name: `items.${index}.mfgGrade` }) ?? "";
  const itemRequiredDeliveryDate =
    useWatch({ control, name: `items.${index}.requiredDeliveryDate` }) ?? "";
  const itemPromisedDeliveryDate =
    useWatch({ control, name: `items.${index}.promisedDeliveryDate` }) ?? "";
  const isItemPromisedLate = Boolean(
    itemRequiredDeliveryDate &&
      itemPromisedDeliveryDate &&
      itemPromisedDeliveryDate > itemRequiredDeliveryDate,
  );
  const [allowedUoms, setAllowedUoms] = useState<
    { id: string; symbol: string; name: string; isDefault: boolean }[]
  >([]);
  const [uomsLoading, setUomsLoading] = useState(false);
  const [rateEditor, setRateEditor] = useState<RateEditorState | null>(null);

  const visibleProducts = products.filter(
    (product) => !categoryId || product.categoryId === categoryId,
  );
  const selectedParent = products.find(
    (product) => product.id === parentProductId,
  );
  const variants = selectedParent?.variants ?? [];
  const config = resolveProductFieldConfig(selectedParent);

  // Config-driven fields and validations
  const fields = config ? visibleProductFields(config, selectedSpecs) : [];
  const missingRequired = config
    ? missingRequiredSpecFields(config, selectedSpecs)
    : [];
  const invalidNumeric = config
    ? invalidNumericSpecFields(config, selectedSpecs)
    : [];
  const isSpecComplete = Boolean(
    selectedParent &&
      (config
        ? missingRequired.length === 0 && invalidNumeric.length === 0
        : selectedVariantId),
  );

  const specsKey = useMemo(() => JSON.stringify(selectedSpecs), [selectedSpecs]);
  const autoEstimatedWeight = useMemo(() => {
    if (!isSpecComplete) return "";
    return (
      estimateLeadItemWeightKg({
        configId: config?.id ?? null,
        uom: uom || "",
        quantity: quantity || "1",
        specs: selectedSpecs,
      }) ?? ""
    );
  }, [config?.id, uom, quantity, specsKey, isSpecComplete, selectedSpecs]);

  useEffect(() => {
    setValue(`items.${index}.estimatedWeight`, autoEstimatedWeight);
  }, [autoEstimatedWeight, index, setValue]);

  // Fallback for unconfigured products
  const hiddenKeys = new Set([
    "categoryId",
    "categoryName",
    "productId",
    "productName",
    "productSku",
    "productVariantId",
    "variantDisplayName",
  ]);
  const specOrder = ["grade", "finish", "thickness", "width", "length", "diameter"];
  const fallbackSpecKeys = [
    ...new Set(
      variants.flatMap((variant) =>
        Object.entries(variant.specs)
          .filter(
            ([key, value]) =>
              !hiddenKeys.has(key) &&
              value !== null &&
              value !== undefined &&
              value !== "",
          )
          .map(([key]) => key),
      ),
    ),
  ].sort((a, b) => {
    const ai = specOrder.indexOf(a);
    const bi = specOrder.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.localeCompare(b);
  });
  const fallbackCustomerInputKeys = new Set(
    fallbackSpecKeys.filter((key) => {
      const values = variants
        .map((variant) => variant.specs[key])
        .filter((value) => value !== null && value !== undefined && value !== "");
      return values.length > 0 && values.every((value) => isCustomerInputSpecification(key, value));
    }),
  );
  const fallbackSelectorKeys = fallbackSpecKeys.filter((key) => !fallbackCustomerInputKeys.has(key));
  const fallbackSelectedVariant = variants.find((variant) => variant.id === selectedVariantId);
  const fallbackCustomerInputFields = fallbackSelectedVariant
    ? Object.entries(fallbackSelectedVariant.specs).filter(
        ([key, value]) =>
          fallbackCustomerInputKeys.has(key) && isCustomerInputSpecification(key, value),
      )
    : [];

  const specLabel = (key: string) =>
    ({
      grade: "Grade",
      finish: "Finish",
      thickness: "Thickness",
      width: "Width",
      length: "Length",
      diameter: "Diameter",
      wireDiameterMm: "Wire diameter",
      cutLengthMm: "Cut length",
      innerDiameterMm: "Inner diameter",
      outerDiameterMm: "Outer diameter",
      finishOrCondition: "Finish / condition",
      drawingReference: "Drawing reference",
      designReference: "Design reference",
      dimensions: "Required dimensions",
      capacityLitres: "Capacity",
      materialGrade: "Material grade",
      pvdColour: "PVD colour",
      packing: "Packing",
      productionRemarks: "Production Remarks",
      cutProfile: "Cut Profile",
      decorativeSubtype: "Decorative Subtype",
      sizeNote: "Size Note",
      breadth: "Breadth",
    })[key] ??
    key
      .replaceAll(/([A-Z])/g, " $1")
      .replace(/^./, (letter) => letter.toUpperCase());

  const specUnit = (key: string) =>
    ({
      thickness: "mm",
      width: "mm",
      length: "mm",
      breadth: "mm",
      diameter: "mm",
      wireDiameterMm: "mm",
      cutLengthMm: "mm",
      innerDiameterMm: "mm",
      outerDiameterMm: "mm",
      capacityLitres: "L",
      weightPerPiece: "kg",
    })[key] ?? "";

  const optionsFor = (key: string) =>
    [
      ...new Set(
        variants
          .map((variant) => variant.specs[key])
          .filter(
            (value) =>
              value !== null &&
              value !== undefined &&
              value !== "" &&
              !isCustomerInputSpecification(key, value),
          )
          .map(String),
      ),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  useEffect(() => {
    if (!parentProductId) {
      setAllowedUoms([]);
      return;
    }
    let cancelled = false;
    setUomsLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/v1/products/${parentProductId}/uoms`);
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setAllowedUoms([]);
          return;
        }
        const allowed = (json?.data?.allowed ?? []) as {
          id: string;
          symbol: string;
          name: string;
          isDefault: boolean;
        }[];
        setAllowedUoms(allowed);
        const current = (uom || "").trim().toUpperCase();
        const stillValid = allowed.some((row) => row.symbol.toUpperCase() === current);
        if (!stillValid) {
          const defaultUom =
            (json?.data?.defaultUom as { symbol?: string } | null)?.symbol ||
            allowed.find((row) => row.isDefault)?.symbol ||
            allowed[0]?.symbol ||
            "";
          setValue(`items.${index}.uom`, defaultUom);
        }
      } finally {
        if (!cancelled) setUomsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally depend on parent product only; UOM reset runs when options load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentProductId, index, setValue]);

  const syncVariantAndUom = (newSpecs: Record<string, string>) => {
    if (!config) return;
    const resolved = resolveExactPricedVariant(variants, newSpecs, config);

    if (resolved.status === "incomplete") {
      setValue(`items.${index}.productVariantId`, "");
      setValue(`items.${index}.productId`, "");
      setValue(`items.${index}.unitPrice`, "");
      return;
    }

    if (resolved.status === "exact" && resolved.variant) {
      const best = resolved.variant;
      setValue(`items.${index}.productVariantId`, best.id);
      setValue(`items.${index}.productId`, best.materialMasterId);
      // Blank catalog price stays blank (rate pending) — never coerce to 0.
      setValue(`items.${index}.unitPrice`, best.sellingPrice?.trim() || "");
      if (!uom && allowedUoms.length) {
        const defaultUom =
          allowedUoms.find((row) => row.isDefault)?.symbol || allowedUoms[0]?.symbol || "";
        if (defaultUom) setValue(`items.${index}.uom`, defaultUom);
      }
      return;
    }

    // none | ambiguous — keep entered specs, clear stale IDs / price
    setValue(`items.${index}.productVariantId`, "");
    setValue(`items.${index}.productId`, "");
    setValue(`items.${index}.unitPrice`, "");
  };

  const handleSpecChange = (key: string, value: string) => {
    const nextSpecs = { ...selectedSpecs };
    if (value) {
      nextSpecs[key] = value;
    } else {
      delete nextSpecs[key];
    }

    // Sheet: If finish changed and is not decorative, clear decorativeSubtype
    if (config?.id === "sheet" && key === "finish") {
      if (!/pvd|mirror|matt/i.test(value)) {
        delete nextSpecs.decorativeSubtype;
      }
    }

    // Wire: If productForm changed and is not cut piece, clear cutLengthMm
    if (config?.id === "wire" && key === "productForm") {
      if (!/cut/i.test(value)) {
        delete nextSpecs.cutLengthMm;
      }
    }

    setValue(`items.${index}.specifications`, nextSpecs);
    syncVariantAndUom(nextSpecs);
  };

  const handleFilesChange = (uploadedFiles: UploadedDesignFile[]) => {
    const nextSpecs = {
      ...selectedSpecs,
      designFiles: uploadedFiles as unknown as string,
      designFileIds: uploadedFiles.map((f) => f.id) as unknown as string,
    };
    setValue(`items.${index}.specifications`, nextSpecs as Record<string, string>);
  };

  const setFallbackSpec = (key: string, value: string) => {
    const values = { ...selectedSpecs };
    const keyIndex = fallbackSelectorKeys.indexOf(key);
    for (const laterKey of fallbackSelectorKeys.slice(keyIndex + 1))
      delete values[laterKey];
    if (value) values[key] = value;
    else delete values[key];
    const resolved = resolveExactPricedVariant(variants, values, null);
    const exact = resolved.status === "exact" ? resolved.variant : undefined;
    setValue(`items.${index}.specifications`, values);
    setValue(`items.${index}.productVariantId`, exact?.id ?? "");
    setValue(`items.${index}.productId`, exact?.materialMasterId ?? "");
    setValue(`items.${index}.unitPrice`, exact?.sellingPrice?.trim() || "");
    if (exact && allowedUoms.length) {
      const current = (uom || "").trim().toUpperCase();
      if (!allowedUoms.some((row) => row.symbol.toUpperCase() === current)) {
        setValue(
          `items.${index}.uom`,
          allowedUoms.find((row) => row.isDefault)?.symbol || allowedUoms[0]?.symbol || "",
        );
      }
    }
  };

  function applyMatchedVariant(
    exact: { id: string; materialMasterId: string; sellingPrice?: string } | undefined,
  ) {
    setValue(`items.${index}.productVariantId`, exact?.id ?? "");
    setValue(`items.${index}.productId`, exact?.materialMasterId ?? "");
    setValue(`items.${index}.unitPrice`, exact?.sellingPrice?.trim() || "");
  }

  const pricedResolution = config
    ? resolveExactPricedVariant(variants, selectedSpecs, config)
    : selectedVariantId
      ? ({ status: "exact" as const, matches: [], variant: variants.find((v) => v.id === selectedVariantId) })
      : ({ status: "incomplete" as const, matches: [] as typeof variants });
  const ratePending =
    isSpecComplete &&
    (pricedResolution.status === "none" ||
      pricedResolution.status === "ambiguous" ||
      (pricedResolution.status === "exact" &&
        !(pricedResolution.variant?.sellingPrice ?? unitPrice)?.toString().trim()));

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium">Item {index + 1}</p>
        {canRemove ? (
          <button
            type="button"
            className="text-sm font-medium text-danger hover:underline"
            onClick={onRemove}
          >
            Remove
          </button>
        ) : null}
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        <LeadField label="Business category">
          <select
            className={fieldClass}
            {...register(`items.${index}.categoryId`, {
              onChange: () => {
                setValue(`items.${index}.productId`, "");
                setValue(`items.${index}.productVariantId`, "");
                setValue(`items.${index}.parentProductId`, "");
                setValue(`items.${index}.specifications`, {});
                setValue(`items.${index}.size`, "");
                setValue(`items.${index}.uom`, "");
                setValue(`items.${index}.unitPrice`, "");
              },
            })}
          >
            <option value="">Select</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </LeadField>
        <LeadField label="Material / product">
          <select
            className={fieldClass}
            {...register(`items.${index}.parentProductId`, {
              onChange: (event) => {
                setValue(`items.${index}.productVariantId`, "");
                setValue(`items.${index}.productId`, "");
                setValue(`items.${index}.specifications`, {});
                setValue(`items.${index}.uom`, "");
                setValue(`items.${index}.unitPrice`, "");
                const parent = products.find(
                  (product) => product.id === event.target.value,
                );
                if (parent?.variants.length === 1 && !config) {
                  const variant = parent.variants[0];
                  setValue(`items.${index}.productVariantId`, variant.id);
                  setValue(
                    `items.${index}.productId`,
                    variant.materialMasterId,
                  );
                  setValue(`items.${index}.unitPrice`, variant.sellingPrice?.trim() || "");
                  setValue(
                    `items.${index}.specifications`,
                    Object.fromEntries(
                      Object.entries(variant.specs)
                        .filter(
                          ([key, value]) =>
                            value != null &&
                            typeof value !== "object" &&
                            !isCustomerInputSpecification(key, value),
                        )
                        .map(([key, value]) => [key, String(value)]),
                    ),
                  );
                }
              },
            })}
          >
            <option value="">Select</option>
            {visibleProducts.map((product) => {
              const comingSoon = isProductComingSoon(product);
              return (
                <option
                  key={product.id}
                  value={product.id}
                  disabled={comingSoon}
                >
                  {product.name}
                  {comingSoon ? " (Coming soon)" : ""}
                </option>
              );
            })}
            {!visibleProducts.length ? (
              <option value="" disabled>
                No matching products
              </option>
            ) : null}
          </select>
          {selectedParent && !variants.length ? (
            <p className="mt-1 text-xs text-muted">
              No specifications available for this product. Please add
              specifications in Product Master.
              {canManageProducts ? (
                <>
                  {" "}
                  <Link
                    className="font-medium text-accent underline"
                    href={`/products/catalog/${selectedParent.id}`}
                  >
                    Manage specifications
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
        </LeadField>

        {config ? (
          fields.map((field) => {
            const unit = field.unit || specUnit(field.key);
            const labelWithUnit = unit ? `${field.label} (${unit})` : field.label;

            if (field.type === "select" && field.key === "thickness") {
              return (
                <LeadField key={field.key} label={field.label}>
                  <LeadThicknessField
                    specs={selectedSpecs}
                    options={optionsFor("thickness")}
                    widthOptions={optionsFor("width")}
                    disabled={!selectedParent}
                    canManageProducts={canManageProducts}
                    categoryId={categoryId}
                    parentProductId={parentProductId}
                    datalistId={`lead-swg-${index}`}
                    onGaugeThicknessMm={(mm) => setValue(`items.${index}.gaugeThicknessMm`, mm)}
                    onSpecsChange={(next) => {
                      setValue(`items.${index}.specifications`, next);
                      syncVariantAndUom(next);
                    }}
                  />
                </LeadField>
              );
            }

            if (field.type === "select" && field.key === "width") {
              return (
                <LeadField key={field.key} label={field.label}>
                  <LeadWidthField
                    specs={selectedSpecs}
                    options={optionsFor("width")}
                    thicknessOptions={optionsFor("thickness")}
                    disabled={!selectedParent}
                    canManageProducts={canManageProducts}
                    categoryId={categoryId}
                    parentProductId={parentProductId}
                    onSharedUnitChange={(mm) => setValue(`items.${index}.gaugeThicknessMm`, mm)}
                    onSpecsChange={(next) => {
                      setValue(`items.${index}.specifications`, next);
                      syncVariantAndUom(next);
                    }}
                  />
                </LeadField>
              );
            }

            if (field.type === "select") {
              const draftMaster =
                (field.key === "grade" || field.key === "finish") && canManageProducts;
              return (
                <LeadField key={field.key} label={field.label}>
                  <CreatableSpecSelect
                    fieldName={field.key}
                    fieldLabel={field.label}
                    unit={unit}
                    value={selectedSpecs[field.key] ?? ""}
                    onChange={(val) => handleSpecChange(field.key, val)}
                    options={optionsFor(field.key)}
                    canCreate={canManageProducts}
                    draftOnly={draftMaster}
                    categoryId={categoryId}
                    productId={parentProductId}
                    ariaLabel={`Select or add ${field.label}`}
                  />
                </LeadField>
              );
            }

            if (field.type === "number" && isInchConvertibleSpecKey(field.key)) {
              return (
                <LeadField key={field.key} label={field.label}>
                  <LeadDimensionMmField
                    specKey={field.key as "diameter" | "wireDiameterMm" | "innerDiameterMm" | "outerDiameterMm"}
                    label={field.label}
                    specs={selectedSpecs}
                    disabled={!selectedParent}
                    onSpecsChange={(next) => {
                      setValue(`items.${index}.specifications`, next);
                      syncVariantAndUom(next);
                    }}
                  />
                </LeadField>
              );
            }

            if (field.type === "number") {
              return (
                <LeadField key={field.key} label={labelWithUnit}>
                  <input
                    className={fieldClass}
                    type="number"
                    min="0.001"
                    step="any"
                    placeholder={field.placeholder || "Enter value in numbers"}
                    value={selectedSpecs[field.key] ?? ""}
                    onChange={(event) => handleSpecChange(field.key, event.target.value)}
                  />
                </LeadField>
              );
            }

            if (field.type === "file") {
              return (
                <LeadField key={field.key} label={field.label} className="md:col-span-2">
                  <DesignFilesField
                    files={
                      Array.isArray((selectedSpecs as Record<string, unknown>).designFiles)
                        ? ((selectedSpecs as Record<string, unknown>).designFiles as UploadedDesignFile[])
                        : []
                    }
                    onChange={handleFilesChange}
                  />
                </LeadField>
              );
            }

            return (
              <LeadField key={field.key} label={field.label}>
                <div className="space-y-3">
                  <input
                    className={fieldClass}
                    type="text"
                    placeholder={field.placeholder || (field.key === "designReference" ? "Enter drawing reference" : "")}
                    value={selectedSpecs[field.key] ?? ""}
                    onChange={(event) => handleSpecChange(field.key, event.target.value)}
                  />
                  {field.key === "designReference" ? (
                    <DesignFilesField
                      files={
                        Array.isArray((selectedSpecs as Record<string, unknown>).designFiles)
                          ? ((selectedSpecs as Record<string, unknown>).designFiles as UploadedDesignFile[])
                          : []
                      }
                      onChange={handleFilesChange}
                    />
                  ) : null}
                </div>
              </LeadField>
            );
          })
        ) : (
          <>
            {fallbackSelectorKeys.map((key) =>
              isInchConvertibleSpecKey(key) ? (
                <LeadField key={key} label={specLabel(key)}>
                  <LeadDimensionMmField
                    specKey={key as "diameter" | "wireDiameterMm" | "innerDiameterMm" | "outerDiameterMm"}
                    label={specLabel(key)}
                    specs={selectedSpecs}
                    disabled={!selectedParent}
                    onSpecsChange={(next) => {
                      setValue(`items.${index}.specifications`, next);
                      const resolved = resolveExactPricedVariant(variants, next, null);
                      applyMatchedVariant(
                        resolved.status === "exact" ? resolved.variant : undefined,
                      );
                    }}
                  />
                </LeadField>
              ) : key === "thickness" ? (
                <LeadField key={key} label={specLabel(key)}>
                  <LeadThicknessField
                    specs={selectedSpecs}
                    options={optionsFor("thickness")}
                    widthOptions={optionsFor("width")}
                    disabled={!selectedParent}
                    canManageProducts={canManageProducts}
                    categoryId={categoryId}
                    parentProductId={parentProductId}
                    datalistId={`lead-swg-fb-${index}`}
                    onGaugeThicknessMm={(mm) => setValue(`items.${index}.gaugeThicknessMm`, mm)}
                    onSpecsChange={(next) => {
                      setValue(`items.${index}.specifications`, next);
                      const resolved = resolveExactPricedVariant(variants, next, null);
                      applyMatchedVariant(
                        resolved.status === "exact" ? resolved.variant : undefined,
                      );
                    }}
                  />
                </LeadField>
              ) : key === "width" ? (
                <LeadField key={key} label={specLabel(key)}>
                  <LeadWidthField
                    specs={selectedSpecs}
                    options={optionsFor("width")}
                    thicknessOptions={optionsFor("thickness")}
                    disabled={!selectedParent}
                    canManageProducts={canManageProducts}
                    categoryId={categoryId}
                    parentProductId={parentProductId}
                    onSharedUnitChange={(mm) => setValue(`items.${index}.gaugeThicknessMm`, mm)}
                    onSpecsChange={(next) => {
                      setValue(`items.${index}.specifications`, next);
                      const resolved = resolveExactPricedVariant(variants, next, null);
                      applyMatchedVariant(
                        resolved.status === "exact" ? resolved.variant : undefined,
                      );
                    }}
                  />
                </LeadField>
              ) : (
                <LeadField key={key} label={specLabel(key)}>
                  <CreatableSpecSelect
                    fieldName={key}
                    fieldLabel={specLabel(key)}
                    unit={specUnit(key)}
                    value={selectedSpecs[key] ?? ""}
                    onChange={(val) => setFallbackSpec(key, val)}
                    options={optionsFor(key)}
                    canCreate={canManageProducts}
                    draftOnly={key === "grade" || key === "finish"}
                    categoryId={categoryId}
                    productId={parentProductId}
                    ariaLabel={`Select or add ${specLabel(key)}`}
                  />
                </LeadField>
              ),
            )}
            {fallbackCustomerInputFields.map(([key, configuredValue]) => {
              const unit = specUnit(key);
              if (isInchConvertibleSpecKey(key)) {
                return (
                  <LeadField key={key} label={specLabel(key)}>
                    <LeadDimensionMmField
                      specKey={key as "diameter" | "wireDiameterMm" | "innerDiameterMm" | "outerDiameterMm"}
                      label={specLabel(key)}
                      specs={selectedSpecs}
                      disabled={!selectedParent}
                      onSpecsChange={(next) => setValue(`items.${index}.specifications`, next)}
                    />
                  </LeadField>
                );
              }
              if (key === "thickness") {
                return (
                  <LeadField key={key} label={specLabel(key)}>
                    <LeadThicknessField
                      specs={selectedSpecs}
                      options={optionsFor("thickness")}
                      widthOptions={optionsFor("width")}
                      disabled={!selectedParent}
                      canManageProducts={canManageProducts}
                      categoryId={categoryId}
                      parentProductId={parentProductId}
                      datalistId={`lead-swg-ci-${index}`}
                      onGaugeThicknessMm={(mm) => setValue(`items.${index}.gaugeThicknessMm`, mm)}
                      onSpecsChange={(next) => setValue(`items.${index}.specifications`, next)}
                    />
                  </LeadField>
                );
              }
              if (key === "width") {
                return (
                  <LeadField key={key} label={specLabel(key)}>
                    <LeadWidthField
                      specs={selectedSpecs}
                      options={optionsFor("width")}
                      thicknessOptions={optionsFor("thickness")}
                      disabled={!selectedParent}
                      canManageProducts={canManageProducts}
                      categoryId={categoryId}
                      parentProductId={parentProductId}
                      onSharedUnitChange={(mm) => setValue(`items.${index}.gaugeThicknessMm`, mm)}
                      onSpecsChange={(next) => setValue(`items.${index}.specifications`, next)}
                    />
                  </LeadField>
                );
              }
              return (
                <LeadField
                  key={key}
                  label={`${specLabel(key)}${unit ? ` (${unit})` : ""}`}
                >
                  <input
                    className={fieldClass}
                    type={NUMERIC_SPEC_KEYS.has(key) ? "number" : "text"}
                    min={NUMERIC_SPEC_KEYS.has(key) ? "0.001" : undefined}
                    step={NUMERIC_SPEC_KEYS.has(key) ? "any" : undefined}
                    value={selectedSpecs[key] ?? ""}
                    placeholder={String(configuredValue)}
                    onChange={(event) =>
                      setValue(`items.${index}.specifications`, {
                        ...selectedSpecs,
                        [key]: event.target.value,
                      })
                    }
                  />
                </LeadField>
              );
            })}
          </>
        )}

        {selectedParent && !isSpecComplete ? (
          <p className="text-xs text-muted md:col-span-4">
            Choose a complete specification combination that exists for{" "}
            {selectedParent.name}.
            {missingRequired.length > 0 ? (
              <span className="text-warning ml-1">
                (Missing: {missingRequired.join(", ")})
              </span>
            ) : null}
          </p>
        ) : null}

        <LeadField label="Quantity">
          <input
            className={fieldClass}
            {...register(`items.${index}.quantity`)}
          />
        </LeadField>
        <LeadField label="UOM">
          <select
            className={`${fieldClass} ${!isSpecComplete || !allowedUoms.length ? "bg-muted/50 cursor-not-allowed opacity-75" : ""}`}
            disabled={!isSpecComplete || !allowedUoms.length || uomsLoading}
            value={uom || ""}
            onChange={(event) => setValue(`items.${index}.uom`, event.target.value)}
          >
            <option value="">
              {!parentProductId
                ? "Select product first"
                : !isSpecComplete
                  ? "Complete specification first"
                  : uomsLoading
                    ? "Loading…"
                    : "Select UOM"}
            </option>
            {allowedUoms.map((row) => (
              <option key={row.id} value={row.symbol}>
                {row.symbol}
                {row.isDefault ? " (default)" : ""} — {row.name}
              </option>
            ))}
          </select>
        </LeadField>
        <LeadField label="Est. weight (kg)">
          <input
            className={`${fieldClass} bg-muted/30 cursor-not-allowed opacity-90`}
            placeholder={isSpecComplete ? "Calculating…" : "Complete specification first"}
            readOnly
            disabled={!isSpecComplete}
            value={autoEstimatedWeight}
          />
        </LeadField>
        {(() => {
          const matchedVariant = variants.find((variant) => variant.id === selectedVariantId);
          const priceUom = matchedVariant?.uom || uom || "UOM";
          const lineTotal = leadLineAmount(
            unitPrice,
            quantity,
            uom || priceUom,
            priceUom,
            autoEstimatedWeight,
          );
          async function submitApplyRate(options?: { applyExistingRate?: boolean }) {
            if (!selectedParent || !rateEditor || !config) return;
            setRateEditor((prev) =>
              prev ? { ...prev, saving: true, error: undefined } : prev,
            );
            try {
              const liveKeys = activePricingMatchKeys(config, selectedSpecs);
              const liveFingerprint = buildNormalizedPricingFingerprint(
                selectedSpecs,
                liveKeys,
                config,
              );
              if (liveFingerprint !== rateEditor.fingerprint) {
                setRateEditor((prev) =>
                  prev
                    ? {
                        ...prev,
                        saving: false,
                        error:
                          "Specification changed while the rate editor was open. Close and review the updated specification.",
                      }
                    : prev,
                );
                return;
              }
              const response = await fetch("/api/v1/leads/apply-catalog-rate", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "idempotency-key": crypto.randomUUID(),
                },
                body: JSON.stringify({
                  productId: selectedParent.id,
                  specifications: rateEditor.specs,
                  unitRate: rateEditor.unitRate.trim(),
                  uom: uom || priceUom || undefined,
                  expectedPricingFingerprint: rateEditor.fingerprint,
                  applyExistingRate: options?.applyExistingRate || undefined,
                }),
              });
              const json = await response.json().catch(() => null);
              if (!response.ok) {
                const err = json?.error;
                if (err?.code === RATE_CONFLICT_CODE) {
                  setRateEditor((prev) =>
                    prev
                      ? {
                          ...prev,
                          saving: false,
                          conflictExistingRate: String(err.details?.existingRate ?? ""),
                          error: err.message || "Rate conflict with Product Master.",
                        }
                      : prev,
                  );
                  return;
                }
                if (err?.code === STALE_SPECIFICATION_CODE) {
                  setRateEditor((prev) =>
                    prev
                      ? {
                          ...prev,
                          saving: false,
                          error: err.message || "Specification changed. Review and try again.",
                        }
                      : prev,
                  );
                  return;
                }
                throw new Error(err?.message || "Failed to save & apply rate.");
              }
              const data = json?.data ?? json;
              const nextSpecs = {
                ...rateEditor.specs,
                ...(data.specs && typeof data.specs === "object" ? data.specs : {}),
              } as Record<string, string>;
              const resolvedSpecs = Object.fromEntries(
                Object.entries(nextSpecs)
                  .filter(([, value]) => value != null && typeof value !== "object")
                  .map(([key, value]) => [key, String(value)]),
              );
              setValue(`items.${index}.specifications`, resolvedSpecs);
              setValue(`items.${index}.productVariantId`, data.productVariantId);
              setValue(`items.${index}.productId`, data.materialMasterId);
              setValue(`items.${index}.unitPrice`, data.sellingPrice ?? "");
              if (data.uom) setValue(`items.${index}.uom`, data.uom);
              onCatalogVariantApplied(
                selectedParent.id,
                {
                  id: data.productVariantId,
                  materialMasterId: data.materialMasterId,
                  sku: data.sku || data.productVariantId,
                  displayName: data.displayName || selectedParent.name,
                  uom: data.uom || priceUom,
                  sellingPrice: data.sellingPrice,
                  specs: resolvedSpecs,
                },
                {
                  grade: data.grade
                    ? { id: data.grade.id, name: data.grade.name }
                    : undefined,
                  finish: data.finish
                    ? { id: data.finish.id, name: data.finish.name }
                    : undefined,
                },
              );
              if (data.grade?.name) {
                window.dispatchEvent(
                  new CustomEvent("spec-options-updated", {
                    detail: {
                      fieldName: "grade",
                      option: { id: data.grade.id, value: data.grade.name, label: data.grade.name },
                    },
                  }),
                );
              }
              if (data.finish?.name) {
                window.dispatchEvent(
                  new CustomEvent("spec-options-updated", {
                    detail: {
                      fieldName: "finish",
                      option: {
                        id: data.finish.id,
                        value: data.finish.name,
                        label: data.finish.name,
                      },
                    },
                  }),
                );
              }
              toast.success(
                data.appliedExistingRate
                  ? "Existing Product Master rate applied."
                  : rateEditor.mode === "create"
                    ? "Specification created in product catalog and rate applied."
                    : "Rate saved to Product Master and applied.",
              );
              setRateEditor(null);
            } catch (error) {
              setRateEditor((prev) =>
                prev
                  ? {
                      ...prev,
                      saving: false,
                      error: error instanceof Error ? error.message : "Failed to save rate.",
                    }
                  : prev,
              );
            }
          }

          return (
            <>
              <LeadField label="Unit price">
                {ratePending ? (
                  <div className="space-y-2">
                    <input
                      className={`${fieldClass} bg-muted/30 cursor-not-allowed opacity-90`}
                      readOnly
                      disabled
                      value="—"
                      aria-label="Price pending"
                    />
                    {pricedResolution.status === "none" ? (
                      <div className="rounded-lg border border-amber-300/70 bg-amber-50/90 px-3 py-2 dark:border-amber-700/50 dark:bg-amber-950/30">
                        <p className="text-xs text-amber-900 dark:text-amber-200">
                          Ye specification aapke software / product catalog me available nahi hai.
                        </p>
                        {canManageProducts && selectedParent ? (
                          <button
                            type="button"
                            className="mt-2 inline-flex h-8 items-center rounded-lg bg-info px-3 text-xs font-semibold text-white disabled:opacity-60"
                            onClick={() => {
                              if (!config) return;
                              if (!(uom || "").trim()) {
                                toast.error("Select UOM before creating this specification in the catalog.");
                                return;
                              }
                              const keys = activePricingMatchKeys(config, selectedSpecs);
                              const fingerprint = buildNormalizedPricingFingerprint(
                                selectedSpecs,
                                keys,
                                config,
                              );
                              setRateEditor({
                                mode: "create",
                                fingerprint,
                                specs: { ...selectedSpecs },
                                unitRate: "",
                                saving: false,
                              });
                            }}
                          >
                            Create
                          </button>
                        ) : (
                          <p className="mt-1 text-[11px] text-amber-800/80 dark:text-amber-300/80">
                            Product Master access chahiye to ye specification catalog me create karne ke liye.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {pricedResolution.status === "ambiguous"
                          ? RATE_AMBIGUOUS_MESSAGE
                          : "Price Pending"}
                        {canManageProducts && selectedParent && pricedResolution.status !== "ambiguous" ? (
                          <>
                            {" "}
                            <button
                              type="button"
                              className="font-medium underline"
                              onClick={() => {
                                if (!config) return;
                                const keys = activePricingMatchKeys(config, selectedSpecs);
                                const fingerprint = buildNormalizedPricingFingerprint(
                                  selectedSpecs,
                                  keys,
                                  config,
                                );
                                setRateEditor({
                                  mode: "set_price",
                                  fingerprint,
                                  specs: { ...selectedSpecs },
                                  unitRate: "",
                                  saving: false,
                                });
                              }}
                            >
                              Set Price
                            </button>
                          </>
                        ) : canManageProducts && selectedParent ? (
                          <>
                            {" "}
                            <Link
                              href={`/products/catalog/${selectedParent.id}`}
                              className="font-medium underline"
                            >
                              Open Product Master
                            </Link>
                          </>
                        ) : null}
                      </p>
                    )}
                    {rateEditor ? (
                      <div className="rounded-lg border border-amber-300/60 bg-amber-50/80 p-3 dark:border-amber-700/50 dark:bg-amber-950/30">
                        <p className="text-sm font-medium text-foreground">
                          {rateEditor.mode === "create"
                            ? "Create in product catalog"
                            : "Save & Apply Rate"}
                        </p>
                        {rateEditor.mode === "create" ? (
                          <p className="mt-1 text-[11px] text-muted">
                            Unit rate set karke ye specification product variant ke roop me save hogi.
                          </p>
                        ) : null}
                        <div className="mt-2 relative">
                          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">
                            ₹
                          </span>
                          <input
                            className={`${fieldClass} pl-7`}
                            inputMode="decimal"
                            placeholder={`Unit rate · ₹/${priceUom}`}
                            value={rateEditor.unitRate}
                            disabled={rateEditor.saving || Boolean(rateEditor.conflictExistingRate)}
                            onChange={(event) =>
                              setRateEditor((prev) =>
                                prev ? { ...prev, unitRate: event.target.value } : prev,
                              )
                            }
                          />
                        </div>
                        {rateEditor.conflictExistingRate ? (
                          <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                            Master rate is{" "}
                            <span className="font-semibold">
                              {formatInr(Number(rateEditor.conflictExistingRate))}/{priceUom}
                            </span>
                            . Submitted rate was not saved.
                          </p>
                        ) : null}
                        {rateEditor.error ? (
                          <p className="mt-2 text-xs text-danger">{rateEditor.error}</p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {rateEditor.conflictExistingRate ? (
                            <button
                              type="button"
                              className="h-9 rounded-lg bg-info px-3 text-sm font-medium text-white disabled:opacity-60"
                              disabled={rateEditor.saving}
                              onClick={() =>
                                void submitApplyRate({ applyExistingRate: true })
                              }
                            >
                              {rateEditor.saving ? "Applying…" : "Apply Existing Rate"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="h-9 rounded-lg bg-info px-3 text-sm font-medium text-white disabled:opacity-60"
                              disabled={
                                rateEditor.saving ||
                                !rateEditor.unitRate.trim() ||
                                !(Number(rateEditor.unitRate) > 0)
                              }
                              onClick={() => void submitApplyRate()}
                            >
                              {rateEditor.saving
                                ? "Saving…"
                                : rateEditor.mode === "create"
                                  ? "Create & Apply Rate"
                                  : "Save & Apply Rate"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="h-9 rounded-lg border border-border px-3 text-sm font-medium"
                            disabled={rateEditor.saving}
                            onClick={() => setRateEditor(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">
                      ₹
                    </span>
                    <input
                      className={`${fieldClass} pl-7`}
                      inputMode="decimal"
                      placeholder={isSpecComplete ? "Rate pending" : "—"}
                      disabled={!isSpecComplete}
                      value={unitPrice}
                      onChange={(event) => setValue(`items.${index}.unitPrice`, event.target.value)}
                    />
                  </div>
                )}
              </LeadField>
              <LeadField label="Line amount">
                <input
                  className={`${fieldClass} bg-muted/30 cursor-not-allowed opacity-90`}
                  readOnly
                  disabled
                  value={
                    lineTotal?.amount != null
                      ? formatInr(lineTotal.amount)
                      : lineTotal?.missing
                        ? "—"
                        : "—"
                  }
                />
              </LeadField>
            </>
          );
        })()}
        <LeadField label="Required delivery">
          <input
            className={fieldClass}
            type="date"
            disabled={!isSpecComplete}
            {...register(`items.${index}.requiredDeliveryDate`)}
          />
        </LeadField>
        <LeadField label="Promised delivery">
          <input
            className={fieldClass}
            type="date"
            disabled={!isSpecComplete}
            {...register(`items.${index}.promisedDeliveryDate`)}
          />
        </LeadField>
        {isItemPromisedLate ? (
          <div className="rounded-lg border border-red-700 bg-red-600 p-3 text-sm text-white md:col-span-4">
            <span className="font-semibold">Notice:</span> Promised delivery ({itemPromisedDeliveryDate}) is later than required delivery ({itemRequiredDeliveryDate}) for this product.
          </div>
        ) : null}
        <LeadField label="Description" className="md:col-span-2">
          <input
            className={fieldClass}
            placeholder="Short description"
            {...register(`items.${index}.description`)}
          />
        </LeadField>
        <LeadField label="Remarks" className="md:col-span-2">
          <input
            className={fieldClass}
            placeholder="Optional"
            {...register(`items.${index}.remarks`)}
          />
        </LeadField>
        {SHOW_LEAD_ITEM_MFG_COMMERCIAL ? (
          <details className="md:col-span-4 rounded-lg border border-border/80 bg-muted/10 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-muted">
              Manufacturing & commercial details (optional)
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-4">
              <LeadField label="Grade (mfg)">
                <CreatableSpecSelect
                  fieldName="mfgGrade"
                  fieldLabel="Grade"
                  value={mfgGrade}
                  onChange={(val) => setValue(`items.${index}.mfgGrade`, val)}
                  options={LEAD_GRADE_OPTIONS.filter((g) => g !== "Other")}
                  categoryId={categoryId}
                  productId={parentProductId}
                  ariaLabel="Manufacturing grade"
                />
              </LeadField>
              <LeadField label="Gauge / thickness (mm)">
                <input
                  className={fieldClass}
                  type="number"
                  min="0"
                  step="any"
                  {...register(`items.${index}.gaugeThicknessMm`)}
                />
              </LeadField>
              <LeadField label="Weight / piece (g)">
                <input
                  className={fieldClass}
                  type="number"
                  min="0"
                  step="any"
                  {...register(`items.${index}.weightPerPieceGrams`)}
                />
              </LeadField>
              <LeadField label="Finish">
                <input className={fieldClass} {...register(`items.${index}.finish`)} />
              </LeadField>
              <LeadField label="Size / capacity">
                <input className={fieldClass} {...register(`items.${index}.sizeOrCapacity`)} />
              </LeadField>
              <LeadField label="Packing">
                <input className={fieldClass} {...register(`items.${index}.packing`)} />
              </LeadField>
              <LeadField label="Pricing basis">
                <select className={fieldClass} {...register(`items.${index}.pricingBasis`)}>
                  <option value="">—</option>
                  <option value="PER_KG">Per kg</option>
                  <option value="PER_PIECE">Per piece</option>
                </select>
              </LeadField>
              <LeadField label="Artwork / logo file URL">
                <input
                  className={fieldClass}
                  placeholder="Link to artwork or PO logo file"
                  {...register(`items.${index}.artworkUrl`)}
                />
              </LeadField>
              <label className="flex items-center gap-2 text-sm md:col-span-2 md:self-end">
                <input type="checkbox" className="size-4" {...register(`items.${index}.logoRequired`)} />
                Customer logo required on product / packing
              </label>
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

type LeadFormCustomer = {
  id: string;
  name: string;
  code?: string;
  contactPerson: string;
  contactDesignation: string;
  companyName: string;
  phone: string;
  email: string;
  address: string;
  gstin: string;
};

export function LeadCreateForm({
  customers,
  employees,
  defaultAssigneeId = "",
  products: initialProducts,
  categories,
  uoms,
  canManageProducts,
}: {
  customers: LeadFormCustomer[];
  employees: { id: string; name: string }[];
  defaultAssigneeId?: string;
  products: LeadCatalogProduct[];
  categories: { id: string; name: string; code: string }[];
  uoms: { id: string; symbol: string }[];
  canManageProducts: boolean;
}) {
  const { error, success, pending } = usePost();
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [products, setProducts] = useState(initialProducts);
  const router = useRouter();

  useEffect(() => {
    setProducts(initialProducts);
  }, [initialProducts]);

  function handleCatalogVariantApplied(
    productId: string,
    variant: LeadCatalogProduct["variants"][number],
  ) {
    setProducts((prev) =>
      prev.map((product) => {
        if (product.id !== productId) return product;
        const without = product.variants.filter((row) => row.id !== variant.id);
        return { ...product, variants: [...without, variant] };
      }),
    );
  }
  const defaultUom =
    uoms.find((uom) => uom.symbol === "PCS")?.symbol ??
    uoms[0]?.symbol ??
    "PCS";
  const form = useForm<FormValues>({
    defaultValues: {
      queryDate: todayStamp(),
      queryTime: nowTime(),
      contactPerson: "",
      contactDesignation: "",
      phone: "",
      email: "",
      address: "",
      companyName: "",
      gstin: "",
      customerId: "",
      source: "PHONE",
      priority: "WARM",
      assigneeId:
        defaultAssigneeId && employees.some((employee) => employee.id === defaultAssigneeId)
          ? defaultAssigneeId
          : "",
      notes: "",
      items: [emptyItem(defaultUom)],
      attendedById: "",
      result: "PENDING",
      resultReason: "",
      officeRemarks: "",
    },
  });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });
  const result = useWatch({ control: form.control, name: "result" });
  const priority = useWatch({ control: form.control, name: "priority" });
  const selectedCustomerId = useWatch({ control: form.control, name: "customerId" });
  const selectedCustomer = customers.find((row) => row.id === selectedCustomerId) ?? null;

  function applyCustomerSelection(customerId: string) {
    form.setValue("customerId", customerId);
    if (!customerId) {
      form.setValue("contactPerson", "");
      form.setValue("contactDesignation", "");
      form.setValue("companyName", "");
      form.setValue("phone", "");
      form.setValue("email", "");
      form.setValue("address", "");
      form.setValue("gstin", "");
      return;
    }
    const customer = customers.find((row) => row.id === customerId);
    if (!customer) return;
    form.setValue("contactPerson", customer.contactPerson);
    form.setValue("contactDesignation", customer.contactDesignation);
    form.setValue("companyName", customer.companyName);
    form.setValue("phone", customer.phone);
    form.setValue("email", customer.email);
    form.setValue("address", customer.address);
    form.setValue("gstin", customer.gstin);
  }

  async function finalizeAfterCreate(
    leadId: string,
    mode: "quotation" | "sales_order",
    idempotencyBase: string,
  ) {
    const response = await fetch(`/api/v1/leads/${leadId}/finalize-success`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${idempotencyBase}:${mode}`,
      },
      body: JSON.stringify({ mode }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(json?.error?.message ?? "Could not finalize Success deal.");
    }
    return json?.data as {
      quotationId?: string;
      quotationNumber?: string;
      salesOrderId?: string | null;
      salesOrderNumber?: string | null;
      pendingApproval?: boolean;
    };
  }

  async function submitLead(
    values: FormValues,
    successMode: "none" | "quotation" | "sales_order" = "none",
  ) {
        const pendingRateCount = values.items.filter(
          (line) =>
            line.parentProductId && (!line.productVariantId || !line.productId),
        ).length;
        if (pendingRateCount > 0) {
          toast.info(
            `${pendingRateCount} item(s) saved as Price Pending — set rates before final quotation.`,
          );
        }
        if (successMode !== "none" || values.result === "SUCCESS") {
          const filledLines = values.items.filter(
            (line) =>
              line.parentProductId ||
              line.productId ||
              line.description?.trim() ||
              line.size?.trim(),
          );
          const blocking = filledLines.filter(
            (line) =>
              !line.productId ||
              !line.productVariantId ||
              !line.unitPrice?.trim() ||
              !(Number(line.unitPrice) > 0),
          );
          if (!filledLines.length || blocking.length > 0) {
            toast.error(
              "Result = Success requires every item to have a product variant and a positive unit price.",
            );
            return;
          }
        }
        const normalizeQty = (raw: string) => {
          const trimmed = raw.trim();
          return /^\d+(\.\d{1,3})?$/.test(trimmed) ? trimmed : "1";
        };
        const gstinRaw = values.gstin.trim().toUpperCase();
        if (gstinRaw.length > 0 && gstinRaw.length !== 15) {
          form.setError("gstin", {
            type: "validate",
            message: "Enter a valid 15-character GSTIN or leave blank.",
          });
          toast.error("Enter a valid 15-character GSTIN or leave blank.");
          return;
        }
        const mappedItems = values.items.map((line) => {
          const ratePendingLine =
            Boolean(line.parentProductId) &&
            (!line.productVariantId || !line.productId);
          const unitRate = line.unitPrice?.trim() || undefined;
          return {
            categoryId: line.categoryId || undefined,
            productId: ratePendingLine ? undefined : line.productId || undefined,
            parentProductId: line.parentProductId || undefined,
            productVariantId: ratePendingLine
              ? undefined
              : line.productVariantId || undefined,
            specifications: line.specifications,
            size: line.size || undefined,
            quantity: normalizeQty(line.quantity),
            uom: line.uom?.trim() || defaultUom,
            estimatedWeight: line.estimatedWeight || undefined,
            itemDescription: line.description || undefined,
            notes: line.remarks || undefined,
            mfgGrade: line.mfgGrade || undefined,
            thickness: line.specifications?.thickness || undefined,
            gaugeThicknessMm:
              line.gaugeThicknessMm?.trim() ||
              line.specifications?.thicknessConvertedMm?.trim() ||
              line.specifications?.thickness?.trim() ||
              undefined,
            weightPerPieceGrams: line.weightPerPieceGrams || undefined,
            finish: line.finish || line.specifications?.finish || undefined,
            grade: line.specifications?.grade || undefined,
            sizeOrCapacity: line.sizeOrCapacity || undefined,
            packing: line.packing || undefined,
            logoRequired: line.logoRequired || undefined,
            artworkUrl: line.artworkUrl || undefined,
            pricingBasis: line.pricingBasis || undefined,
            targetPrice: ratePendingLine ? undefined : unitRate,
            marketPrice: ratePendingLine ? undefined : unitRate,
            priceOffered: ratePendingLine ? undefined : unitRate,
            requiredDeliveryDate: line.requiredDeliveryDate?.trim() || undefined,
            promisedDeliveryDate: line.promisedDeliveryDate?.trim() || undefined,
          };
        });
        const filledItems = mappedItems.filter(
          (line) =>
            line.productId ||
            line.parentProductId ||
            line.itemDescription ||
            line.size,
        );

        const payload = {
          queryDate: values.queryDate || undefined,
          queryTime:
            values.queryDate && values.queryTime
              ? `${values.queryDate}T${values.queryTime}`
              : undefined,
          contactPerson: values.contactPerson,
          contactDesignation: values.contactDesignation || undefined,
          customerName: values.contactPerson,
          phone: values.phone,
          email: values.email || undefined,
          address: values.address || undefined,
          companyName: values.companyName || undefined,
          gstin: gstinRaw || undefined,
          customerId: values.customerId || undefined,
          source: values.source,
          orderType: deriveLeadOrderTypeFromBusinessCategories(mappedItems, categories),
          priority: values.priority,
          assigneeId: values.assigneeId || undefined,
          notes: values.notes.trim() || undefined,
          attendedById: values.attendedById || undefined,
          result: values.result,
          resultReason: values.resultReason || undefined,
          officeRemarks: values.officeRemarks || undefined,
          items:
            filledItems.length > 0
              ? filledItems
              : [
                  {
                    quantity: "1",
                    uom: defaultUom,
                    itemDescription: "To be specified",
                  },
                ],
        };

    setSubmitting(true);
    try {
      const response = await fetch("/api/v1/leads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKeyRef.current,
        },
        body: JSON.stringify(payload),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(json?.error?.message ?? "Could not create lead.");
        return;
      }
      const createdId = String(json?.data?.id ?? "");
      const leadNumber = String(json?.data?.leadNumber ?? "");
      const createKey = idempotencyKeyRef.current;
      idempotencyKeyRef.current = crypto.randomUUID();

      const effectiveMode: "none" | "quotation" | "sales_order" =
        successMode !== "none"
          ? successMode
          : values.result === "SUCCESS"
            ? "sales_order"
            : "none";

      if (createdId && effectiveMode !== "none") {
        try {
          const finalized = await finalizeAfterCreate(createdId, effectiveMode, createKey);
          if (effectiveMode === "sales_order" && finalized.salesOrderNumber) {
            toast.success(
              `Lead ${leadNumber || ""} created · Quotation ${finalized.quotationNumber ?? ""} sent · Sales order ${finalized.salesOrderNumber}`,
            );
          } else if (finalized.pendingApproval) {
            toast.success(
              `Lead ${leadNumber || ""} created · Quotation draft ${finalized.quotationNumber ?? ""} ready for approval`,
            );
          } else {
            toast.success(
              `Lead ${leadNumber || ""} created · Quotation ${finalized.quotationNumber ?? ""} marked sent`,
            );
          }
        } catch (error) {
          toast.error(
            error instanceof Error
              ? `${error.message} Lead ${leadNumber || createdId} was still created — open it to finish quotation / order.`
              : "Lead created, but Success finalize failed. Open the lead to continue.",
          );
          router.push(`/leads/${createdId}`);
          router.refresh();
          return;
        }
      } else {
        toast.success(leadNumber ? `Lead ${leadNumber} created.` : "Lead created.");
      }

      router.push(createdId ? `/leads/${createdId}` : "/leads");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={form.handleSubmit((values) =>
        void submitLead(values, values.result === "SUCCESS" ? "sales_order" : "none"),
      )}
    >
      <SectionCard
        step={1}
        title="Query & customer information"
        detail="Pick an existing customer to autofill details, or enter a new one."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <LeadField
            label="Customer"
            detail={
              selectedCustomer
                ? "autofilled — edit if needed"
                : "search by name, phone, email, or company — or leave as new customer"
            }
            className="md:col-span-3"
          >
            <CustomerSearchSelect
              value={selectedCustomerId}
              onChange={applyCustomerSelection}
              customers={customers}
            />
          </LeadField>
          <LeadField label="Date">
            <input
              className={fieldClass}
              type="date"
              {...form.register("queryDate")}
            />
          </LeadField>
          <LeadField label="Time">
            <input
              className={fieldClass}
              type="time"
              {...form.register("queryTime")}
            />
          </LeadField>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <LeadField label="Contact person" required>
            <input
              className={fieldClass}
              placeholder="Full name"
              required
              {...form.register("contactPerson")}
            />
          </LeadField>
          <LeadField label="Designation">
            <input
              className={fieldClass}
              placeholder="e.g. Purchase Manager"
              {...form.register("contactDesignation")}
            />
          </LeadField>
          <LeadField label="Company / firm">
            <input
              className={fieldClass}
              placeholder="Company name"
              {...form.register("companyName")}
            />
          </LeadField>
          <LeadField label="GSTIN" detail="optional, 15 characters">
            <input
              className={fieldClass}
              placeholder="22AAAAA0000A1Z5"
              maxLength={15}
              {...form.register("gstin")}
            />
          </LeadField>
          <LeadField label="Mobile" required>
            <input
              className={fieldClass}
              type="tel"
              placeholder="10-digit number"
              required
              {...form.register("phone")}
            />
          </LeadField>
          <LeadField label="Email">
            <input
              className={fieldClass}
              type="email"
              placeholder="name@company.com"
              {...form.register("email")}
            />
          </LeadField>
        </div>
        <div className="mt-4">
          <LeadField label="Address">
            <input
              className={fieldClass}
              placeholder="Street, city, state, pincode"
              {...form.register("address")}
            />
          </LeadField>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <LeadField label="Source">
            <select className={fieldClass} {...form.register("source")}>
              {LEAD_SOURCES.filter((source) => source !== "WEBSITE").map(
                (source) => (
                  <option key={source} value={source}>
                    {leadSourceLabel(source)}
                  </option>
                ),
              )}
            </select>
          </LeadField>
          <LeadField label="Assign to">
            <select className={fieldClass} {...form.register("assigneeId")}>
              <option value="">Unassigned</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </LeadField>
        </div>
        <div className="mt-4">
          <p className="mb-1.5 text-[13px] font-medium text-muted">Priority</p>
          <div className="flex flex-wrap gap-2">
            {LEAD_PRIORITIES.map((value) => {
              const selected = priority === value;
              const label = leadPriorityLabel(value);
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => form.setValue("priority", value)}
                  className={`h-9 rounded-full px-4 text-sm font-medium transition ${
                    selected
                      ? "bg-info text-white"
                      : "border border-border bg-card text-foreground hover:border-info/40 hover:bg-info-soft"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="mt-4">
          <LeadField label="Internal notes">
            <textarea
              className={`${fieldClass} h-auto min-h-[88px] py-2.5`}
              placeholder="Anything this team should know…"
              {...form.register("notes")}
            />
          </LeadField>
        </div>
      </SectionCard>

      <SectionCard
        step={2}
        title="Requested materials & specifications"
        detail="What they need, specs, and per-product delivery dates."
      >
        <div className="space-y-4">
          {fields.map((field, index) => (
            <LeadItemFields
              key={field.id}
              index={index}
              register={form.register}
              control={form.control}
              setValue={form.setValue}
              canRemove={fields.length > 1}
              onRemove={() => remove(index)}
              categories={categories}
              products={products}
              canManageProducts={canManageProducts}
              onCatalogVariantApplied={handleCatalogVariantApplied}
            />
          ))}
        </div>
        <button
          type="button"
          className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-info hover:underline"
          onClick={() => append(emptyItem(defaultUom))}
        >
          <span className="flex size-6 items-center justify-center rounded-full border border-info text-info">
            <Plus className="size-3.5" strokeWidth={2.4} />
          </span>
          Add item
        </button>
      </SectionCard>

      <SectionCard
        step={3}
        title="Office use & follow-up"
        detail="Internal tracking only."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <LeadField label="Attended by">
            <select className={fieldClass} {...form.register("attendedById")}>
              <option value="">Select employee</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </LeadField>
          <LeadField label="Result">
            <select className={fieldClass} {...form.register("result")}>
              <option value="PENDING">Pending</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILURE">Failure</option>
            </select>
          </LeadField>
          {result === "FAILURE" ? (
            <LeadField label="Reason for no" required className="md:col-span-2">
              <select className={fieldClass} {...form.register("resultReason")}>
                <option value="">Select reason</option>
                <option value="Price">Price</option>
                <option value="Availability">Availability</option>
                <option value="Others">Others</option>
              </select>
            </LeadField>
          ) : null}
        </div>
        <div className="mt-4">
          <LeadField label="Office remarks">
            <input
              className={fieldClass}
              placeholder="Internal remarks"
              {...form.register("officeRemarks")}
            />
          </LeadField>
        </div>
      </SectionCard>

      <FormFeedback error={error} success={success} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          <span className="text-danger">*</span> Required field
          {result === "SUCCESS" ? (
            <span className="mt-1 block text-xs text-info">
              Result = Success: Create lead will also raise quotation + sales order. Use Send
              quotation to send the quote without converting yet.
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/leads" className="btn-secondary h-11 px-5">
            Cancel
          </Link>
          {result === "SUCCESS" ? (
            <button
              type="button"
              disabled={submitting || pending}
              className="inline-flex h-11 items-center justify-center rounded-[10px] border border-info bg-white px-5 text-sm font-semibold text-info transition hover:bg-info/5 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() =>
                void form.handleSubmit((values) => submitLead(values, "quotation"))()
              }
            >
              {submitting || pending ? "Saving…" : "Send quotation"}
            </button>
          ) : null}
          <button
            type="submit"
            disabled={submitting || pending}
            className="inline-flex h-11 items-center justify-center rounded-[10px] bg-info px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting || pending
              ? "Saving…"
              : result === "SUCCESS"
                ? "Create lead + sales order"
                : "Create lead"}
          </button>
        </div>
      </div>
    </form>
  );
}
