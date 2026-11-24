"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";

type ItemDraft = {
  id: string;
  label: string;
  quantity: string;
  uom: string;
  requiredDeliveryDate: string;
  promisedDeliveryDate: string;
};

const fieldClass =
  "h-11 w-full rounded-[10px] border border-border bg-card px-3 text-sm text-foreground outline-none transition placeholder:text-muted/70 focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/25";

export function LeadEditDeliveryForm({
  leadId,
  leadNumber,
  items,
}: {
  leadId: string;
  leadNumber: string;
  items: ItemDraft[];
}) {
  const router = useRouter();
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [rows, setRows] = useState(items);
  const [saving, setSaving] = useState(false);

  function updateRow(id: string, patch: Partial<ItemDraft>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch(`/api/v1/leads/${leadId}/dates`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          items: rows.map((row) => ({
            id: row.id,
            requiredDeliveryDate: row.requiredDeliveryDate || null,
            promisedDeliveryDate: row.promisedDeliveryDate || null,
          })),
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(json?.error?.message ?? "Could not update delivery dates.");
        return;
      }
      idempotencyKeyRef.current = crypto.randomUUID();
      toast.success("Delivery dates updated.");
      router.push(`/leads/${leadId}`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <header className="mb-5">
          <h2 className="text-base font-semibold tracking-tight">
            Edit delivery dates · {leadNumber}
          </h2>
          <p className="text-sm text-muted">
            Set required (customer demand) and promised (company commitment) dates per product.
          </p>
        </header>

        <div className="space-y-4">
          {rows.map((row) => {
            const late =
              Boolean(row.requiredDeliveryDate) &&
              Boolean(row.promisedDeliveryDate) &&
              row.promisedDeliveryDate > row.requiredDeliveryDate;
            return (
              <div key={row.id} className="rounded-xl border border-border/80 bg-muted/10 p-4">
                <div className="mb-3">
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-xs text-muted">
                    Qty {row.quantity} {row.uom}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-[13px] font-medium text-muted">
                      Required delivery
                      <span className="ml-1 text-xs font-normal text-muted/80">(customer demand)</span>
                    </span>
                    <input
                      className={fieldClass}
                      type="date"
                      value={row.requiredDeliveryDate}
                      onChange={(event) =>
                        updateRow(row.id, { requiredDeliveryDate: event.target.value })
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[13px] font-medium text-muted">
                      Promised delivery
                      <span className="ml-1 text-xs font-normal text-muted/80">(company commitment)</span>
                    </span>
                    <input
                      className={fieldClass}
                      type="date"
                      value={row.promisedDeliveryDate}
                      onChange={(event) =>
                        updateRow(row.id, { promisedDeliveryDate: event.target.value })
                      }
                    />
                  </label>
                </div>
                {late ? (
                  <p className="mt-2 rounded-lg border border-red-700 bg-red-600 p-3 text-sm text-white">
                    Notice: Promised delivery ({row.promisedDeliveryDate}) is later than required (
                    {row.requiredDeliveryDate}).
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Link href={`/leads/${leadId}`} className="btn-secondary h-11 px-5">
          Cancel
        </Link>
        <button
          type="button"
          disabled={saving || !rows.length}
          onClick={() => void save()}
          className="inline-flex h-11 items-center justify-center rounded-[10px] bg-info px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save delivery dates"}
        </button>
      </div>
    </div>
  );
}
