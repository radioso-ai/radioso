import { describe, expect, it } from "vitest";

import {
  canonicalReviewedOperationDigest,
} from "../../../src/modules/operatorCopilot/reviewedOperation.js";

describe("reviewed operation digest", () => {
  it("uses a canonical digest independent of object-key order", () => {
    expect(canonicalReviewedOperationDigest({ b: [2, { z: true, a: "x" }], a: 1 }))
      .toBe(canonicalReviewedOperationDigest({ a: 1, b: [2, { a: "x", z: true }] }));
  });

  it("accepts JSON objects only and orders keys without locale-dependent collation", () => {
    expect(canonicalReviewedOperationDigest({ "ä": 1, z: 2 }))
      .toBe(canonicalReviewedOperationDigest({ z: 2, "ä": 1 }));
    expect(() => canonicalReviewedOperationDigest({ at: new Date() })).toThrow(/JSON values/i);
    expect(() => canonicalReviewedOperationDigest({ map: new Map() })).toThrow(/JSON values/i);
  });
});
