import {
  formatThicknessMm,
  gaugeInputToThicknessMm,
  gaugeLabel,
  parseGaugeNumber,
  thicknessMmToGauge,
  THICKNESS_CONVERTED_MM_SPEC_KEY,
  THICKNESS_GAUGE_SPEC_KEY,
  THICKNESS_INPUT_UNIT_SPEC_KEY,
} from "@/lib/domain/sheet-gauge";

export const INCH_TO_MM = 25.4;

/** Spec keys that support mm / inch entry on the lead form. */
export const INCH_CONVERTIBLE_SPEC_KEYS = new Set([
  "diameter",
  "wireDiameterMm",
  "innerDiameterMm",
  "outerDiameterMm",
]);

export function dimensionMetaKeys(specKey: string) {
  return {
    inputUnit: `${specKey}InputUnit`,
    enteredInch: `${specKey}Inch`,
    convertedMm: `${specKey}ConvertedMm`,
  };
}

export function isInchConvertibleSpecKey(key: string) {
  return INCH_CONVERTIBLE_SPEC_KEYS.has(key);
}

export function parseInchValue(raw: string): number | null {
  const cleaned = raw.trim().replace(/"$/, "").replace(/\s*in(ch(es)?)?$/i, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

export function inchToMm(inches: number): number {
  return Math.round(inches * INCH_TO_MM * 1000) / 1000;
}

export function formatLinearMm(mm: number): string {
  return formatThicknessMm(mm);
}

export function inchInputToMm(raw: string): number | null {
  const inches = parseInchValue(raw);
  if (inches == null) return null;
  return inchToMm(inches);
}

type SpecBag = Record<string, unknown>;

function specStr(specs: SpecBag, key: string) {
  const v = specs[key];
  if (v == null || v === "") return "";
  return String(v).trim();
}

/** Human-readable thickness for tables (plain text). */
export function thicknessDisplayText(
  specs: SpecBag,
  fallbackMm?: string | null,
): string {
  const unit = specStr(specs, THICKNESS_INPUT_UNIT_SPEC_KEY);
  const catalogMm = specStr(specs, "thickness") || fallbackMm || "";
  if (unit === "gauge") {
    const gaugeRaw = specStr(specs, THICKNESS_GAUGE_SPEC_KEY);
    const converted =
      specStr(specs, THICKNESS_CONVERTED_MM_SPEC_KEY) ||
      (gaugeRaw ? formatLinearMm(gaugeInputToThicknessMm(gaugeRaw) ?? 0) : "");
    const gaugeNum = parseGaugeNumber(gaugeRaw);
    const entered = gaugeNum != null ? gaugeLabel(gaugeNum) : gaugeRaw;
    if (entered && converted) {
      const used =
        catalogMm && catalogMm !== converted
          ? `; catalog value ${catalogMm} mm`
          : catalogMm
            ? `; stored as ${catalogMm} mm`
            : "";
      return `Entered ${entered} → ${converted} mm${used}`;
    }
  }
  return catalogMm ? `${catalogMm} mm` : fallbackMm ? `${fallbackMm} mm` : "—";
}

/** Human-readable diameter (or other inch-convertible field) for tables. */
export function inchDimensionDisplayText(specKey: string, specs: SpecBag): string {
  const meta = dimensionMetaKeys(specKey);
  const unit = specStr(specs, meta.inputUnit);
  const mmVal = specStr(specs, specKey);
  if (unit === "inch") {
    const inchRaw = specStr(specs, meta.enteredInch);
    const converted = specStr(specs, meta.convertedMm) || mmVal;
    if (inchRaw && converted) {
      return `Entered ${inchRaw}" → ${converted} mm`;
    }
  }
  return mmVal ? `${mmVal} mm` : "—";
}

export function thicknessDisplayParts(
  specs: SpecBag,
  fallbackMm?: string | null,
): { entered?: string; converted?: string; note?: string } | null {
  const unit = specStr(specs, THICKNESS_INPUT_UNIT_SPEC_KEY);
  const mm =
    specStr(specs, THICKNESS_CONVERTED_MM_SPEC_KEY) ||
    specStr(specs, "thickness") ||
    fallbackMm ||
    "";
  const gaugeRaw = specStr(specs, THICKNESS_GAUGE_SPEC_KEY);
  const gaugeNum =
    parseGaugeNumber(gaugeRaw) ??
    (mm ? thicknessMmToGauge(Number(mm)) : null);

  if (unit === "gauge" || gaugeNum != null) {
    const entered =
      gaugeNum != null
        ? `Gauge: ${gaugeLabel(gaugeNum)}`
        : gaugeRaw
          ? `Gauge: ${gaugeRaw}`
          : undefined;
    const convertedFromGauge =
      gaugeRaw && gaugeInputToThicknessMm(gaugeRaw) != null
        ? formatLinearMm(gaugeInputToThicknessMm(gaugeRaw)!)
        : gaugeNum != null && gaugeInputToThicknessMm(String(gaugeNum)) != null
          ? formatLinearMm(gaugeInputToThicknessMm(String(gaugeNum))!)
          : "";
    const convertedMm = convertedFromGauge || (mm ? formatLinearMm(Number(mm)) || mm : "");
    const catalog = specStr(specs, "thickness");
    if (!entered && !convertedMm) return null;
    let note: string | undefined;
    if (catalog && convertedMm && catalog !== convertedMm) {
      note = `Catalog / variant match uses ${catalog} mm`;
    }
    return {
      entered,
      converted: convertedMm ? `Thickness: ${convertedMm} mm` : undefined,
      note,
    };
  }

  return mm ? { converted: `Thickness: ${mm} mm` } : null;
}

export function inchDimensionDisplayParts(
  specKey: string,
  specs: SpecBag,
): { entered?: string; converted?: string } | null {
  const meta = dimensionMetaKeys(specKey);
  const unit = specStr(specs, meta.inputUnit);
  if (unit !== "inch") {
    const mm = specStr(specs, specKey);
    return mm ? { converted: `${mm} mm` } : null;
  }
  const inchRaw = specStr(specs, meta.enteredInch);
  const converted =
    specStr(specs, meta.convertedMm) || specStr(specs, specKey);
  if (!inchRaw && !converted) return null;
  return {
    entered: inchRaw ? `Entered: ${inchRaw} inch` : undefined,
    converted: converted ? `Converted: ${converted} mm` : undefined,
  };
}