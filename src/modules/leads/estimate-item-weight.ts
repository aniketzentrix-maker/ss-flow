import { gaugeInputToThicknessMm } from "@/lib/domain/sheet-gauge";
import { inchInputToMm } from "@/lib/domain/dimension-units";

/** Stainless steel bulk density: 8 g/cm³ → kg from mm³. */
const KG_PER_MM3 = 8 / 1_000_000;

function parsePositive(raw: string | undefined | null): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function thicknessMm(specs: Record<string, string>): number | null {
  return (
    parsePositive(specs.thicknessConvertedMm) ??
    parsePositive(specs.thickness) ??
    (specs.thicknessInputUnit === "gauge" && specs.thicknessGauge
      ? gaugeInputToThicknessMm(specs.thicknessGauge)
      : null)
  );
}

function widthMm(specs: Record<string, string>): number | null {
  return (
    parsePositive(specs.widthConvertedMm) ??
    parsePositive(specs.width) ??
    (specs.thicknessInputUnit === "gauge" && specs.widthGauge
      ? gaugeInputToThicknessMm(specs.widthGauge)
      : null)
  );
}

function diameterMm(specs: Record<string, string>): number | null {
  const keys = ["diameter", "wireDiameterMm", "innerDiameterMm", "outerDiameterMm"] as const;
  for (const key of keys) {
    if (specs[`${key}InputUnit`] === "inch") {
      const converted = parsePositive(specs[`${key}ConvertedMm`]);
      if (converted != null) return converted;
      const inch = specs[`${key}Inch`];
      if (inch) {
        const mm = inchInputToMm(inch);
        if (mm != null) return mm;
      }
    }
    const direct = parsePositive(specs[key]);
    if (direct != null) return direct;
  }
  return null;
}

function formatKg(kg: number): string {
  const rounded = Math.round(kg * 1000) / 1000;
  return String(rounded)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function volumeSheetKg(t: number, w: number, l: number) {
  return t * w * l * KG_PER_MM3;
}

function volumeCylinderKg(diameter: number, length: number) {
  const r = diameter / 2;
  return Math.PI * r * r * length * KG_PER_MM3;
}

function volumeDiscKg(diameter: number, thickness: number) {
  const r = diameter / 2;
  return Math.PI * r * r * thickness * KG_PER_MM3;
}

export type EstimateLeadItemWeightInput = {
  configId: string | null;
  uom: string;
  quantity: string;
  specs: Record<string, string>;
};

/**
 * Estimated line weight in kg for CRM / logistics hints.
 * Returns null when dimensions are insufficient.
 */
export function estimateLeadItemWeightKg(input: EstimateLeadItemWeightInput): string | null {
  const qty = parsePositive(input.quantity);
  if (qty == null) return null;

  const uom = input.uom.trim().toUpperCase();
  if (uom === "KG") return formatKg(qty);

  const specs = input.specs;
  const perPieceKg = parsePositive(specs.weightPerPiece);
  if (perPieceKg != null && (uom === "PCS" || uom === "PC" || uom === "PIECE" || uom === "PIECES")) {
    return formatKg(qty * perPieceKg);
  }

  const t = thicknessMm(specs);
  const w = widthMm(specs);
  const l = parsePositive(specs.length);
  const b = parsePositive(specs.breadth);
  const d = diameterMm(specs);
  const cutL = parsePositive(specs.cutLengthMm);

  const config = input.configId;

  let unitKg: number | null = null;

  if (config === "circle" && d != null && t != null) {
    unitKg = volumeDiscKg(d, t);
  } else if (config === "rod" && d != null && l != null) {
    unitKg = volumeCylinderKg(d, l);
  } else if (config === "wire") {
    const wireD = parsePositive(specs.wireDiameterMm) ?? d;
    if (wireD != null && cutL != null) unitKg = volumeCylinderKg(wireD, cutL);
  } else if (config === "farma" || config === "laser_cut_farma") {
    if (t != null && l != null && b != null) unitKg = volumeSheetKg(t, b, l);
    else if (t != null && w != null && l != null) unitKg = volumeSheetKg(t, w, l);
  } else if (config === "sheet" || config === "coil" || config === "semi_finish_utensils") {
    if (t != null && w != null && l != null) unitKg = volumeSheetKg(t, w, l);
  } else {
    if (t != null && w != null && l != null) unitKg = volumeSheetKg(t, w, l);
    else if (d != null && t != null) unitKg = volumeDiscKg(d, t);
    else if (d != null && l != null) unitKg = volumeCylinderKg(d, l);
  }

  if (unitKg == null) return null;
  return formatKg(unitKg * qty);
}