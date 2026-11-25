"use client";

import { CreatableSpecSelect } from "@/components/ui/creatable-spec-select";
import {
  COMMON_GAUGES,
  applySharedMmGaugeUnit,
  formatThicknessMm,
  gaugeInputToThicknessMm,
  gaugeLabel,
  gaugeOptionLabel,
  gaugeToThicknessMm,
  parseGaugeNumber,
  snapThicknessToOptions,
  thicknessInputToGauge,
  thicknessMmOptions,
  THICKNESS_CONVERTED_MM_SPEC_KEY,
  THICKNESS_INPUT_UNIT_SPEC_KEY,
  WIDTH_CONVERTED_MM_SPEC_KEY,
  WIDTH_GAUGE_SPEC_KEY,
  type ThicknessInputUnit,
} from "@/lib/domain/sheet-gauge";

const fieldClass =
  "h-11 w-full rounded-[10px] border border-border bg-card px-3 text-sm text-foreground outline-none transition placeholder:text-muted/70 focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/25";

const unitToggleClass = (active: boolean) =>
  `rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
    active
      ? "border-info bg-info/10 text-info"
      : "border-border bg-card text-muted hover:bg-muted/40"
  }`;

export function LeadWidthField({
  specs,
  options,
  thicknessOptions = [],
  onSpecsChange,
  onSharedUnitChange,
  canManageProducts,
  categoryId,
  parentProductId,
  disabled,
}: {
  specs: Record<string, string>;
  options: string[];
  /** Catalog thickness options — needed when this field switches the shared unit. */
  thicknessOptions?: string[];
  onSpecsChange: (next: Record<string, string>) => void;
  /** Notifies parent of converted thickness mm when shared unit changes. */
  onSharedUnitChange?: (thicknessMm: string) => void;
  canManageProducts: boolean;
  categoryId?: string;
  parentProductId?: string;
  disabled?: boolean;
}) {
  const unit: ThicknessInputUnit =
    specs[THICKNESS_INPUT_UNIT_SPEC_KEY] === "gauge" ? "gauge" : "mm";
  const gaugeRaw = specs[WIDTH_GAUGE_SPEC_KEY] ?? "";
  const mmValue = specs.width ?? "";
  const mmOptions = thicknessMmOptions(options);
  const gaugeOptions = COMMON_GAUGES.map((gauge) => ({
    value: String(gauge),
    label: gaugeOptionLabel(gauge),
  }));

  const convertedFromGauge =
    unit === "gauge" && gaugeRaw ? gaugeInputToThicknessMm(gaugeRaw) : null;
  const gaugeFromMm =
    unit === "mm" && mmValue.trim() ? thicknessInputToGauge(mmValue) : null;

  function setUnit(next: ThicknessInputUnit) {
    const nextSpecs = applySharedMmGaugeUnit(specs, next, thicknessOptions, options);
    onSpecsChange(nextSpecs);
    onSharedUnitChange?.(
      nextSpecs[THICKNESS_CONVERTED_MM_SPEC_KEY]?.trim() || nextSpecs.thickness?.trim() || "",
    );
  }

  function applyMmWidth(width: string) {
    const next: Record<string, string> = { ...specs, width };
    const matchedGauge = width.trim() ? thicknessInputToGauge(width) : null;
    if (matchedGauge != null) {
      next[WIDTH_GAUGE_SPEC_KEY] = String(matchedGauge);
      next[WIDTH_CONVERTED_MM_SPEC_KEY] = formatThicknessMm(gaugeToThicknessMm(matchedGauge)!);
    } else {
      delete next[WIDTH_GAUGE_SPEC_KEY];
      delete next[WIDTH_CONVERTED_MM_SPEC_KEY];
    }
    if (!width.trim()) delete next.width;
    onSpecsChange(next);
  }

  function applyGauge(raw: string) {
    const mm = gaugeInputToThicknessMm(raw);
    if (!raw.trim()) {
      const next: Record<string, string> = {
        ...specs,
        [WIDTH_GAUGE_SPEC_KEY]: "",
      };
      delete next.width;
      delete next[WIDTH_CONVERTED_MM_SPEC_KEY];
      onSpecsChange(next);
      return;
    }
    if (mm == null) {
      const next: Record<string, string> = {
        ...specs,
        [WIDTH_GAUGE_SPEC_KEY]: raw.trim(),
      };
      delete next.width;
      delete next[WIDTH_CONVERTED_MM_SPEC_KEY];
      onSpecsChange(next);
      return;
    }
    const exactMm = formatThicknessMm(mm);
    const catalog = snapThicknessToOptions(mm, mmOptions);
    onSpecsChange({
      ...specs,
      [WIDTH_GAUGE_SPEC_KEY]: String(parseGaugeNumber(raw) ?? raw.trim()),
      [WIDTH_CONVERTED_MM_SPEC_KEY]: exactMm,
      width: catalog,
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          className={unitToggleClass(unit === "mm")}
          onClick={() => setUnit("mm")}
        >
          mm
        </button>
        <button
          type="button"
          disabled={disabled}
          className={unitToggleClass(unit === "gauge")}
          onClick={() => setUnit("gauge")}
        >
          Gauge
        </button>
      </div>

      {unit === "mm" ? (
        <div className="space-y-2">
          <CreatableSpecSelect
            fieldName="width"
            fieldLabel="Width"
            unit="mm"
            value={mmValue}
            disabled={disabled}
            onChange={(val) => applyMmWidth(val)}
            options={mmOptions}
            canCreate={canManageProducts}
            categoryId={categoryId}
            productId={parentProductId}
            ariaLabel="Width in mm"
            placeholder="Select or type mm…"
          />
          {gaugeFromMm != null ? (
            <p className="text-xs text-muted">
              Gauge{" "}
              <span className="font-semibold text-foreground">{gaugeLabel(gaugeFromMm)}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              className={fieldClass}
              disabled={disabled}
              aria-label="Select width gauge from Farma chart"
              value={
                COMMON_GAUGES.some((g) => String(g) === gaugeRaw.replace(/^(swg|gauge)\s*/i, ""))
                  ? gaugeRaw.replace(/^(swg|gauge)\s*/i, "")
                  : ""
              }
              onChange={(event) => applyGauge(event.target.value)}
            >
              <option value="">Select gauge…</option>
              {gaugeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <input
              className={fieldClass}
              type="number"
              min={8}
              max={30}
              step={1}
              disabled={disabled}
              aria-label="Type width gauge number"
              placeholder="Or type gauge…"
              value={gaugeRaw.replace(/^(swg|gauge)\s*/i, "")}
              onChange={(event) => applyGauge(event.target.value)}
            />
          </div>
          {convertedFromGauge != null ? (
            <p className="text-xs text-muted">
              <span className="font-semibold text-foreground">
                {formatThicknessMm(convertedFromGauge)} mm
              </span>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
