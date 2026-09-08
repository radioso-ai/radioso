import { describe, expect, it } from "vitest";

import { satisfiesSemanticVersionRange } from "../../../src/modules/apps/public.js";

/**
 * Compatibility is what admission measures a release against, so the answer has to be
 * reproducible here rather than delegated to a dependency whose resolution could change
 * what a recorded decision means.
 */
describe("semantic version ranges", () => {
  it.each([
    ["0.1.0", ">=0.1.0", true],
    ["1.4.0", ">=0.1.0", true],
    ["0.0.9", ">=0.1.0", false],
    ["1.2.3", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["1.2.9", "~1.2.0", true],
    ["1.3.0", "~1.2.0", false],
    ["1.5.0", ">=1.0.0 <2.0.0", true],
    ["2.0.1", ">=1.0.0 <2.0.0", false],
    ["3.1.0", "^1.0.0 || ^3.0.0", true],
    ["2.9.9", "^1.0.0 || ^3.0.0", false],
    ["1.4.7", "1.4.x", true],
    ["1.5.0", "1.4.x", false],
    ["9.9.9", "*", true],
    ["1.0.0", "1.0.0", true],
    ["1.0.1", "1.0.0", false],
  ])("reads %s against %s as %s", (version, range, expected) => {
    expect(satisfiesSemanticVersionRange(version, range)).toBe(expected);
  });

  // An unreleased build is not the release the range was written for.
  it("keeps a prerelease out of a range written for stable versions", () => {
    expect(satisfiesSemanticVersionRange("2.0.0-rc.1", ">=1.0.0")).toBe(false);
    expect(satisfiesSemanticVersionRange("2.0.0-rc.1", ">=2.0.0-rc.0")).toBe(true);
  });

  it("reads an unparseable version or range as not compatible", () => {
    expect(satisfiesSemanticVersionRange("development", ">=0.1.0")).toBe(false);
    expect(satisfiesSemanticVersionRange("1.0.0", "")).toBe(false);
  });

  it("ignores build metadata when ordering", () => {
    expect(satisfiesSemanticVersionRange("1.2.3+build.7", ">=1.2.3")).toBe(true);
  });
});
