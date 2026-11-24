import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeLineAmount,
  computeQuotationTotals,
  lineDiscountPct,
  quotationNeedsDiscountApproval,
  quotationNeedsPricingApproval,
} from "./pricing";

describe("quotation pricing", () => {
  it("computes discount percent from list and offered rate", () => {
    assert.equal(lineDiscountPct(100, 90), 10);
    assert.equal(lineDiscountPct(100, 100), 0);
  });

  it("flags approval when discount exceeds default limit", () => {
    process.env.QUOTATION_MAX_DISCOUNT_PCT = "5";
    assert.equal(
      quotationNeedsDiscountApproval([{ listRate: "100", rate: "94" }]),
      true,
    );
    assert.equal(
      quotationNeedsDiscountApproval([{ listRate: "100", rate: "96" }]),
      false,
    );
    delete process.env.QUOTATION_MAX_DISCOUNT_PCT;
  });

  it("computes line amount", () => {
    assert.equal(computeLineAmount("10", "25.5"), "255.00");
  });

  it("requires admin approval for any offer rate", () => {
    assert.equal(quotationNeedsPricingApproval([{ rate: "100" }]), true);
    assert.equal(quotationNeedsPricingApproval([{ rate: "0" }]), true);
    assert.equal(quotationNeedsPricingApproval([{ rate: "" }]), false);
    assert.equal(quotationNeedsPricingApproval([]), false);
  });

  it("applies per-line GST slabs of 5% and 18%", () => {
    const totals = computeQuotationTotals({
      lines: [
        { amount: "1000", gstPercent: "5" },
        { amount: "1000", gstPercent: "18" },
      ],
      freightAmount: "0",
      loadingCharges: "0",
      gstPercent: "18",
    });
    assert.equal(totals.subtotal, "2000.00");
    assert.equal(totals.taxBreakup.gstAmount, "230.00");
    assert.equal(totals.total, "2230.00");
    assert.equal(totals.taxBreakup.bySlab?.["5"], "50.00");
    assert.equal(totals.taxBreakup.bySlab?.["18"], "180.00");
  });
});
