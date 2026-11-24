/**
 * Team Farma weight chart — gauge ↔ thickness (mm).
 * Source: FARMA WEIGHT CHART used by SS-Metals.
 */
const GAUGE_TO_MM: Record<number, number> = {
  30: 0.3,
  29: 0.35,
  28: 0.4,
  27: 0.45,
  26: 0.5,
  25: 0.55,
  24: 0.6,
  23: 0.65,
  22: 0.7,
  21: 0.8,
  20: 0.9,
  19: 1.0,
  18: 1.2,
  16: 1.5,
  14: 2.0,
  12: 2.5,
  10: 3.0,
  8: 4.0,
};

/** Thickness values on the chart, including mm-only rows (5.00 / 6.00). */
export const CHART_THICKNESS_MM = [
  0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0,
] as const;

export type ThicknessInputUnit = "mm" | "gauge";
/** Kept for stored specs; values follow the Farma chart (not British SWG). */
export type GaugeSystem = "swg" | "farma";

export const THICKNESS_INPUT_UNIT_SPEC_KEY = "thicknessInputUnit";
export const THICKNESS_GAUGE_SPEC_KEY = "thicknessGauge";
export const THICKNESS_GAUGE_SYSTEM_SPEC_KEY = "thicknessGaugeSystem";
/** Exact gauge→mm conversion (before optional catalog snap on `thickness`). */
export const THICKNESS_CONVERTED_MM_SPEC_KEY = "thicknessConvertedMm";

/** Gauges present on the Farma sheet (highest → lowest). */
export const COMMON_SWG_GAUGES = [
  30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 16, 14, 12, 10, 8,
] as const;

export const COMMON_GAUGES = COMMON_SWG_GAUGES;

export function parseGaugeNumber(raw: string): number | null {
  const cleaned = raw
    .trim()
    .replace(/^(swg|gauge)\s*/i, "")
    .replace(/\s*g(a)?u(ge)?$/i, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) return null;
  return num;
}

export function gaugeToThicknessMm(gauge: number): number | null {
  const exact = GAUGE_TO_MM[gauge];
  return exact != null ? exact : null;
}

/** @deprecated Prefer gaugeToThicknessMm — same Farma chart mapping. */
export function swgToThicknessMm(gauge: number): number | null {
  return gaugeToThicknessMm(gauge);
}

export function gaugeInputToThicknessMm(raw: string, _system: GaugeSystem = "farma"): number | null {
  const gauge = parseGaugeNumber(raw);
  if (gauge == null) return null;
  return gaugeToThicknessMm(gauge);
}

/** Reverse lookup: mm → gauge when it matches the Farma chart. */
export function thicknessMmToGauge(mm: number, toleranceMm = 0.001): number | null {
  if (!Number.isFinite(mm) || mm <= 0) return null;
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const [gaugeRaw, chartMm] of Object.entries(GAUGE_TO_MM)) {
    const diff = Math.abs(chartMm - mm);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = Number(gaugeRaw);
    }
  }
  return best != null && bestDiff <= toleranceMm ? best : null;
}

export function thicknessInputToGauge(raw: string, toleranceMm = 0.001): number | null {
  const cleaned = raw.trim().replace(/\s*mm$/i, "");
  const mm = Number(cleaned);
  if (!Number.isFinite(mm) || mm <= 0) return null;
  return thicknessMmToGauge(mm, toleranceMm);
}

/** Canonical mm string for catalog matching (up to 3 decimals, trim trailing zeros). */
export function formatThicknessMm(mm: number): string {
  if (!Number.isFinite(mm) || mm <= 0) return "";
  const rounded = Math.round(mm * 1000) / 1000;
  return String(rounded)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/**
 * Pick the closest catalog thickness option when exact converted mm is not listed.
 */
export function snapThicknessToOptions(mm: number, options: string[], toleranceMm = 0.12): string {
  const direct = formatThicknessMm(mm);
  if (options.includes(direct)) return direct;
  const alt = mm.toFixed(2).replace(/\.?0+$/, "");
  if (options.includes(alt)) return alt;
  let best = direct;
  let bestDiff = Infinity;
  for (const opt of options) {
    const n = Number(opt);
    if (!Number.isFinite(n)) continue;
    const diff = Math.abs(n - mm);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt;
    }
  }
  return bestDiff <= toleranceMm ? best : direct;
}

export function gaugeLabel(gauge: number, _system: GaugeSystem = "farma"): string {
  return `Gauge ${gauge}`;
}

export function gaugeOptionLabel(gauge: number): string {
  const mm = gaugeToThicknessMm(gauge);
  return mm != null ? `Gauge ${gauge} · ${formatThicknessMm(mm)} mm` : `Gauge ${gauge}`;
}

/** Merge Farma chart mm values with product catalog thickness options. */
export function thicknessMmOptions(catalogOptions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...CHART_THICKNESS_MM.map((mm) => formatThicknessMm(mm)), ...catalogOptions]) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.sort((a, b) => Number(a) - Number(b));
}

export function thicknessMmDisplayFromSpecs(specs: Record<string, string>): string {
  const unit = specs[THICKNESS_INPUT_UNIT_SPEC_KEY];
  const mm = specs.thickness?.trim();
  if (unit === "gauge") {
    const g = specs[THICKNESS_GAUGE_SPEC_KEY];
    const converted = g ? gaugeInputToThicknessMm(g) : null;
    if (converted != null) {
      return `${formatThicknessMm(converted)} mm (${gaugeLabel(parseGaugeNumber(g) ?? 0)})`;
    }
  }
  if (mm) {
    const gauge = thicknessInputToGauge(mm);
    return gauge != null ? `${mm} mm (${gaugeLabel(gauge)})` : `${mm} mm`;
  }
  return "";
}
