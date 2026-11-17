"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { toast } from "@/components/toast";

type UnitRow = { id: string; name: string; symbol: string; unitType: string };
type MappingRow = {
  id?: string;
  unitId: string;
  isDefault: boolean;
  isActive: boolean;
  unit?: UnitRow;
};

export function CategoryUomPanel({ categoryId }: { categoryId: string }) {
  const keyRef = useRef(crypto.randomUUID());
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/categories/${categoryId}/uoms`);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error?.message ?? "Could not load category UOMs.");
        return;
      }
      setUnits(json.data.units ?? []);
      setMappings(
        (json.data.mappings ?? []).map((row: MappingRow) => ({
          unitId: row.unitId,
          isDefault: row.isDefault,
          isActive: row.isActive,
          unit: row.unit,
        })),
      );
    } finally {
      setLoading(false);
    }
  }, [categoryId]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleUnit(unitId: string) {
    setMappings((current) => {
      const existing = current.find((row) => row.unitId === unitId);
      if (existing) {
        const next = current.map((row) =>
          row.unitId === unitId ? { ...row, isActive: !row.isActive, isDefault: row.isActive ? false : row.isDefault } : row,
        );
        if (!next.some((row) => row.isActive && row.isDefault)) {
          const first = next.find((row) => row.isActive);
          if (first) {
            return next.map((row) => ({ ...row, isDefault: row.unitId === first.unitId }));
          }
        }
        return next;
      }
      const makeDefault = !current.some((row) => row.isActive && row.isDefault);
      return [...current, { unitId, isActive: true, isDefault: makeDefault }];
    });
  }

  function setDefault(unitId: string) {
    setMappings((current) =>
      current.map((row) => ({
        ...row,
        isDefault: row.unitId === unitId,
        isActive: row.unitId === unitId ? true : row.isActive,
      })),
    );
  }

  async function save() {
    const active = mappings.filter((row) => row.isActive);
    if (!active.length) {
      toast.error("Select at least one active UOM.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/categories/${categoryId}/uoms`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": keyRef.current,
        },
        body: JSON.stringify({
          mappings: mappings.map((row) => ({
            unitId: row.unitId,
            isActive: row.isActive,
            isDefault: row.isDefault,
          })),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error?.message ?? "Could not save UOM mappings.");
        return;
      }
      keyRef.current = crypto.randomUUID();
      toast.success("Category UOMs saved.");
      await load();
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-muted">Loading UOM mappings…</p>;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div>
        <h2 className="font-semibold">Allowed UOMs</h2>
        <p className="text-sm text-muted">
          Database-driven units for lead and transaction dropdowns under this category.
        </p>
      </div>
      <ul className="space-y-2">
        {units.map((unit) => {
          const mapping = mappings.find((row) => row.unitId === unit.id);
          const active = Boolean(mapping?.isActive);
          const isDefault = Boolean(mapping?.isDefault && active);
          return (
            <li
              key={unit.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm"
            >
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggleUnit(unit.id)}
                />
                <span className="font-medium">{unit.symbol}</span>
                <span className="text-muted">
                  {unit.name} · {unit.unitType}
                </span>
              </label>
              <button
                type="button"
                className={`text-xs font-semibold ${isDefault ? "text-info" : "text-muted hover:text-foreground"}`}
                onClick={() => setDefault(unit.id)}
              >
                {isDefault ? "Default" : "Make default"}
              </button>
            </li>
          );
        })}
      </ul>
      <Button pending={saving} onClick={() => void save()}>
        Save UOM mappings
      </Button>
    </section>
  );
}
