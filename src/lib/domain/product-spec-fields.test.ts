import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDesignFileIds,
  findBestVariantForSpecs,
  invalidNumericSpecFields,
  isAllowedDesignFile,
  isProductComingSoon,
  missingRequiredSpecFields,
  normalizePricingSpecValue,
  pricingFieldKeys,
  resolveExactPricedVariant,
  resolveProductFieldConfig,
  MERGED_PRODUCT_SKUS,
} from "./product-spec-fields";

test("merged catalog SKUs map retired products onto the surviving parent", () => {
  assert.equal(MERGED_PRODUCT_SKUS["SSM-TRD-WIRE-PCS"], "SSM-TRD-WIRE");
  assert.equal(MERGED_PRODUCT_SKUS["SSM-TRD-MIRROR-MATT-PVD"], "SSM-TRD-SHEET");
  assert.equal(MERGED_PRODUCT_SKUS["SSM-MFG-JUG-FARMA"], "SSM-MFG-FARMA");
});

test("Circle config is Grade, Finish, Thickness, numeric Diameter and hides Edge Type", () => {
  const config = resolveProductFieldConfig({ sku: "SSM-MFG-CIRCLE", name: "Circle" });
  assert.ok(config);
  assert.deepEqual(
    config.fields.map((field) => field.key),
    ["grade", "finish", "thickness", "diameter"],
  );
  assert.equal(config.fields.find((field) => field.key === "diameter")?.type, "number");
  assert.ok(config.hiddenKeys.includes("edgeType"));
  assert.deepEqual(pricingFieldKeys(config, { grade: "304", finish: "2B", thickness: "0.8", diameter: "300" }), [
    "grade",
    "finish",
    "thickness",
    "diameter",
  ]);
});

test("Farma pricing keys exclude Production Remarks", () => {
  const config = resolveProductFieldConfig({ sku: "SSM-MFG-FARMA", name: "Farma" });
  assert.ok(config);
  assert.deepEqual(
    config.fields.map((field) => field.key),
    ["grade", "finish", "thickness", "length", "breadth", "productionRemarks"],
  );
  assert.equal(config.fields.find((f) => f.key === "productionRemarks")?.pricing, false);
  assert.deepEqual(
    pricingFieldKeys(config, {
      grade: "304",
      finish: "2B",
      thickness: "0.8",
      length: "220",
      breadth: "180",
      productionRemarks: "polish edges",
    }),
    ["grade", "finish", "thickness", "length", "breadth"],
  );
  assert.equal(missingRequiredSpecFields(config, { grade: "304", finish: "2B", thickness: "0.8" }).join(","), "Length,Breadth");
  assert.equal(
    missingRequiredSpecFields(config, {
      grade: "304",
      finish: "2B",
      thickness: "0.8",
      length: "220",
      breadth: "180",
    }).length,
    0,
  );
});

test("Wire cut length is a pricing key only for cut pieces", () => {
  const config = resolveProductFieldConfig({ sku: "SSM-TRD-WIRE", name: "Wire" });
  assert.ok(config);
  const coilMissing = missingRequiredSpecFields(config, {
    productForm: "coil",
    grade: "304",
    wireDiameterMm: "1.2",
    finishOrCondition: "bright",
  });
  assert.deepEqual(coilMissing, []);
  assert.deepEqual(
    pricingFieldKeys(config, {
      productForm: "coil",
      grade: "304",
      wireDiameterMm: "1.2",
      finishOrCondition: "bright",
      cutLengthMm: "500",
    }),
    ["productForm", "grade", "wireDiameterMm", "finishOrCondition"],
  );

  const cutMissing = missingRequiredSpecFields(config, {
    productForm: "cut wire piece",
    grade: "304",
    wireDiameterMm: "1.2",
    finishOrCondition: "bright",
  });
  assert.deepEqual(cutMissing, ["Cut length"]);
  assert.ok(
    pricingFieldKeys(config, {
      productForm: "cut wire piece",
      grade: "304",
      wireDiameterMm: "1.2",
      finishOrCondition: "bright",
      cutLengthMm: "500",
    }).includes("cutLengthMm"),
  );

  const variants = [
    {
      id: "coil",
      uom: "KG",
      sellingPrice: "180",
      specs: { productForm: "coil", grade: "304", finishOrCondition: "bright", wireDiameterMm: "1.2" },
    },
    {
      id: "cut",
      uom: "PCS",
      sellingPrice: "25",
      specs: {
        productForm: "cut wire piece",
        grade: "304",
        finishOrCondition: "bright",
        wireDiameterMm: "1.2",
        cutLengthMm: "500",
      },
    },
  ];
  const cut = resolveExactPricedVariant(
    variants,
    {
      productForm: "cut wire piece",
      grade: "304",
      wireDiameterMm: "1.2",
      finishOrCondition: "bright",
      cutLengthMm: "500",
    },
    config,
  );
  assert.equal(cut.status, "exact");
  assert.equal(cut.variant?.id, "cut");

  const wrongGrade = resolveExactPricedVariant(
    variants,
    {
      productForm: "cut wire piece",
      grade: "316",
      wireDiameterMm: "1.2",
      finishOrCondition: "bright",
      cutLengthMm: "500",
    },
    config,
  );
  assert.equal(wrongGrade.status, "none");
});

test("Sheet decorative subtype is pricing when finish is decorative", () => {
  const config = resolveProductFieldConfig({ sku: "SSM-TRD-SHEET", name: "Sheet" });
  assert.ok(config);
  assert.equal(
    missingRequiredSpecFields(config, {
      grade: "304",
      finish: "2B",
      thickness: "0.8",
      width: "1250",
      length: "2500",
    }).length,
    0,
  );
  assert.deepEqual(
    pricingFieldKeys(config, {
      grade: "304",
      finish: "2B",
      thickness: "0.8",
      width: "1250",
      length: "2500",
      decorativeSubtype: "should-be-ignored-when-inactive",
    }),
    ["grade", "finish", "thickness", "width", "length"],
  );
  assert.ok(
    pricingFieldKeys(config, {
      grade: "304",
      finish: "PVD",
      thickness: "0.8",
      width: "1250",
      length: "2500",
      decorativeSubtype: "Gold",
    }).includes("decorativeSubtype"),
  );

  const variants = [
    {
      id: "plain",
      sellingPrice: "200",
      specs: { grade: "304", finish: "2B", thickness: "0.8", width: "1250", length: "2500" },
    },
    {
      id: "pvd-gold",
      sellingPrice: "260",
      specs: {
        grade: "304",
        finish: "PVD",
        thickness: "0.8",
        width: "1250",
        length: "2500",
        decorativeSubtype: "Gold",
      },
    },
  ];
  assert.equal(
    resolveExactPricedVariant(
      variants,
      { grade: "304", finish: "PVD", thickness: "0.8", width: "1250", length: "2500", decorativeSubtype: "Gold" },
      config,
    ).variant?.id,
    "pvd-gold",
  );
  assert.equal(
    resolveExactPricedVariant(
      variants,
      { grade: "304", finish: "PVD", thickness: "0.8", width: "1250", length: "2500" },
      config,
    ).status,
    "none",
  );
});

test("Rod and Coil pricing fields match the family mapping", () => {
  const rod = resolveProductFieldConfig({ sku: "SSM-TRD-ROD", name: "Rod" });
  const coil = resolveProductFieldConfig({ sku: "SSM-TRD-COIL", name: "Coil" });
  assert.ok(rod && coil);
  assert.deepEqual(rod.fields.map((field) => field.key), ["grade", "diameter", "length"]);
  assert.deepEqual(coil.fields.map((field) => field.key), ["grade", "finish", "thickness", "width"]);
  assert.ok(rod.hiddenKeys.includes("packing"));
  assert.ok(coil.hiddenKeys.includes("innerDiameterMm"));
  assert.ok(coil.hiddenKeys.includes("productForm"));
});

test("Coil exact match switches rate by width", () => {
  const config = resolveProductFieldConfig({ sku: "SSM-TRD-COIL", name: "Coil" })!;
  const variants = [
    {
      id: "w1000",
      sellingPrice: "180",
      uom: "KG",
      specs: { grade: "304", finish: "2B", thickness: "0.5", width: "1000" },
    },
    {
      id: "w1250",
      sellingPrice: "185",
      uom: "KG",
      specs: { grade: "304", finish: "2B", thickness: "0.5", width: "1250" },
    },
  ];
  const a = resolveExactPricedVariant(
    variants,
    { grade: "304", finish: "2B", thickness: "0.50", width: "1000" },
    config,
  );
  assert.equal(a.status, "exact");
  assert.equal(a.variant?.id, "w1000");
  assert.equal(a.variant?.sellingPrice, "180");
  assert.equal(100 * Number(a.variant?.sellingPrice), 18000);

  const b = resolveExactPricedVariant(
    variants,
    { grade: "304", finish: "2B", thickness: "0.5", width: "1250" },
    config,
  );
  assert.equal(b.variant?.id, "w1250");
  assert.equal(100 * Number(b.variant?.sellingPrice), 18500);
});

test("Rod / Circle free-number diameter must match exactly after normalization", () => {
  const circle = resolveProductFieldConfig({ sku: "SSM-MFG-CIRCLE", name: "Circle" })!;
  const rod = resolveProductFieldConfig({ sku: "SSM-TRD-ROD", name: "Rod" })!;
  assert.equal(normalizePricingSpecValue("diameter", "0.50", circle), "0.5");
  assert.equal(normalizePricingSpecValue("diameter", "0.5", circle), "0.5");

  const circleVariants = [
    {
      id: "d275",
      sellingPrice: "40",
      specs: { grade: "304", finish: "BA", thickness: "0.80", diameter: "275" },
    },
  ];
  assert.equal(
    resolveExactPricedVariant(
      circleVariants,
      { grade: "304", finish: "BA", thickness: "0.8", diameter: "275" },
      circle,
    ).status,
    "exact",
  );
  assert.equal(
    resolveExactPricedVariant(
      circleVariants,
      { grade: "304", finish: "BA", thickness: "0.8", diameter: "300" },
      circle,
    ).status,
    "none",
  );
  assert.equal(
    findBestVariantForSpecs(
      circleVariants,
      { grade: "321", finish: "BA", thickness: "0.80", diameter: "275" },
      circle,
    ),
    undefined,
  );

  const rodVariants = [
    { id: "r12", sellingPrice: "90", specs: { grade: "304", diameter: "12", length: "6000" } },
    { id: "r16", sellingPrice: "110", specs: { grade: "304", diameter: "16", length: "6000" } },
  ];
  assert.equal(
    resolveExactPricedVariant(rodVariants, { grade: "304", diameter: "12", length: "6000" }, rod).variant
      ?.sellingPrice,
    "90",
  );
  assert.equal(
    resolveExactPricedVariant(rodVariants, { grade: "304", diameter: "16", length: "6000" }, rod).variant
      ?.id,
    "r16",
  );
});

test("manual numeric values are validated without blocking newly added select options", () => {
  const config = resolveProductFieldConfig({ sku: "SSM-MFG-CIRCLE", name: "Circle" })!;
  assert.deepEqual(invalidNumericSpecFields(config, { diameter: "abc" }), ["Diameter"]);
  assert.deepEqual(invalidNumericSpecFields(config, { diameter: "300.5" }), []);
});

test("ambiguous duplicate pricing combinations are surfaced", () => {
  const config = resolveProductFieldConfig({ sku: "SSM-TRD-COIL", name: "Coil" })!;
  const variants = [
    { id: "a", specs: { grade: "304", finish: "2B", thickness: "0.5", width: "1000" } },
    { id: "b", specs: { grade: "304", finish: "2B", thickness: "0.50", width: "1000" } },
  ];
  const result = resolveExactPricedVariant(
    variants,
    { grade: "304", finish: "2B", thickness: "0.5", width: "1000" },
    config,
  );
  assert.equal(result.status, "ambiguous");
  assert.equal(result.matches.length, 2);
});

test("Laser Cut Farma and Semi Finish expose pricing keys; Semi Finish stays coming soon", () => {
  assert.equal(
    isProductComingSoon({ sku: "SSM-MFG-SEMI-FINISH-UTENSILS", name: "Semi Finish Utensils" }),
    true,
  );
  assert.equal(isProductComingSoon({ sku: "SSM-MFG-CIRCLE", name: "Circle" }), false);

  const semi = resolveProductFieldConfig({
    sku: "SSM-MFG-SEMI-FINISH-UTENSILS",
    name: "Semi Finish Utensils",
  });
  assert.ok(semi);
  assert.deepEqual(
    semi.fields.map((f) => f.key),
    ["grade", "stageOfManufacture", "utensilType"],
  );
  assert.ok(semi.fields.every((f) => f.pricing !== false));

  const laser = resolveProductFieldConfig({ sku: "SSM-MFG-LASER-FARMA", name: "Laser Cut Farma" });
  assert.ok(laser);
  assert.deepEqual(pricingFieldKeys(laser, {
    grade: "304",
    thickness: "1",
    finish: "2B",
    cutProfile: "round",
    dimensions: "100x100",
    designReference: "DRW-1",
  }), ["grade", "thickness", "finish", "cutProfile", "dimensions", "designReference"]);
});

test("design file type and size rules accept drawings and reject others", () => {
  assert.equal(isAllowedDesignFile({ name: "part.dxf", type: "application/octet-stream", size: 1024 }), true);
  assert.equal(isAllowedDesignFile({ name: "part.exe", type: "application/octet-stream", size: 1024 }), false);
  assert.equal(isAllowedDesignFile({ name: "huge.pdf", type: "application/pdf", size: 11 * 1024 * 1024 }), false);
  assert.deepEqual(extractDesignFileIds({ designFileIds: ["abc"] }), ["abc"]);
});
