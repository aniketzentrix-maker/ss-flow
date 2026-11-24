import { quotationMaxDiscountPct } from "@/modules/leads/quotations/config";

export type QuotationLineInput = {
  listRate?: string | null;
  rate: string;
};

export function lineDiscountPct(listRate: number, rate: number) {
  if (!Number.isFinite(listRate) || listRate <= 0) return 0;
  if (!Number.isFinite(rate) || rate < 0) return 0;
  const pct = ((listRate - rate) / listRate) * 100;
  return Math.max(0, Math.round(pct * 1000) / 1000);
}

export function quotationNeedsDiscountApproval(lines: QuotationLineInput[]) {
  const limit = quotationMaxDiscountPct();
  for (const line of lines) {
    const list = Number(line.listRate ?? 0);
    const rate = Number(line.rate);
    if (!list || !Number.isFinite(rate)) continue;
    if (lineDiscountPct(list, rate) > limit) return true;
  }
  return false;
}

/** Admin must approve any customer-facing offer price before send. */
export function quotationNeedsPricingApproval(lines: QuotationLineInput[]) {
  for (const line of lines) {
    const raw = line.rate?.trim();
    if (!raw) continue;
    const rate = Number(raw);
    if (Number.isFinite(rate) && rate >= 0) return true;
  }
  return false;
}

export function computeLineAmount(qty: string, rate: string) {
  const q = Number(qty);
  const r = Number(rate);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return "0";
  return (q * r).toFixed(2);
}

export function computeQuotationTotals(input: {
  lines: { amount: string; gstPercent?: string | null }[];
  freightAmount: string;
  loadingCharges: string;
  /** Fallback GST for lines without a slab, and for freight/loading. */
  gstPercent: string;
}) {
  const subtotal = input.lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
  const freight = Number(input.freightAmount || 0);
  const loading = Number(input.loadingCharges || 0);
  const headerPct = Number(input.gstPercent || 18);
  const taxable = subtotal + freight + loading;

  const bySlab: Record<string, number> = {};
  let gstAmount = 0;
  for (const line of input.lines) {
    const amount = Number(line.amount || 0);
    const pct = Number(line.gstPercent ?? headerPct);
    const slabKey = String(pct);
    const lineGst = (amount * pct) / 100;
    gstAmount += lineGst;
    bySlab[slabKey] = (bySlab[slabKey] || 0) + lineGst;
  }

  const extras = freight + loading;
  if (extras) {
    const extrasGst = (extras * headerPct) / 100;
    gstAmount += extrasGst;
    const slabKey = String(headerPct);
    bySlab[slabKey] = (bySlab[slabKey] || 0) + extrasGst;
  }

  const total = taxable + gstAmount;
  return {
    subtotal: subtotal.toFixed(2),
    total: total.toFixed(2),
    taxBreakup: {
      gstPercent: headerPct,
      taxableAmount: taxable.toFixed(2),
      gstAmount: gstAmount.toFixed(2),
      bySlab: Object.fromEntries(
        Object.entries(bySlab).map(([pct, amount]) => [pct, amount.toFixed(2)]),
      ),
    },
  };
}
