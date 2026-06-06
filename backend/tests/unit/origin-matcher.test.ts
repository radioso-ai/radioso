import { describe, expect, it } from "vitest";

import { DefaultOriginMatcher } from "../../src/modules/accessGrants/originMatcher.js";

describe("DefaultOriginMatcher", () => {
  const matcher = new DefaultOriginMatcher();

  it("admits any valid origin for allow-all constraints", () => {
    expect(matcher.matches({ mode: "allow-all", origins: [] }, "https://example.com/path")).toBe(true);
    expect(matcher.matches({ mode: "allow-all", origins: [] }, "https://docs.example.com")).toBe(true);
    expect(matcher.matches({ mode: "allow-all", origins: [] }, undefined)).toBe(true);
  });

  it("admits only exact normalized origins for list constraints", () => {
    const constraint = { mode: "list" as const, origins: ["https://example.com"] };

    expect(matcher.matches(constraint, "https://example.com/help")).toBe(true);
    expect(matcher.matches(constraint, "https://EXAMPLE.com/")).toBe(true);
    expect(matcher.matches(constraint, "https://docs.example.com")).toBe(false);
  });

  it("rejects every origin for an empty origin list", () => {
    expect(matcher.matches({ mode: "list", origins: [] }, "https://example.com")).toBe(false);
    expect(matcher.matches({ mode: "list", origins: [] }, undefined)).toBe(false);
  });

  it("uses website embed origin normalization for trailing slash and invalid values", () => {
    expect(matcher.matches({ mode: "list", origins: ["https://example.com"] }, "https://example.com/")).toBe(true);
    expect(matcher.matches({ mode: "list", origins: ["https://example.com"] }, "not a url")).toBe(false);
  });
});
