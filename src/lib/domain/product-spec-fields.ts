export type SpecFieldType = "select" | "number" | "text" | "file";

export type SpecFieldShowWhen = {
  key: string;
  match: RegExp | string | readonly string[];
};

export type ProductSpecField = {
  key: string;
  label: string;
  type: SpecFieldType;
  required?: boolean;
  unit?: string;
  /**
   * When true, this field participates in priced-variant identity.
   * Defaults to true for non-file fields unless explicitly set false
   * (e.g. production remarks / notes).
   */
  pricing?: boolean;
  /** Placeholder / helper for text and number inputs. */
  placeholder?: string;
  accept?: string;
  maxFiles?: number;
  maxBytes?: number;
  showWhen?: SpecFieldShowWhen;
};

export type ProductSpecConfig = {
  id: string;
  matchSkus: readonly string[];
  matchNames: readonly string[];
  hiddenKeys: readonly string[];
  fields: readonly ProductSpecField[];
};

/** Spec keys stored as first-class ProductVariant / MaterialMaster columns. */
export const FIRST_CLASS_VARIANT_SPEC_KEYS = [
  "grade",
  "finish",
  "thickness",
  "width",
  "length",
  "diameter",
] as const;

export type FirstClassVariantSpecKey = (typeof FIRST_CLASS_VARIANT_SPEC_KEYS)[number];

export function isFirstClassVariantSpecKey(key: string): key is FirstClassVariantSpecKey {
  return (FIRST_CLASS_VARIANT_SPEC_KEYS as readonly string[]).includes(key);
}

export const ALWAYS_HIDDEN_SPEC_KEYS = [
  "categoryId",
  "categoryName",
  "productId",
  "productName",
  "productSku",
  "productVariantId",
  "variantDisplayName",
  "seedMetadata",
  "sku",
  "thicknessInputUnit",
  "thicknessGauge",
  "thicknessGaugeSystem",
  "thicknessConvertedMm",
  "widthGauge",
  "widthConvertedMm",
  "diameterInputUnit",
  "diameterInch",
  "diameterConvertedMm",
  "wireDiameterMmInputUnit",
  "wireDiameterMmInch",
  "wireDiameterMmConvertedMm",
  "innerDiameterMmInputUnit",
  "innerDiameterMmInch",
  "innerDiameterMmConvertedMm",
  "outerDiameterMmInputUnit",
  "outerDiameterMmInch",
  "outerDiameterMmConvertedMm",
] as const;

/** Fields dropped from new lead items; old records may still contain them. */
export const DROPPED_FORM_SPEC_KEYS = [
  "packing",
  "profile",
  "supplyCondition",
  "innerDiameter",
  "innerDiameterMm",
  "outerDiameter",
  "outerDiameterMm",
  "compatibleUtensilType",
  "designForm",
  "edgeType",
  "productFormCoil",
] as const;

export const DESIGN_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DESIGN_FILE_MAX_COUNT = 5;
export const DESIGN_FILE_ACCEPT = ".pdf,.dxf,.dwg,.png,.jpg,.jpeg,.webp";
export const DESIGN_FILE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/dxf",
  "application/x-dxf",
  "image/vnd.dxf",
  "application/acad",
  "application/x-acad",
  "application/dwg",
  "application/x-dwg",
  "application/octet-stream",
]);
export const DESIGN_FILE_EXTENSIONS = new Set(["pdf", "dxf", "dwg", "png", "jpg", "jpeg", "webp"]);

const circleConfig: ProductSpecConfig = {
  id: "circle",
  matchSkus: ["SSM-MFG-CIRCLE", "CIRCLE"],
  matchNames: ["circle"],
  hiddenKeys: ["edgeType"],
  fields: [
    { key: "grade", label: "Grade", type: "select", required: true, pricing: true },
    { key: "finish", label: "Finish", type: "select", required: true, pricing: true },
    { key: "thickness", label: "Thickness", type: "select", required: true, unit: "mm", pricing: true },
    {
      key: "diameter",
      label: "Diameter",
      type: "number",
      required: true,
      unit: "mm",
      placeholder: "Enter value in numbers",
      pricing: true,
    },
  ],
};

const farmaConfig: ProductSpecConfig = {
  id: "farma",
  matchSkus: [
    "SSM-MFG-FARMA",
    "SSM-MFG-JUG-FARMA",
    "SSM-MFG-BHOJANTHAAL-FARMA",
    "SSM-MFG-CUSTOM-UTENSIL-FARMA",
    "SSM-MFG-FARMA-UTENSILS",
    "FARMA",
    "FARMA-1",
  ],
  matchNames: ["farma", "jug farma", "bhojanthaal farma", "custom utensil farma", "farma design"],
  hiddenKeys: ["compatibleUtensilType", "designForm", "drawingReference", "dimensions"],
  fields: [
    { key: "grade", label: "Grade", type: "select", required: true, pricing: true },
    { key: "finish", label: "Finish", type: "select", required: true, pricing: true },
    { key: "thickness", label: "Thickness", type: "select", required: true, unit: "mm", pricing: true },
    { key: "length", label: "Length", type: "number", required: true, unit: "mm", pricing: true },
    { key: "breadth", label: "Breadth", type: "number", required: true, unit: "mm", pricing: true },
    { key: "productionRemarks", label: "Production Remarks", type: "select", pricing: false },
  ],
};

const laserCutFarmaConfig: ProductSpecConfig = {
  id: "laser_cut_farma",
  matchSkus: ["SSM-MFG-LASER-FARMA"],
  matchNames: ["laser cut farma"],
  hiddenKeys: [],
  fields: [
    { key: "grade", label: "Grade", type: "select", required: true, pricing: true },
    { key: "thickness", label: "Thickness", type: "select", required: true, unit: "mm", pricing: true },
    { key: "finish", label: "Finish", type: "select", required: true, pricing: true },
    { key: "cutProfile", label: "Cut Profile", type: "text", required: true, pricing: true },
    { key: "dimensions", label: "Required dimensions", type: "text", required: true, pricing: true },
    { key: "designReference", label: "Design reference / drawing", type: "text", required: true, pricing: true },
  ],
};

const sheetConfig: ProductSpecConfig = {
  id: "sheet",
  matchSkus: ["SSM-TRD-SHEET", "SSM-TRD-MIRROR-MATT-PVD", "SHEET", "PRD-2026-00001"],
  matchNames: ["sheet", "mirror, matt & pvd sheets"],
  hiddenKeys: ["pvdColour", "dimensions"],
  fields: [
    { key: "grade", label: "Grade", type: "select", required: true, pricing: true },
    { key: "finish", label: "Finish", type: "select", required: true, pricing: true },
    { key: "thickness", label: "Thickness", type: "select", required: true, unit: "mm", pricing: true },
    { key: "width", label: "Width", type: "select", required: true, unit: "mm", pricing: true },
    { key: "length", label: "Length", type: "select", required: true, unit: "mm", pricing: true },
    {
      key: "decorativeSubtype",
      label: "Decorative Subtype",
      type: "select",
      pricing: true,
      showWhen: { key: "finish", match: /pvd|mirror|matt/i },
    },
  ],
};

const rodConfig: ProductSpecConfig = {
  id: "rod",
  matchSkus: ["SSM-TRD-ROD", "ROD"],
  matchNames: ["rod"],
  hiddenKeys: ["packing", "profile", "supplyCondition"],
  fields: [
    { key: "grade", label: "Grade", type: "select", required: true, pricing: true },
    {
      key: "diameter",
      label: "Diameter",
      type: "number",
      required: true,
      unit: "mm",
      placeholder: "Enter value in numbers",
      pricing: true,
    },
    { key: "length", label: "Length", type: "number", required: true, unit: "mm", pricing: true },
  ],
};

const coilConfig: ProductSpecConfig = {
  id: "coil",
  matchSkus: ["SSM-TRD-COIL", "COIL"],
  matchNames: ["coil"],
  hiddenKeys: ["innerDiameterMm", "innerDiameter", "outerDiameterMm", "outerDiameter", "productForm"],
  fields: [
    { key: "grade", label: "Grade", type: "select", required: true, pricing: true },
    { key: "finish", label: "Finish", type: "select", required: true, pricing: true },
    { key: "thickness", label: "Thickness", type: "select", required: true, unit: "mm", pricing: true },
    { key: "width", label: "Width", type: "select", required: true, unit: "mm", pricing: true },
  ],
};

const wireConfig: ProductSpecConfig = {
  id: "wire",
  matchSkus: ["SSM-TRD-WIRE", "SSM-TRD-WIRE-PCS", "WIRE"],
  matchNames: ["wire", "wire pcs"],
  hiddenKeys: ["packing"],
  fields: [
    { key: "productForm", label: "Product Form", type: "select", required: true, pricing: true },
    { key: "grade", label: "Grade", type: "select", required: true, pricing: true },
    { key: "wireDiameterMm", label: "Wire diameter", type: "number", required: true, unit: "mm", pricing: true },
    { key: "finishOrCondition", label: "Finish / condition", type: "select", required: true, pricing: true },
    {
      key: "cutLengthMm",
      label: "Cut length",
      type: "number",
      required: true,
      unit: "mm",
      pricing: true,
      showWhen: { key: "productForm", match: /cut/i },
    },
  ],
};

const semiFinishUtensilsConfig: ProductSpecConfig = {
  id: "semi_finish_utensils",
  matchSkus: [
    "SSM-MFG-SEMI-FINISH-UTENSILS",
    "SSM-MFG-SEMI-FINISH-ICE-BUCKET",
    "SSM-MFG-SEMI-FINISH-CANISTER",
    "SSM-MFG-SEMI-FINISH-JUG",
  ],
  matchNames: [
    "semi finished utensils",
    "semi-finished utensils",
    "semi finish utensils",
    "semi finish ice bucket",
    "semi finish canister",
    "semi finish jug",
  ],
  hiddenKeys: [],
  fields: [
    { key: "grade", label: "Grade", type: "select", pricing: true },
    { key: "stageOfManufacture", label: "Stage of Manufacture", type: "select", pricing: true },
    { key: "utensilType", label: "Utensil Type", type: "select", pricing: true },
  ],
};

export const PRODUCT_FIELD_CONFIG: readonly ProductSpecConfig[] = [
  circleConfig,
  farmaConfig,
  laserCutFarmaConfig,
  sheetConfig,
  rodConfig,
  coilConfig,
  wireConfig,
  semiFinishUtensilsConfig,
];

export function isProductComingSoon(product?: {
  sku?: string | null;
  name?: string | null;
} | null): boolean {
  if (!product) return false;
  const sku = product.sku?.trim().toUpperCase() ?? "";
  const name = product.name?.trim().toLowerCase() ?? "";
  return (
    sku === "SSM-MFG-SEMI-FINISH-UTENSILS" ||
    sku.startsWith("SSM-MFG-SEMI-FINISH-") ||
    /semi[\s_-]*finish/i.test(name)
  );
}

export const MERGED_PRODUCT_SKUS: Record<string, string> = {
  "SSM-TRD-WIRE-PCS": "SSM-TRD-WIRE",
  "SSM-TRD-MIRROR-MATT-PVD": "SSM-TRD-SHEET",
  "SSM-MFG-JUG-FARMA": "SSM-MFG-FARMA",
  "SSM-MFG-BHOJANTHAAL-FARMA": "SSM-MFG-FARMA",
  "SSM-MFG-CUSTOM-UTENSIL-FARMA": "SSM-MFG-FARMA",
  "SSM-MFG-FARMA-UTENSILS": "SSM-MFG-FARMA",
  "FARMA-1": "SSM-MFG-FARMA",
  "FARMA": "SSM-MFG-FARMA",
  "SSM-MFG-SEMI-FINISH-ICE-BUCKET": "SSM-MFG-SEMI-FINISH-UTENSILS",
  "SSM-MFG-SEMI-FINISH-CANISTER": "SSM-MFG-SEMI-FINISH-UTENSILS",
  "SSM-MFG-SEMI-FINISH-JUG": "SSM-MFG-SEMI-FINISH-UTENSILS",
};

const SPEC_LABELS: Record<string, string> = {
  grade: "Grade",
  finish: "Finish",
  thickness: "Thickness",
  width: "Width",
  length: "Length",
  breadth: "Breadth",
  diameter: "Diameter",
  wireDiameterMm: "Wire diameter",
  cutLengthMm: "Cut length",
  finishOrCondition: "Finish / condition",
  productForm: "Product Form",
  decorativeSubtype: "Decorative Subtype",
  sizeNote: "Size Note",
  productionRemarks: "Production Remarks",
  cutProfile: "Cut Profile",
  dimensions: "Required dimensions",
  designReference: "Design reference",
  designFiles: "Design files",
  drawingReference: "Drawing reference",
};

const SPEC_UNITS: Record<string, string> = {
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
};

export function specFieldLabel(key: string) {
  if (SPEC_LABELS[key]) return SPEC_LABELS[key];
  return key.replaceAll(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

export function specFieldUnit(key: string) {
  return SPEC_UNITS[key] ?? "";
}

export function resolveProductFieldConfig(product?: {
  sku?: string | null;
  name?: string | null;
} | null): ProductSpecConfig | null {
  if (!product) return null;
  const sku = product.sku?.trim().toUpperCase() ?? "";
  const name = product.name?.trim().toLowerCase() ?? "";
  return (
    PRODUCT_FIELD_CONFIG.find(
      (config) =>
        (sku && config.matchSkus.some((code) => code.toUpperCase() === sku)) ||
        (name && config.matchNames.includes(name)),
    ) ?? null
  );
}

export function fieldIsVisible(field: ProductSpecField, specs: Record<string, string>) {
  if (!field.showWhen) return true;
  const current = specs[field.showWhen.key] ?? "";
  const rule = field.showWhen.match;
  if (rule instanceof RegExp) return rule.test(current);
  if (typeof rule === "string") return current === rule;
  return rule.includes(current);
}

export function visibleProductFields(config: ProductSpecConfig, specs: Record<string, string>) {
  return config.fields.filter((field) => fieldIsVisible(field, specs));
}

export function requiredProductFields(config: ProductSpecConfig, specs: Record<string, string>) {
  return visibleProductFields(config, specs).filter((field) => field.required && field.type !== "file");
}

export function missingRequiredSpecFields(
  config: ProductSpecConfig,
  specs: Record<string, string>,
) {
  return requiredProductFields(config, specs)
    .filter((field) => {
      if (field.type === "file") return false;
      return !String(specs[field.key] ?? "").trim();
    })
    .map((field) => field.label);
}

export function isNumericSpecInput(key: string, config?: ProductSpecConfig | null) {
  const field = config?.fields.find((item) => item.key === key);
  if (field) return field.type === "number";
  return Boolean(SPEC_UNITS[key] && SPEC_UNITS[key] !== "L" ? true : ["weightPerPiece", "netWeightKg", "capacityLitres"].includes(key));
}

export function isFreeEntrySpecKey(key: string, config?: ProductSpecConfig | null) {
  const field = config?.fields.find((item) => item.key === key);
  if (!field) return key === "diameter";
  return field.type === "number" || field.type === "text" || field.type === "file";
}

export function isPricingSpecField(field: ProductSpecField) {
  if (field.type === "file") return false;
  if (field.pricing === false) return false;
  if (field.pricing === true) return true;
  // Default: non-file fields participate unless explicitly opted out.
  return true;
}

/** Visible pricing fields for the current conditional spec state. */
export function pricingProductFields(config: ProductSpecConfig, specs: Record<string, string>) {
  return visibleProductFields(config, specs).filter(isPricingSpecField);
}

export function pricingFieldKeys(config: ProductSpecConfig, specs: Record<string, string>) {
  return pricingProductFields(config, specs).map((field) => field.key);
}

/** Descriptive / note fields that never identify a priced variant. */
export function descriptiveProductFields(config: ProductSpecConfig, specs: Record<string, string>) {
  return visibleProductFields(config, specs).filter((field) => !isPricingSpecField(field));
}

/**
 * Select-only keys used for soft UOM hints. Prefer {@link pricingFieldKeys}
 * for priced-variant identity.
 */
export function variantMatchKeys(config: ProductSpecConfig, specs: Record<string, string>) {
  return pricingFieldKeys(config, specs);
}

export function isPositiveDecimal(value: string) {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) return false;
  const num = Number(trimmed);
  return Number.isFinite(num) && num > 0;
}

export function invalidNumericSpecFields(
  config: ProductSpecConfig,
  specs: Record<string, string>,
) {
  return visibleProductFields(config, specs)
    .filter((field) => field.type === "number")
    .filter((field) => {
      const value = String(specs[field.key] ?? "").trim();
      if (!value) return Boolean(field.required);
      return !isPositiveDecimal(value);
    })
    .map((field) => field.label);
}

export function missingPricingSpecFields(
  config: ProductSpecConfig,
  specs: Record<string, string>,
) {
  return pricingProductFields(config, specs)
    .filter((field) => field.required)
    .filter((field) => !String(specs[field.key] ?? "").trim())
    .map((field) => field.label);
}

export function pricingSpecsComplete(config: ProductSpecConfig, specs: Record<string, string>) {
  return (
    missingRequiredSpecFields(config, specs).length === 0 &&
    invalidNumericSpecFields(config, specs).length === 0
  );
}

/**
 * Normalize a pricing-spec value so 0.5 and 0.50 match, and text compares
 * case-insensitively with collapsed whitespace.
 */
export function normalizePricingSpecValue(
  key: string,
  value: unknown,
  config?: ProductSpecConfig | null,
): string {
  if (value == null || typeof value === "object") return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const field = config?.fields.find((item) => item.key === key);
  const numeric =
    field?.type === "number" ||
    Boolean(SPEC_UNITS[key] && SPEC_UNITS[key] !== "L") ||
    ["weightPerPiece", "netWeightKg", "capacityLitres", "breadth", "wireDiameterMm", "cutLengthMm"].includes(key);
  if (numeric || /^-?\d+(\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num)) {
      // Stable comparable form without trailing zeros noise.
      return String(num);
    }
  }
  return raw.replace(/\s+/g, " ").toLocaleLowerCase();
}

export function buildNormalizedPricingFingerprint(
  specs: Record<string, unknown>,
  keys: readonly string[],
  config?: ProductSpecConfig | null,
): string {
  return keys
    .map((key) => `${key}=${normalizePricingSpecValue(key, specs[key], config)}`)
    .join("|");
}

type VariantLike = {
  id: string;
  materialMasterId?: string | null;
  uom?: string;
  sellingPrice?: string | null;
  specs: Record<string, unknown>;
};

/**
 * Keys that participate in an exact priced match for the current form state.
 * Inactive conditional fields are excluded so stale values cannot affect matching.
 * Optional visible pricing fields (e.g. decorativeSubtype) still participate —
 * blank form value only matches a blank variant value.
 */
export function activePricingMatchKeys(
  config: ProductSpecConfig,
  specs: Record<string, string>,
): string[] {
  return pricingProductFields(config, specs).map((field) => field.key);
}

export function variantMatchesPricingSpecs(
  variantSpecs: Record<string, unknown>,
  formSpecs: Record<string, string>,
  keys: readonly string[],
  config?: ProductSpecConfig | null,
): boolean {
  return keys.every((key) => {
    const wanted = normalizePricingSpecValue(key, formSpecs[key], config);
    const actual = normalizePricingSpecValue(key, variantSpecs[key], config);
    return actual === wanted;
  });
}

export type ExactPricedVariantMatch<T extends VariantLike> = {
  status: "incomplete" | "exact" | "ambiguous" | "none";
  matches: T[];
  variant?: T;
};

/**
 * Exact priced-variant resolution. Unlike soft scoring, free-number pricing
 * fields (Rod diameter, Circle diameter, Farma length/breadth, Wire diameter)
 * must match exactly after numeric normalization.
 */
export function resolveExactPricedVariant<T extends VariantLike>(
  variants: T[],
  specs: Record<string, string>,
  config: ProductSpecConfig | null,
): ExactPricedVariantMatch<T> {
  if (!config) {
    const hidden = new Set<string>([...ALWAYS_HIDDEN_SPEC_KEYS, ...DROPPED_FORM_SPEC_KEYS]);
    const keys = Object.keys(specs).filter(
      (key) => !hidden.has(key) && String(specs[key] ?? "").trim(),
    );
    if (!keys.length) return { status: "incomplete", matches: [] };
    const matches = variants.filter((variant) =>
      variantMatchesPricingSpecs(variant.specs, specs, keys, null),
    );
    if (matches.length === 1) return { status: "exact", matches, variant: matches[0] };
    if (matches.length > 1) return { status: "ambiguous", matches };
    return { status: "none", matches: [] };
  }

  if (!pricingSpecsComplete(config, specs)) {
    return { status: "incomplete", matches: [] };
  }

  const keys = activePricingMatchKeys(config, specs);
  if (!keys.length) return { status: "incomplete", matches: [] };

  const matches = variants.filter((variant) =>
    variantMatchesPricingSpecs(variant.specs, specs, keys, config),
  );
  if (matches.length === 1) return { status: "exact", matches, variant: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "none", matches: [] };
}

/**
 * @deprecated Prefer {@link resolveExactPricedVariant}. Kept for call sites that
 * only need a single exact match (returns undefined when incomplete / none / ambiguous).
 */
export function findExactPricedVariantForSpecs<T extends VariantLike>(
  variants: T[],
  specs: Record<string, string>,
  config: ProductSpecConfig | null,
): T | undefined {
  const result = resolveExactPricedVariant(variants, specs, config);
  return result.status === "exact" ? result.variant : undefined;
}

/**
 * Exact priced match only. Soft / best-effort scoring was removed so catalog
 * rates never attach to a non-matching specification combination.
 */
export function findBestVariantForSpecs<T extends VariantLike>(
  variants: T[],
  specs: Record<string, string>,
  config: ProductSpecConfig | null,
): T | undefined {
  return findExactPricedVariantForSpecs(variants, specs, config);
}

/** Build a flat specs map from first-class columns + attributes JSON. */
export function flattenVariantSpecs(input: {
  grade?: string | null;
  finish?: string | null;
  thicknessMm?: string | number | null;
  widthMm?: string | number | null;
  lengthMm?: string | number | null;
  diameterMm?: string | number | null;
  attributes?: Record<string, unknown> | null;
  materialSpecs?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const attrs =
    input.attributes && typeof input.attributes === "object" && !Array.isArray(input.attributes)
      ? input.attributes
      : {};
  const saved =
    input.materialSpecs && typeof input.materialSpecs === "object" && !Array.isArray(input.materialSpecs)
      ? input.materialSpecs
      : {};
  return {
    ...Object.fromEntries(Object.entries(saved).filter(([key]) => key !== "seedMetadata")),
    ...Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== "seedMetadata")),
    grade: input.grade ?? attrs.grade ?? saved.grade,
    finish: input.finish ?? attrs.finish ?? saved.finish,
    thickness:
      input.thicknessMm != null && input.thicknessMm !== ""
        ? String(input.thicknessMm)
        : (attrs.thickness ?? saved.thickness),
    width:
      input.widthMm != null && input.widthMm !== ""
        ? String(input.widthMm)
        : (attrs.width ?? saved.width),
    length:
      input.lengthMm != null && input.lengthMm !== ""
        ? String(input.lengthMm)
        : (attrs.length ?? saved.length),
    diameter:
      input.diameterMm != null && input.diameterMm !== ""
        ? String(input.diameterMm)
        : (attrs.diameter ?? saved.diameter),
  };
}

export const RATE_PENDING_MESSAGE = "Is specification ka rate set karna baaki hai";
export const RATE_AMBIGUOUS_MESSAGE =
  "Multiple priced variants match these specifications. Fix duplicates in Product Master.";

/** Save & Apply Rate — master rate differs from submitted rate. */
export const RATE_CONFLICT_CODE = "RATE_CONFLICT";
export const RATE_CONFLICT_MESSAGE =
  "Product Master already has a different rate for this specification. Apply the existing rate or keep the master rate.";

/** Save & Apply Rate — lead/form pricing spec changed while the editor was open. */
export const STALE_SPECIFICATION_CODE = "STALE_SPECIFICATION";
export const STALE_SPECIFICATION_MESSAGE =
  "Specification changed while the rate editor was open. Review the updated specification and try again.";

function catalogRatesEqual(a: string | null | undefined, b: string) {
  const left = a != null && String(a).trim() !== "" ? Number(a) : NaN;
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) < 0.000_001;
}

/** Pure decision helper for concurrent/existing Product Master rate reuse. */
export function decideCatalogRateReuse(options: {
  existingRate: string | null;
  submittedRate: string;
  applyExistingRate?: boolean;
}): "reuse" | "conflict" | "fill_blank" {
  const { existingRate, submittedRate, applyExistingRate } = options;
  if (existingRate == null || existingRate === "") return "fill_blank";
  if (catalogRatesEqual(existingRate, submittedRate)) return "reuse";
  if (applyExistingRate) return "reuse";
  return "conflict";
}

export function designFileExtension(name: string) {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts.at(-1)! : "";
}

export function isAllowedDesignFile(file: { name: string; type: string; size: number }) {
  const ext = designFileExtension(file.name);
  if (!DESIGN_FILE_EXTENSIONS.has(ext)) return false;
  if (file.size <= 0 || file.size > DESIGN_FILE_MAX_BYTES) return false;
  if (file.type && !DESIGN_FILE_MIME_TYPES.has(file.type) && file.type !== "application/octet-stream") {
    return false;
  }
  return true;
}

export function extractDesignFileIds(specs: Record<string, unknown> | undefined) {
  if (!specs) return [] as string[];
  const ids = specs.designFileIds;
  if (Array.isArray(ids)) {
    return ids.filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  const files = specs.designFiles;
  if (Array.isArray(files)) {
    return files.flatMap((file) =>
      file && typeof file === "object" && "id" in file && typeof (file as { id: unknown }).id === "string"
        ? [(file as { id: string }).id]
        : [],
    );
  }
  return [];
}
