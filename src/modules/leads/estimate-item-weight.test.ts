import assert from "node:assert/strict";
import test from "node:test";
import { estimateLeadItemWeightKg } from "@/modules/leads/estimate-item-weight";

test("kg uom uses quantity as weight", () => {
  assert.equal(
    estimateLeadItemWeightKg({ configId: "coil", uom: "KG", quantity: "500", specs: {} }),
    "500",
  );
});

test("sheet plate weight from dimensions", () => {
  const kg = estimateLeadItemWeightKg({
    configId: "sheet",
    uom: "PCS",
    quantity: "2",
    specs: { thickness: "0.8", width: "1000", length: "2000" },
  });
  assert.ok(kg);
  const n = Number(kg);
  assert.ok(n > 20 && n < 30);
});

test("circle from diameter and thickness", () => {
  const kg = estimateLeadItemWeightKg({
    configId: "circle",
    uom: "PCS",
    quantity: "1",
    specs: { diameter: "200", thickness: "0.8" },
  });
  assert.ok(kg);
  assert.ok(Number(kg) > 0.1);
});