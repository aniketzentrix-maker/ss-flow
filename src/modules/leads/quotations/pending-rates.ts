import { AppError } from "@/lib/errors";
import {
  buildLeadItemLineTitle,
  type LeadItemLineSource,
} from "@/modules/leads/quotations/line-description";

export const QUOTATION_RATES_PENDING_CODE = "QUOTATION_RATES_PENDING";
export const QUOTATION_RATES_PENDING_MESSAGE =
  "Final quotation banane ke liye in items ka rate set karein:";

export type LeadItemRateFields = {
  marketPrice?: { toString(): string } | string | null;
  targetPrice?: { toString(): string } | string | null;
  priceOffered?: { toString(): string } | string | null;
};

export type PendingQuotationRateItem = {
  leadItemId: string;
  lineNumber: number;
  productName: string;
  specs: string[];
  label: string;
};

function decimalText(value: { toString(): string } | string | null | undefined) {
  if (value == null) return "";
  return String(value).trim();
}

/**
 * Saved lead quotation rate only — never live MaterialMaster.sellingPrice.
 * Zero / blank / non-positive rates are treated as pending (same zero-rate policy).
 */
export function leadItemHasSavedQuotationRate(item: LeadItemRateFields): boolean {
  const list =
    decimalText(item.marketPrice) || decimalText(item.targetPrice) || "";
  const rate =
    decimalText(item.priceOffered) ||
    decimalText(item.targetPrice) ||
    decimalText(item.marketPrice) ||
    "";
  if (!list || !rate) return false;
  const listNum = Number(list);
  const rateNum = Number(rate);
  return Number.isFinite(listNum) && listNum > 0 && Number.isFinite(rateNum) && rateNum > 0;
}

function parseSpecs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function specText(value: unknown) {
  if (value == null || value === "") return "";
  return String(value).trim();
}

/** Pipe-friendly saved-spec chips for pending-rate messages (variant match optional). */
export function buildPendingRateSpecParts(item: LeadItemLineSource): string[] {
  const specs = parseSpecs(item.specifications);
  const parts: string[] = [];

  const grade = specText(item.mfgGrade ?? specs.grade ?? item.product?.grade);
  if (grade) parts.push(/^ss\b/i.test(grade) ? grade : `SS ${grade}`);

  const thickness = specText(specs.thicknessConvertedMm ?? specs.thickness ?? item.gaugeThicknessMm?.toString());
  if (thickness) parts.push(`${thickness} mm`);

  const finish = specText(specs.finish ?? specs.finishOrCondition);
  if (finish) parts.push(finish);

  const width = specText(specs.widthConvertedMm ?? specs.width);
  if (width) parts.push(`${width} mm`);

  const diameter =
    specText(specs.diameter) ||
    specText(specs.wireDiameterMm) ||
    specText(specs.diameterConvertedMm);
  if (diameter) parts.push(`Ø ${diameter} mm`);

  const length = specText(specs.length);
  const breadth = specText(specs.breadth);
  if (length && breadth) parts.push(`${length} × ${breadth} mm`);
  else if (length) {
    const asMeters = Number(length);
    if (Number.isFinite(asMeters) && asMeters >= 1000 && asMeters % 1000 === 0) {
      parts.push(`${asMeters / 1000} m`);
    } else {
      parts.push(`L ${length} mm`);
    }
  } else if (breadth) {
    parts.push(`B ${breadth} mm`);
  }

  const cutLength = specText(specs.cutLengthMm);
  if (cutLength) parts.push(`Cut ${cutLength} mm`);

  const productForm = specText(specs.productForm);
  if (productForm) parts.push(productForm);

  const decorativeSubtype = specText(specs.decorativeSubtype);
  if (decorativeSubtype) parts.push(decorativeSubtype);

  const cutProfile = specText(specs.cutProfile);
  if (cutProfile) parts.push(cutProfile);

  const dimensions = specText(specs.dimensions);
  if (dimensions) parts.push(dimensions);

  const designReference = specText(specs.designReference);
  if (designReference) parts.push(designReference);

  const stage = specText(specs.stageOfManufacture);
  if (stage) parts.push(stage);

  const utensilType = specText(specs.utensilType);
  if (utensilType) parts.push(utensilType);

  const size = specText(item.sizeOrCapacity ?? specs.size);
  if (size && !parts.some((part) => part.includes(size))) parts.push(size);

  return parts;
}

export function formatPendingQuotationRateLabel(
  lineNumber: number,
  item: LeadItemLineSource,
): { productName: string; specs: string[]; label: string } {
  const productName = buildLeadItemLineTitle(item);
  const specs = buildPendingRateSpecParts(item);
  const body = [productName, ...specs].filter(Boolean).join(" | ");
  return {
    productName,
    specs,
    label: `Line ${lineNumber} — ${body}`,
  };
}

export function collectPendingQuotationRateItems<
  T extends LeadItemRateFields & LeadItemLineSource & { id: string },
>(items: T[]): PendingQuotationRateItem[] {
  return items.flatMap((item, index) => {
    if (leadItemHasSavedQuotationRate(item)) return [];
    const lineNumber = index + 1;
    const formatted = formatPendingQuotationRateLabel(lineNumber, item);
    return [
      {
        leadItemId: item.id,
        lineNumber,
        productName: formatted.productName,
        specs: formatted.specs,
        label: formatted.label,
      },
    ];
  });
}

/** Throws before any quotation header/lines are written when lead-sourced final quote has gaps. */
export function assertLeadItemsPricedForFinalQuotation<
  T extends LeadItemRateFields & LeadItemLineSource & { id: string },
>(items: T[]): void {
  const pendingItems = collectPendingQuotationRateItems(items);
  if (!pendingItems.length) return;
  const message = [QUOTATION_RATES_PENDING_MESSAGE, ...pendingItems.map((row) => `• ${row.label}`)].join(
    "\n",
  );
  throw new AppError(400, QUOTATION_RATES_PENDING_CODE, message, { pendingItems });
}
