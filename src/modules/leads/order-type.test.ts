import assert from "node:assert/strict";
import test from "node:test";
import { deriveLeadOrderTypeFromBusinessCategories } from "@/modules/leads/order-type";

test("derive order type from business category", () => {
  const categories = [
    { id: "t1", code: "TRADING", name: "Trading" },
    { id: "m1", code: "MFG", name: "Manufactured" },
  ];
  assert.equal(
    deriveLeadOrderTypeFromBusinessCategories([{ categoryId: "t1" }], categories),
    "READY_STOCK",
  );
  assert.equal(
    deriveLeadOrderTypeFromBusinessCategories([{ categoryId: "m1" }], categories),
    "CUSTOM",
  );
  assert.equal(
    deriveLeadOrderTypeFromBusinessCategories(
      [{ categoryId: "t1" }, { categoryId: "m1" }],
      categories,
    ),
    "CUSTOM",
  );
});