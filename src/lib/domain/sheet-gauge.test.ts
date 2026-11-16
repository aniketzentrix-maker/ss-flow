import assert from "node:assert/strict";
import test from "node:test";
import {
  formatThicknessMm,
  gaugeInputToThicknessMm,
  snapThicknessToOptions,
  swgToThicknessMm,
} from "@/lib/domain/sheet-gauge";

test("swgToThicknessMm known gauges", () => {
  assert.equal(swgToThicknessMm(18), 1.016);
  assert.equal(swgToThicknessMm(20), 0.838);
  assert.equal(swgToThicknessMm(99), null);
});

test("gaugeInputToThicknessMm parses SWG prefix", () => {
  assert.equal(gaugeInputToThicknessMm("20"), 0.838);
  assert.equal(gaugeInputToThicknessMm("SWG 18"), 1.016);
});

test("snapThicknessToOptions picks nearest catalog value", () => {
  const options = ["0.4", "0.8", "1.0", "1.2"];
  assert.equal(snapThicknessToOptions(0.838, options), "0.8");
});

test("formatThicknessMm", () => {
  assert.equal(formatThicknessMm(1.016), "1.016");
  assert.equal(formatThicknessMm(1.2), "1.2");
});