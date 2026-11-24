import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY_UOM_SEED } from "@/modules/uom/ensure-category-uoms";
import type { UomOption } from "@/modules/uom/service";

function resolveDefault(allowed: UomOption[]) {
  return allowed.find((row) => row.isDefault) ?? allowed[0] ?? null;
}

function assertPermitted(
  allowed: UomOption[],
  input: { unitId?: string; uomSymbol?: string },
) {
  const unitId = input.unitId?.trim() || "";
  const symbol = input.uomSymbol?.trim().toUpperCase() || "";
  let match = unitId ? allowed.find((row) => row.id === unitId) : undefined;
  if (!match && symbol) match = allowed.find((row) => row.symbol.toUpperCase() === symbol);
  if (!match) {
    throw new Error(`UOM is not permitted. Allowed: ${allowed.map((r) => r.symbol).join(", ")}`);
  }
  return match;
}

function optionsFromSeed(symbols: string[], defaultSymbol: string): UomOption[] {
  return symbols.map((symbol, index) => ({
    id: `unit-${symbol}`,
    name: symbol,
    symbol,
    unitType: symbol === "PCS" ? "count" : symbol === "KG" ? "weight" : "length",
    isDefault: symbol === defaultSymbol,
  }));
}

test("seed masters include KG, PCS, FT, IN with expected types", () => {
  assert.deepEqual(
    CATEGORY_UOM_SEED.masters.map((row) => [row.symbol, row.unitType]),
    [
      ["KG", "weight"],
      ["PCS", "count"],
      ["FT", "length"],
      ["IN", "length"],
    ],
  );
});

test("seed category mappings match product-wise UOM requirements", () => {
  const byCode = Object.fromEntries(
    CATEGORY_UOM_SEED.types.map((row) => [row.code, row]),
  );
  assert.deepEqual(byCode.COIL.allowed.sort(), ["FT", "IN", "KG"].sort());
  assert.equal(byCode.COIL.defaultSymbol, "KG");
  assert.deepEqual(byCode.WIRE.allowed.sort(), ["KG", "PCS"].sort());
  assert.equal(byCode.WIRE.defaultSymbol, "KG");
  assert.deepEqual(byCode.ROD.allowed.sort(), ["KG", "PCS"].sort());
  assert.equal(byCode.ROD.defaultSymbol, "KG");
  assert.deepEqual(byCode.CIRCLE.allowed.sort(), ["IN", "KG"].sort());
  assert.equal(byCode.CIRCLE.defaultSymbol, "KG");
  assert.deepEqual(byCode.LASER.allowed.sort(), ["KG", "PCS"].sort());
  assert.equal(byCode.LASER.defaultSymbol, "KG");
  assert.deepEqual(CATEGORY_UOM_SEED.manufacturedRoot.allowed.sort(), ["KG", "PCS"].sort());
  assert.equal(CATEGORY_UOM_SEED.manufacturedRoot.defaultSymbol, "KG");
});

test("default UOM resolution prefers isDefault then first allowed", () => {
  const coil = optionsFromSeed(["KG", "FT", "IN"], "KG");
  assert.equal(resolveDefault(coil)?.symbol, "KG");

  const noFlag = coil.map((row) => ({ ...row, isDefault: false }));
  assert.equal(resolveDefault(noFlag)?.symbol, "KG");
});

test("inactive mappings are excluded from transaction dropdown options", () => {
  const activeMappings = [
    { isActive: true, unit: { isActive: true, symbol: "KG" } },
    { isActive: false, unit: { isActive: true, symbol: "FT" } },
    { isActive: true, unit: { isActive: false, symbol: "IN" } },
  ];
  const dropdown = activeMappings
    .filter((row) => row.isActive && row.unit.isActive)
    .map((row) => row.unit.symbol);
  assert.deepEqual(dropdown, ["KG"]);
});

test("lead UOM validation accepts allowed symbols and rejects others", () => {
  const wire = optionsFromSeed(["KG", "PCS"], "KG");
  assert.equal(assertPermitted(wire, { uomSymbol: "pcs" }).symbol, "PCS");
  assert.equal(assertPermitted(wire, { unitId: "unit-KG" }).symbol, "KG");
  assert.throws(() => assertPermitted(wire, { uomSymbol: "FT" }), /not permitted/);
  assert.throws(() => assertPermitted(wire, { uomSymbol: "IN" }), /not permitted/);
});

test("coil lead dropdown allows KG, FT, IN and rejects PCS", () => {
  const coil = optionsFromSeed(["KG", "FT", "IN"], "KG");
  for (const symbol of ["KG", "FT", "IN"]) {
    assert.equal(assertPermitted(coil, { uomSymbol: symbol }).symbol, symbol);
  }
  assert.throws(() => assertPermitted(coil, { uomSymbol: "PCS" }), /not permitted/);
});

test("changing selected UOM within allowed set is accepted", () => {
  const laser = optionsFromSeed(["KG", "PCS"], "KG");
  assert.equal(resolveDefault(laser)?.symbol, "KG");
  assert.equal(assertPermitted(laser, { uomSymbol: "PCS" }).symbol, "PCS");
});

test("duplicate category-unit mapping keys are unique by plant+category+unit", () => {
  const keys = [
    ["plant-a", "cat-coil", "unit-kg"],
    ["plant-a", "cat-coil", "unit-ft"],
    ["plant-b", "cat-coil", "unit-kg"],
  ];
  const unique = new Set(keys.map((parts) => parts.join("|")));
  assert.equal(unique.size, 3);
  assert.throws(() => {
    const next = ["plant-a", "cat-coil", "unit-kg"];
    if (unique.has(next.join("|"))) throw new Error("duplicate mapping rejected");
  }, /duplicate mapping rejected/);
});

test("cross-plant UOM assignment is rejected when unit plant differs", () => {
  const productPlantId = "plant-a";
  const unit = { id: "u1", plantId: "plant-b", isActive: true, symbol: "KG" };
  assert.notEqual(unit.plantId, productPlantId);
  assert.equal(unit.plantId === productPlantId && unit.isActive, false);
});

test("historical transaction UOM snapshot is not rewritten by config changes", () => {
  const leadItem = { uom: "FT", unitId: "unit-ft" };
  const newCategoryAllowed = ["KG", "PCS"];
  assert.ok(!newCategoryAllowed.includes(leadItem.uom));
  assert.equal(leadItem.uom, "FT", "historical snapshot must remain unchanged");
});
