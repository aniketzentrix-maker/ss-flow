import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  RATE_CONFLICT_CODE,
  RATE_PENDING_MESSAGE,
  STALE_SPECIFICATION_CODE,
  activePricingMatchKeys,
  buildNormalizedPricingFingerprint,
  decideCatalogRateReuse,
  resolveProductFieldConfig,
} from "@/lib/domain/product-spec-fields";

describe("decideCatalogRateReuse", () => {
  test("reuses matching submitted and master rates", () => {
    assert.equal(
      decideCatalogRateReuse({ existingRate: "185.00", submittedRate: "185" }),
      "reuse",
    );
  });

  test("fills blank master rate", () => {
    assert.equal(
      decideCatalogRateReuse({ existingRate: null, submittedRate: "200" }),
      "fill_blank",
    );
    assert.equal(
      decideCatalogRateReuse({ existingRate: "", submittedRate: "200" }),
      "fill_blank",
    );
  });

  test("conflicts when rates differ without applyExisting", () => {
    assert.equal(
      decideCatalogRateReuse({ existingRate: "180", submittedRate: "200" }),
      "conflict",
    );
  });

  test("reuses master when applyExistingRate is set", () => {
    assert.equal(
      decideCatalogRateReuse({
        existingRate: "180",
        submittedRate: "200",
        applyExistingRate: true,
      }),
      "reuse",
    );
  });
});

describe("pricing fingerprint stability", () => {
  test("normalizes thickness spacing/case for coil-like specs", () => {
    const product = {
      sku: "COIL",
      name: "Coil",
      category: { code: "TRD" },
    };
    const config = resolveProductFieldConfig(product);
    assert.ok(config);
    const a = { grade: "304", finish: "2B", thickness: "1.35", width: "1250" };
    const b = { grade: " 304 ", finish: "2b", thickness: "1.350", width: "1250.0" };
    const keysA = activePricingMatchKeys(config!, a);
    const keysB = activePricingMatchKeys(config!, b);
    assert.equal(
      buildNormalizedPricingFingerprint(a, keysA, config),
      buildNormalizedPricingFingerprint(b, keysB, config),
    );
  });
});

describe("error codes", () => {
  test("exports stable conflict and stale codes", () => {
    assert.equal(RATE_CONFLICT_CODE, "RATE_CONFLICT");
    assert.equal(STALE_SPECIFICATION_CODE, "STALE_SPECIFICATION");
    assert.ok(RATE_PENDING_MESSAGE.length > 0);
  });
});
