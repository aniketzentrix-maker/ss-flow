"use client";

import { CreatableSpecSelect } from "@/components/ui/creatable-spec-select";
import {
  COMMON_GAUGES,
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
  THICKNESS_GAUGE_SPEC_KEY,
  THICKNESS_GAUGE_SYSTEM_SPEC_KEY,
  THICKNESS_INPUT_UNIT_SPEC_KEY,
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

export function LeadThicknessField({
  specs,
  options,
  onSpecsChange,
  onGaugeThicknessMm,
  canManageProducts,
  categoryId,
  parentProductId,
  disabled,
}: {
  specs: Record<string, string>;
  options: string[];
  onSpecsChange: (next: Record<string, string>) => void;
  onGaugeThicknessMm: (mm: string) => void;
  canManageProducts: boolean;
  categoryId?: string;
  parentProductId?: string;
  disabled?: boolean;
  datalistId?: string;
}) {
  const unit: ThicknessInputUnit =
    specs[THICKNESS_INPUT_UNIT_SPEC_KEY] === "gauge" ? "gauge" : "mm";
  const gaugeRaw = specs[THICKNESS_GAUGE_SPEC_KEY] ?? "";
  const mmValue = specs.thickness ?? "";
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
    if (next === "mm") {
      const nextSpecs: Record<string, string> = {
        ...specs,
        [THICKNESS_INPUT_UNIT_SPEC_KEY]: "mm",
      };
      if (convertedFromGauge != null) {
        const exactMm = formatThicknessMm(convertedFromGauge);
        nextSpecs.thickness = snapThicknessToOptions(convertedFromGauge, mmOptions);
        nextSpecs[THICKNESS_CONVERTED_MM_SPEC_KEY] = exactMm;
        if (parseGaugeNumber(gaugeRaw) != null) {
          nextSpecs[THICKNESS_GAUGE_SPEC_KEY] = String(parseGaugeNumber(gaugeRaw));
          nextSpecs[THICKNESS_GAUGE_SYSTEM_SPEC_KEY] = "farma";
        }
        onSpecsChange(nextSpecs);
        onGaugeThicknessMm(exactMm);
        return;
      }
      delete nextSpecs[THICKNESS_GAUGE_SPEC_KEY];
      delete nextSpecs[THICKNESS_GAUGE_SYSTEM_SPEC_KEY];
      delete nextSpecs[THICKNESS_CONVERTED_MM_SPEC_KEY];
      onSpecsChange(nextSpecs);
      onGaugeThicknessMm(mmValue.trim());
      return;
    }

    const nextSpecs: Record<string, string> = {
      ...specs,
      [THICKNESS_INPUT_UNIT_SPEC_KEY]: "gauge",
      [THICKNESS_GAUGE_SYSTEM_SPEC_KEY]: "farma",
    };
    if (mmValue.trim()) {
      const matched = thicknessInputToGauge(mmValue);
      if (matched != null) {
        nextSpecs[THICKNESS_GAUGE_SPEC_KEY] = String(matched);
        const exactMm = formatThicknessMm(gaugeToThicknessMm(matched)!);
        nextSpecs[THICKNESS_CONVERTED_MM_SPEC_KEY] = exactMm;
        nextSpecs.thickness = snapThicknessToOptions(gaugeToThicknessMm(matched)!, mmOptions);
        onSpecsChange(nextSpecs);
        onGaugeThicknessMm(exactMm);
        return;
      }
      nextSpecs[THICKNESS_GAUGE_SPEC_KEY] = "";
      delete nextSpecs.thickness;
      delete nextSpecs[THICKNESS_CONVERTED_MM_SPEC_KEY];
    }
    onSpecsChange(nextSpecs);
  }

  function applyMmThickness(thickness: string) {
    const next: Record<string, string> = {
      ...specs,
      thickness,
      [THICKNESS_INPUT_UNIT_SPEC_KEY]: "mm",
    };
    const matchedGauge = thickness.trim() ? thicknessInputToGauge(thickness) : null;
    if (matchedGauge != null) {
      next[THICKNESS_GAUGE_SPEC_KEY] = String(matchedGauge);
      next[THICKNESS_GAUGE_SYSTEM_SPEC_KEY] = "farma";
      next[THICKNESS_CONVERTED_MM_SPEC_KEY] = formatThicknessMm(
        gaugeToThicknessMm(matchedGauge)!,
      );
    } else {
      delete next[THICKNESS_GAUGE_SPEC_KEY];
      delete next[THICKNESS_GAUGE_SYSTEM_SPEC_KEY];
      delete next[THICKNESS_CONVERTED_MM_SPEC_KEY];
    }
    if (!thickness.trim()) delete next.thickness;
    onSpecsChange(next);
    onGaugeThicknessMm(thickness.trim());
  }

  function applyGauge(raw: string) {
    const mm = gaugeInputToThicknessMm(raw);
    if (!raw.trim()) {
      const next: Record<string, string> = {
        ...specs,
        [THICKNESS_INPUT_UNIT_SPEC_KEY]: "gauge",
        [THICKNESS_GAUGE_SPEC_KEY]: "",
        [THICKNESS_GAUGE_SYSTEM_SPEC_KEY]: "farma",
      };
      delete next.thickness;
      delete next[THICKNESS_CONVERTED_MM_SPEC_KEY];
      onSpecsChange(next);
      onGaugeThicknessMm("");
      return;
    }
    if (mm == null) {
      const next: Record<string, string> = {
        ...specs,
        [THICKNESS_INPUT_UNIT_SPEC_KEY]: "gauge",
        [THICKNESS_GAUGE_SYSTEM_SPEC_KEY]: "farma",
        [THICKNESS_GAUGE_SPEC_KEY]: raw.trim(),
      };
      delete next.thickness;
      delete next[THICKNESS_CONVERTED_MM_SPEC_KEY];
      onSpecsChange(next);
      onGaugeThicknessMm("");
      return;
    }
    const exactMm = formatThicknessMm(mm);
    const catalog = snapThicknessToOptions(mm, mmOptions);
    const next: Record<string, string> = {
      ...specs,
      [THICKNESS_INPUT_UNIT_SPEC_KEY]: "gauge",
      [THICKNESS_GAUGE_SYSTEM_SPEC_KEY]: "farma",
      [THICKNESS_GAUGE_SPEC_KEY]: String(parseGaugeNumber(raw) ?? raw.trim()),
      [THICKNESS_CONVERTED_MM_SPEC_KEY]: exactMm,
      thickness: catalog,
    };
    onSpecsChange(next);
    onGaugeThicknessMm(exactMm);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={disabled} className={unitToggleClass(unit === "mm")} onClick={() => setUnit("mm")}>
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
            fieldName="thickness"
            fieldLabel="Thickness"
            unit="mm"
            value={mmValue}
            disabled={disabled}
            onChange={(val) => applyMmThickness(val)}
            options={mmOptions}
            canCreate={canManageProducts}
            categoryId={categoryId}
            productId={parentProductId}
            ariaLabel="Thickness in mm"
            placeholder="Select or type mm…"
          />
          {gaugeFromMm != null ? (
            <p className="text-xs text-muted">
              Chart gauge:{" "}
              <span className="font-semibold text-foreground">{gaugeLabel(gaugeFromMm)}</span>
            </p>
          ) : mmValue.trim() ? (
            <p className="text-xs text-muted">No gauge on Farma chart for this mm (e.g. 5 / 6 mm).</p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              className={fieldClass}
              disabled={disabled}
              aria-label="Select gauge from Farma chart"
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
              aria-label="Type gauge number"
              placeholder="Or type gauge…"
              value={gaugeRaw.replace(/^(swg|gauge)\s*/i, "")}
              onChange={(event) => applyGauge(event.target.value)}
            />
          </div>
          {convertedFromGauge != null ? (
            <p className="text-xs text-muted">
              Converted:{" "}
              <span className="font-semibold text-foreground">
                {formatThicknessMm(convertedFromGauge)} mm
              </span>
              {specs.thickness && specs.thickness !== formatThicknessMm(convertedFromGauge)
                ? ` · variant match ${specs.thickness} mm`
                : null}
            </p>
          ) : gaugeRaw.trim() ? (
            <p className="text-xs text-amber-700 dark:text-amber-200">
              Enter a Farma chart gauge (8–30). Missing odd sizes like 17 / 15 are not on the sheet.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
