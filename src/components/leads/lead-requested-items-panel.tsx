"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Pencil, X } from "lucide-react";
import { toast } from "@/components/toast";
import { DataTable } from "@/components/detail";

export type LeadRequestedItemDraft = {
  id: string;
  category: string;
  description: string;
  sku: string;
  grade: string;
  thickness: string;
  finish: string;
  width: string;
  length: string;
  diameter: string;
  packing: string;
  quantity: string;
  uom: string;
  marketRate: string;
  offerRate: string;
  requiredDeliveryDate: string;
  promisedDeliveryDate: string;
  weight: string;
  /** Read-only rich cells used when not editing. */
  thicknessDisplay?: ReactNode;
  diameterDisplay?: ReactNode;
  dimensionsDisplay?: string;
  specificationsDisplay?: ReactNode;
  requiredDeliveryLabel?: string;
  promisedDeliveryLabel?: string;
};

const fieldClass =
  "h-11 w-full rounded-[10px] border border-border bg-card px-3 text-sm text-foreground outline-none transition placeholder:text-muted/70 focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/25";

const baseColumns = [
  { key: "category", label: "Category", minWidth: 100 },
  { key: "description", label: "Material / description", minWidth: 160 },
  { key: "sku", label: "SKU", minWidth: 120 },
  { key: "grade", label: "Grade", minWidth: 56 },
  { key: "thickness", label: "Thickness", minWidth: 72 },
  { key: "finish", label: "Finish", minWidth: 56 },
  { key: "dimensions", label: "Dimensions", minWidth: 88 },
  { key: "diameter", label: "Diameter", minWidth: 72 },
  { key: "packing", label: "Packing", minWidth: 88 },
  { key: "specifications", label: "Specifications", minWidth: 200 },
  { key: "quantity", label: "Qty", align: "right" as const, minWidth: 48 },
  { key: "uom", label: "UOM", minWidth: 44 },
  { key: "marketRate", label: "Market rate", align: "right" as const, minWidth: 88 },
  { key: "offerRate", label: "Offered to customer", align: "right" as const, minWidth: 100 },
  { key: "requiredDelivery", label: "Required", minWidth: 96 },
  { key: "promisedDelivery", label: "Promised", minWidth: 96 },
  { key: "weight", label: "Unit wt.", align: "right" as const, minWidth: 72 },
];

function dash(value: string) {
  return value.trim() ? value : "—";
}

function formatDimensions(width: string, length: string) {
  const w = width.trim();
  const l = length.trim();
  if (w && l) return `${w} × ${l}`;
  if (w) return `W ${w}`;
  if (l) return `L ${l}`;
  return "—";
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export function LeadRequestedItemsPanel({
  leadId,
  canEdit,
  items,
}: {
  leadId: string;
  canEdit: boolean;
  items: LeadRequestedItemDraft[];
}) {
  const router = useRouter();
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [draft, setDraft] = useState<LeadRequestedItemDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!draft) return;
    const latest = items.find((item) => item.id === draft.id);
    if (!latest) setDraft(null);
  }, [items, draft]);

  const columns = canEdit
    ? [...baseColumns, { key: "actions", label: "Action", align: "center" as const, minWidth: 64 }]
    : baseColumns;

  const displayRows = items.map((row) => {
    const late =
      Boolean(row.requiredDeliveryDate) &&
      Boolean(row.promisedDeliveryDate) &&
      row.promisedDeliveryDate > row.requiredDeliveryDate;

    return {
      category: row.category,
      description: row.description || "—",
      sku: row.sku,
      grade: dash(row.grade),
      thickness: row.thicknessDisplay ?? dash(row.thickness),
      finish: dash(row.finish),
      dimensions: row.dimensionsDisplay ?? formatDimensions(row.width, row.length),
      diameter: row.diameterDisplay ?? dash(row.diameter),
      packing: dash(row.packing),
      specifications: row.specificationsDisplay ?? "—",
      quantity: row.quantity,
      uom: row.uom,
      marketRate: row.marketRate,
      offerRate: row.offerRate,
      requiredDelivery: row.requiredDeliveryLabel || row.requiredDeliveryDate || "—",
      promisedDelivery: (
        <div className="space-y-1">
          <span>{row.promisedDeliveryLabel || row.promisedDeliveryDate || "—"}</span>
          {late ? (
            <p className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
              Later than required
            </p>
          ) : null}
        </div>
      ),
      weight: dash(row.weight),
      actions: canEdit ? (
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-lg border border-border text-info transition hover:border-info/40 hover:bg-info/10"
          aria-label={`Edit ${row.description || "item"}`}
          title="Edit item"
          onClick={() => setDraft({ ...row })}
        >
          <Pencil className="size-3.5" strokeWidth={2.2} />
        </button>
      ) : null,
    };
  });

  function patchDraft(patch: Partial<LeadRequestedItemDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function closeCard() {
    if (saving) return;
    setDraft(null);
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.quantity.trim() || Number(draft.quantity) <= 0) {
      toast.error("Quantity must be greater than zero.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/v1/leads/${leadId}/items`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          items: [
            {
              id: draft.id,
              itemDescription: draft.description.trim() || null,
              quantity: draft.quantity.trim(),
              uom: draft.uom.trim() || "PCS",
              grade: draft.grade.trim() || null,
              thickness: draft.thickness.trim() || null,
              finish: draft.finish.trim() || null,
              packing: draft.packing.trim() || null,
              width: draft.width.trim() || null,
              length: draft.length.trim() || null,
              diameter: draft.diameter.trim() || null,
              requiredDeliveryDate: draft.requiredDeliveryDate || null,
              promisedDeliveryDate: draft.promisedDeliveryDate || null,
            },
          ],
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(json?.error?.message ?? "Could not update requested item.");
        return;
      }
      idempotencyKeyRef.current = crypto.randomUUID();
      toast.success("Requested item updated.");
      setDraft(null);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const promisedLate =
    Boolean(draft?.requiredDeliveryDate) &&
    Boolean(draft?.promisedDeliveryDate) &&
    (draft?.promisedDeliveryDate ?? "") > (draft?.requiredDeliveryDate ?? "");

  return (
    <div className="space-y-3">
      {canEdit ? (
        <p className="px-4 pt-1 text-xs text-muted">
          Official follow-up is Pending — use the edit icon on a row to change that item.
        </p>
      ) : null}

      <div className="-mx-4 -mb-4">
        <DataTable minTableWidth={canEdit ? 1560 : 1500} columns={columns} rows={displayRows} />
      </div>

      {draft ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeCard();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-requested-item-title"
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-6"
          >
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h3 id="edit-requested-item-title" className="text-base font-semibold tracking-tight">
                  Edit requested item
                </h3>
                <p className="mt-1 text-sm text-muted">
                  {draft.sku && draft.sku !== "—" ? `${draft.sku} · ` : ""}
                  {draft.category || "Item"}
                </p>
              </div>
              <button
                type="button"
                className="inline-flex size-9 items-center justify-center rounded-lg border border-border text-muted hover:bg-muted/30 hover:text-foreground"
                aria-label="Close"
                onClick={closeCard}
                disabled={saving}
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Material / description" className="sm:col-span-2">
                <input
                  className={fieldClass}
                  value={draft.description}
                  onChange={(event) => patchDraft({ description: event.target.value })}
                />
              </Field>
              <Field label="Grade">
                <input
                  className={fieldClass}
                  value={draft.grade}
                  onChange={(event) => patchDraft({ grade: event.target.value })}
                />
              </Field>
              <Field label="Thickness (mm)">
                <input
                  className={fieldClass}
                  value={draft.thickness}
                  onChange={(event) => patchDraft({ thickness: event.target.value })}
                  placeholder="e.g. 0.9"
                />
              </Field>
              <Field label="Finish">
                <input
                  className={fieldClass}
                  value={draft.finish}
                  onChange={(event) => patchDraft({ finish: event.target.value })}
                />
              </Field>
              <Field label="Packing">
                <input
                  className={fieldClass}
                  value={draft.packing}
                  onChange={(event) => patchDraft({ packing: event.target.value })}
                />
              </Field>
              <Field label="Width">
                <input
                  className={fieldClass}
                  value={draft.width}
                  onChange={(event) => patchDraft({ width: event.target.value })}
                />
              </Field>
              <Field label="Length">
                <input
                  className={fieldClass}
                  value={draft.length}
                  onChange={(event) => patchDraft({ length: event.target.value })}
                />
              </Field>
              <Field label="Diameter">
                <input
                  className={fieldClass}
                  value={draft.diameter}
                  onChange={(event) => patchDraft({ diameter: event.target.value })}
                />
              </Field>
              <Field label="Quantity">
                <input
                  className={fieldClass}
                  type="number"
                  min="0.001"
                  step="any"
                  value={draft.quantity}
                  onChange={(event) => patchDraft({ quantity: event.target.value })}
                />
              </Field>
              <Field label="UOM">
                <input
                  className={fieldClass}
                  value={draft.uom}
                  onChange={(event) => patchDraft({ uom: event.target.value })}
                />
              </Field>
              <Field label="Required delivery">
                <input
                  className={fieldClass}
                  type="date"
                  value={draft.requiredDeliveryDate}
                  onChange={(event) => patchDraft({ requiredDeliveryDate: event.target.value })}
                />
              </Field>
              <Field label="Promised delivery">
                <input
                  className={fieldClass}
                  type="date"
                  value={draft.promisedDeliveryDate}
                  onChange={(event) => patchDraft({ promisedDeliveryDate: event.target.value })}
                />
              </Field>
            </div>

            {promisedLate ? (
              <p className="mt-4 rounded-lg border border-red-700 bg-red-600 p-3 text-sm text-white">
                <span className="font-semibold">Notice:</span> Promised delivery (
                {draft.promisedDeliveryDate}) is later than required ({draft.requiredDeliveryDate}).
              </p>
            ) : null}

            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="inline-flex h-10 items-center rounded-[10px] border border-border bg-card px-4 text-sm font-medium"
                onClick={closeCard}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex h-10 items-center rounded-[10px] bg-info px-4 text-sm font-semibold text-white disabled:opacity-60"
                onClick={() => void saveDraft()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save item"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
