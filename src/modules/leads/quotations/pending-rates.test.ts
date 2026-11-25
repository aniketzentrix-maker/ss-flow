import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "@/lib/errors";
import {
  assertLeadItemsPricedForFinalQuotation,
  collectPendingQuotationRateItems,
  formatPendingQuotationRateLabel,
  leadItemHasSavedQuotationRate,
  QUOTATION_RATES_PENDING_CODE,
  QUOTATION_RATES_PENDING_MESSAGE,
} from "./pending-rates";

test("saved lead rates only — live catalog price does not count as priced", () => {
  assert.equal(
    leadItemHasSavedQuotationRate({
      marketPrice: null,
      targetPrice: null,
      priceOffered: null,
    }),
    false,
  );
  assert.equal(
    leadItemHasSavedQuotationRate({
      marketPrice: "0",
      targetPrice: "0",
    }),
    false,
  );
  assert.equal(
    leadItemHasSavedQuotationRate({
      marketPrice: "180",
      targetPrice: "180",
    }),
    true,
  );
  assert.equal(
    leadItemHasSavedQuotationRate({
      marketPrice: null,
      targetPrice: "185",
    }),
    true,
  );
});

test("collectPendingQuotationRateItems lists every unpriced line with specs", () => {
  const items = [
    {
      id: "a",
      marketPrice: "180",
      targetPrice: "180",
      parentProduct: { name: "Coil" },
      specifications: { grade: "304", thickness: "0.5", finish: "2B", width: "1000" },
    },
    {
      id: "b",
      marketPrice: null,
      targetPrice: null,
      parentProduct: { name: "Coil" },
      specifications: { grade: "304", thickness: "0.50", finish: "2B", width: "1250" },
    },
    {
      id: "c",
      marketPrice: null,
      targetPrice: "0",
      parentProduct: { name: "Rod" },
      specifications: { grade: "316", diameter: "12", length: "3000" },
    },
  ];
  const pending = collectPendingQuotationRateItems(items);
  assert.equal(pending.length, 2);
  assert.equal(pending[0]?.leadItemId, "b");
  assert.equal(pending[0]?.lineNumber, 2);
  assert.match(pending[0]?.label ?? "", /Line 2 — Coil \| SS 304 \| 0\.50 mm \| 2B \| 1250 mm/);
  assert.equal(pending[1]?.leadItemId, "c");
  assert.equal(pending[1]?.lineNumber, 3);
  assert.match(pending[1]?.label ?? "", /Line 3 — Rod \| SS 316 \| Ø 12 mm \| 3 m/);
});

test("assertLeadItemsPricedForFinalQuotation blocks with structured details", () => {
  const items = [
    {
      id: "priced",
      marketPrice: "100",
      targetPrice: "100",
      parentProduct: { name: "Sheet" },
      specifications: { grade: "304", finish: "2B", thickness: "1", width: "1250", length: "2500" },
    },
    {
      id: "pending-1",
      marketPrice: null,
      parentProduct: { name: "Coil" },
      specifications: { grade: "304", thickness: "0.50", finish: "2B", width: "1250" },
    },
    {
      id: "pending-2",
      marketPrice: null,
      parentProduct: { name: "Rod" },
      specifications: { grade: "316", diameter: "12", length: "3000" },
    },
  ];
  try {
    assertLeadItemsPricedForFinalQuotation(items);
    assert.fail("expected AppError");
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, QUOTATION_RATES_PENDING_CODE);
    assert.ok(error.message.startsWith(QUOTATION_RATES_PENDING_MESSAGE));
    const details = error.details as { pendingItems: { leadItemId: string; label: string }[] };
    assert.equal(details.pendingItems.length, 2);
    assert.equal(details.pendingItems[0]?.leadItemId, "pending-1");
    assert.equal(details.pendingItems[1]?.leadItemId, "pending-2");
    assert.match(error.message, /Line 2 — Coil/);
    assert.match(error.message, /Line 3 — Rod/);
  }
});

test("identical products stay distinguishable by line number and specs", () => {
  const first = formatPendingQuotationRateLabel(2, {
    parentProduct: { name: "Coil" },
    specifications: { grade: "304", thickness: "0.50", finish: "2B", width: "1000" },
  });
  const second = formatPendingQuotationRateLabel(4, {
    parentProduct: { name: "Coil" },
    specifications: { grade: "304", thickness: "0.50", finish: "2B", width: "1250" },
  });
  assert.notEqual(first.label, second.label);
  assert.match(first.label, /^Line 2 —/);
  assert.match(second.label, /^Line 4 —/);
  assert.match(first.label, /1000 mm/);
  assert.match(second.label, /1250 mm/);
});

test("assert passes when every lead line has a saved positive rate", () => {
  assert.doesNotThrow(() =>
    assertLeadItemsPricedForFinalQuotation([
      {
        id: "1",
        marketPrice: "180",
        targetPrice: "180",
        parentProduct: { name: "Coil" },
        specifications: { grade: "304", width: "1000" },
      },
      {
        id: "2",
        marketPrice: "185",
        targetPrice: "185",
        parentProduct: { name: "Coil" },
        specifications: { grade: "304", width: "1250" },
      },
    ]),
  );
});
