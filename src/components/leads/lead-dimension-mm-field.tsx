"use client";

import {
  dimensionMetaKeys,
  formatLinearMm,
  inchInputToMm,
  parseInchValue,
} from "@/lib/domain/dimension-units";

const fieldClass =
  "h-11 w-full rounded-[10px] border border-border bg-card px-3 text-sm text-foreground outline-none transition placeholder:text-muted/70 focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/25";

const unitToggleClass = (active: boolean) =>
  `rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
    active
      ? "border-info bg-info/10 text-info"
      : "border-border bg-card text-muted hover:bg-muted/40"
  }`;

type DimensionSpecKey = "diameter" | "wireDiameterMm" | "innerDiameterMm" | "outerDiameterMm";

export function LeadDimensionMmField({
  specKey,
  label,
  specs,
  onSpecsChange,
  disabled,
}: {
  specKey: DimensionSpecKey;
  label: string;
  specs: Record<string, string>;
  onSpecsChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const meta = dimensionMetaKeys(specKey);
  const unit = specs[meta.inputUnit] === "inch" ? "inch" : "mm";
  const mmValue = specs[specKey] ?? "";
  const inchRaw = specs[meta.enteredInch] ?? "";
  const convertedPreview =
    unit === "inch" && inchRaw ? inchInputToMm(inchRaw) : null;

  function setUnit(next: "mm" | "inch") {
    const nextSpecs = { ...specs, [meta.inputUnit]: next };
    if (next === "mm") {
      delete nextSpecs[meta.enteredInch];
      delete nextSpecs[meta.convertedMm];
    } else {
      delete nextSpecs[specKey];
      nextSpecs[meta.enteredInch] = "";
    }
    onSpecsChange(nextSpecs);
  }

  function applyMm(value: string) {
    const next = { ...specs };
    next[meta.inputUnit] = "mm";
    delete next[meta.enteredInch];
    delete next[meta.convertedMm];
    if (value.trim()) next[specKey] = value.trim();
    else delete next[specKey];
    onSpecsChange(next);
  }

  function applyInch(raw: string) {
    if (!raw.trim()) {
      const next = { ...specs, [meta.inputUnit]: "inch", [meta.enteredInch]: "" };
      delete next[specKey];
      delete next[meta.convertedMm];
      onSpecsChange(next);
      return;
    }
    const mm = inchInputToMm(raw);
    if (mm == null) {
      onSpecsChange({
        ...specs,
        [meta.inputUnit]: "inch",
        [meta.enteredInch]: raw.trim(),
      });
      return;
    }
    const exact = formatLinearMm(mm);
    onSpecsChange({
      ...specs,
      [meta.inputUnit]: "inch",
      [meta.enteredInch]: raw.trim(),
      [meta.convertedMm]: exact,
      [specKey]: exact,
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={disabled} className={unitToggleClass(unit === "mm")} onClick={() => setUnit("mm")}>
          mm
        </button>
        <button type="button" disabled={disabled} className={unitToggleClass(unit === "inch")} onClick={() => setUnit("inch")}>
          inch
        </button>
      </div>

      {unit === "mm" ? (
        <input
          className={fieldClass}
          type="number"
          min="0.001"
          step="any"
          disabled={disabled}
          placeholder={`${label} in mm`}
          value={mmValue}
          onChange={(e) => applyMm(e.target.value)}
        />
      ) : (
        <div className="space-y-2">
          <input
            className={fieldClass}
            type="text"
            inputMode="decimal"
            disabled={disabled}
            placeholder={`e.g. 8 or 8.5 inch`}
            value={inchRaw}
            onChange={(e) => applyInch(e.target.value)}
          />
          {convertedPreview != null ? (
            <p className="text-xs text-muted">
              Converted:{" "}
              <span className="font-semibold text-foreground">{formatLinearMm(convertedPreview)} mm</span>
            </p>
          ) : inchRaw.trim() && parseInchValue(inchRaw) == null ? (
            <p className="text-xs text-amber-700 dark:text-amber-200">Enter a valid inch value.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}