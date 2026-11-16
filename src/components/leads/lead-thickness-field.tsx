"use client";

import { CreatableSpecSelect } from "@/components/ui/creatable-spec-select";
import {
  COMMON_SWG_GAUGES,
  formatThicknessMm,
  gaugeInputToThicknessMm,
  gaugeLabel,
  snapThicknessToOptions,
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
  datalistId = "lead-swg-gauge-list",
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
  const converted =
    unit === "gauge" && gaugeRaw ? gaugeInputToThicknessMm(gaugeRaw) : null;

  function setUnit(next: ThicknessInputUnit) {
    const nextSpecs: Record<string, string> = { ...specs, [THICKNESS_INPUT_UNIT_SPEC_KEY]: next };
    if (next === "mm") {
      delete nextSpecs[THICKNESS_GAUGE_SPEC_KEY];
      delete nextSpecs[THICKNESS_GAUGE_SYSTEM_SPEC_KEY];
      delete nextSpecs[THICKNESS_CONVERTED_MM_SPEC_KEY];
    } else {
      nextSpecs[THICKNESS_GAUGE_SYSTEM_SPEC_KEY] = "swg";
      if (mmValue) {
        nextSpecs[THICKNESS_GAUGE_SPEC_KEY] = "";
        delete nextSpecs.thickness;
      }
    }
    onSpecsChange(nextSpecs);
    if (next === "mm") onGaugeThicknessMm("");
  }

  function applyMmThickness(thickness: string) {
    const next: Record<string, string> = { ...specs, thickness };
    next[THICKNESS_INPUT_UNIT_SPEC_KEY] = "mm";
    delete next[THICKNESS_GAUGE_SPEC_KEY];
    delete next[THICKNESS_GAUGE_SYSTEM_SPEC_KEY];
    delete next[THICKNESS_CONVERTED_MM_SPEC_KEY];
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
      };
      delete next.thickness;
      onSpecsChange(next);
      onGaugeThicknessMm("");
      return;
    }
    if (mm == null) {
      const next: Record<string, string> = {
        ...specs,
        [THICKNESS_INPUT_UNIT_SPEC_KEY]: "gauge",
        [THICKNESS_GAUGE_SYSTEM_SPEC_KEY]: "swg",
        [THICKNESS_GAUGE_SPEC_KEY]: raw.trim(),
      };
      delete next.thickness;
      onSpecsChange(next);
      return;
    }
    const exactMm = formatThicknessMm(mm);
    const catalog = snapThicknessToOptions(mm, options);
    const next: Record<string, string> = {
      ...specs,
      [THICKNESS_INPUT_UNIT_SPEC_KEY]: "gauge",
      [THICKNESS_GAUGE_SYSTEM_SPEC_KEY]: "swg",
      [THICKNESS_GAUGE_SPEC_KEY]: raw.trim(),
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
          Gauge (SWG)
        </button>
      </div>

      {unit === "mm" ? (
        <CreatableSpecSelect
          fieldName="thickness"
          fieldLabel="Thickness"
          unit="mm"
          value={mmValue}
          disabled={disabled}
          onChange={(val) => applyMmThickness(val)}
          options={options}
          canCreate={canManageProducts}
          categoryId={categoryId}
          productId={parentProductId}
          ariaLabel="Thickness in mm"
        />
      ) : (
        <div className="space-y-2">
          <input
            className={fieldClass}
            type="number"
            min={1}
            max={30}
            step={1}
            disabled={disabled}
            placeholder="e.g. 20 for SWG 20"
            value={gaugeRaw.replace(/^swg\s*/i, "")}
            onChange={(e) => applyGauge(e.target.value)}
            list={datalistId}
          />
          <datalist id={datalistId}>
            {COMMON_SWG_GAUGES.map((g) => (
              <option key={g} value={String(g)} label={gaugeLabel(g)} />
            ))}
          </datalist>
          {converted != null ? (
            <p className="text-xs text-muted">
              Converted:{" "}
              <span className="font-semibold text-foreground">{formatThicknessMm(converted)} mm</span>
              {specs.thickness && specs.thickness !== formatThicknessMm(converted)
                ? ` · variant match ${specs.thickness} mm`
                : null}
            </p>
          ) : gaugeRaw.trim() ? (
            <p className="text-xs text-amber-700 dark:text-amber-200">Enter a valid SWG gauge (7–30).</p>
          ) : null}
        </div>
      )}
    </div>
  );
}