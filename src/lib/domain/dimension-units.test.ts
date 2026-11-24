import assert from "node:assert/strict";
import test from "node:test";
import {
  inchInputToMm,
  inchDimensionDisplayParts,
  thicknessDisplayParts,
} from "@/lib/domain/dimension-units";

test("inch to mm", () => {
  assert.equal(inchInputToMm("8"), 203.2);
  assert.equal(inchInputToMm('8.5"'), 215.9);
});

test("thickness display with gauge", () => {
  const parts = thicknessDisplayParts({
    thicknessInputUnit: "gauge",
    thicknessGauge: "20",
    thicknessConvertedMm: "0.9",
    thickness: "0.9",
  });
  assert.ok(parts?.entered?.includes("Gauge 20"));
  assert.equal(parts?.converted, "Thickness: 0.9 mm");
});

test("thickness display from mm shows matching Farma gauge", () => {
  const parts = thicknessDisplayParts({
    thicknessInputUnit: "mm",
    thickness: "0.5",
  });
  assert.ok(parts?.entered?.includes("Gauge 26"));
  assert.equal(parts?.converted, "Thickness: 0.5 mm");
});

test("diameter display with inch", () => {
  const parts = inchDimensionDisplayParts("diameter", {
    diameterInputUnit: "inch",
    diameterInch: "8",
    diameterConvertedMm: "203.2",
    diameter: "203.2",
  });
  assert.equal(parts?.entered, "Entered: 8 inch");
  assert.equal(parts?.converted, "Converted: 203.2 mm");
});