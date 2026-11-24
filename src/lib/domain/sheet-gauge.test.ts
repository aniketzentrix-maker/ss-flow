import assert from "node:assert/strict";
import test from "node:test";
import {
  formatThicknessMm,
  gaugeInputToThicknessMm,
  gaugeToThicknessMm,
  snapThicknessToOptions,
  swgToThicknessMm,
  thicknessMmToGauge,
} from "@/lib/domain/sheet-gauge";

test("Farma chart gauge → mm", () => {
  assert.equal(gaugeToThicknessMm(26), 0.5);
  assert.equal(gaugeToThicknessMm(20), 0.9);
  assert.equal(gaugeToThicknessMm(18), 1.2);
  assert.equal(gaugeToThicknessMm(8), 4);
  assert.equal(gaugeToThicknessMm(99), null);
});

test("swgToThicknessMm alias uses Farma chart", () => {
  assert.equal(swgToThicknessMm(20), 0.9);
});

test("gaugeInputToThicknessMm parses prefixes", () => {
  assert.equal(gaugeInputToThicknessMm("20"), 0.9);
  assert.equal(gaugeInputToThicknessMm("Gauge 18"), 1.2);
  assert.equal(gaugeInputToThicknessMm("SWG 26"), 0.5);
});

test("mm → gauge reverse lookup", () => {
  assert.equal(thicknessMmToGauge(0.9), 20);
  assert.equal(thicknessMmToGauge(0.5), 26);
  assert.equal(thicknessMmToGauge(1.2), 18);
  assert.equal(thicknessMmToGauge(5), null);
  assert.equal(thicknessMmToGauge(6), null);
});

test("snapThicknessToOptions picks nearest catalog value", () => {
  const options = ["0.4", "0.8", "1.0", "1.2"];
  assert.equal(snapThicknessToOptions(0.92, options), "1.0");
  assert.equal(snapThicknessToOptions(0.5, options), "0.4");
});

test("formatThicknessMm", () => {
  assert.equal(formatThicknessMm(0.9), "0.9");
  assert.equal(formatThicknessMm(1.2), "1.2");
});
