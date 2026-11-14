/** Standard Wire Gauge (SWG) — common for sheet/coil thickness in Indian trade. */
const SWG_TO_MM: Record<number, number> = {
  7: 4.064,
  8: 3.658,
  9: 3.251,
  10: 2.946,
  11: 2.642,
  12: 2.337,
  13: 2.032,
  14: 1.828,
  15: 1.626,
  16: 1.422,
  17: 1.219,
  18: 1.016,
  19: 0.914,
  20: 0.838,
  21: 0.737,
  22: 0.635,
  23: 0.533,
  24: 0.457,
  25: 0.381,
  26: 0.33,
  27: 0.279,
  28: 0.229,
  29: 0.178,
  30: 0.127,
};

export type ThicknessInputUnit = "mm" | "gauge";
export type GaugeSystem = "swg";

export const THICKNESS_INPUT_UNIT_SPEC_KEY = "thicknessInputUnit";
export const THICKNESS_GAUGE_SPEC_KEY = "thicknessGauge";
export const THICKNESS_GAUGE_SYSTEM_SPEC_KEY = "thicknessGaugeSystem";
/** Exact SWG→mm conversion (before optional catalog snap on `thickness`). */
export const THICKNESS_CONVERTED_MM_SPEC_KEY = "thicknessConvertedMm";

export const COMMON_SWG_GAUGES = [30, 28, 26, 24, 22, 20, 19, 18, 16, 14, 12, 10] as const;

export function parseGaugeNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/^swg\s*/i, "").replace(/\s*g(a)?u(ge)?$/i, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) return null;
  return num;
}

export function swgToThicknessMm(gauge: number): number | null {
  const exact = SWG_TO_MM[gauge];
  if (exact != null) return exact;
  const keys = Object.keys(SWG_TO_MM)
    .map(Number)
    .sort((a, b) => a - b);
  if (gauge < keys[0]! || gauge > keys[keys.length - 1]!) return null;
  return null;
}

export function gaugeInputToThicknessMm(raw: string, system: GaugeSystem = "swg"): number | null {
  if (system !== "swg") return null;
  const gauge = parseGaugeNumber(raw);
  if (gauge == null) return null;
  return swgToThicknessMm(gauge);
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

export function gaugeLabel(gauge: number, system: GaugeSystem = "swg"): string {
  return system === "swg" ? `SWG ${gauge}` : `Gauge ${gauge}`;
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
  return mm ? `${mm} mm` : "";
}