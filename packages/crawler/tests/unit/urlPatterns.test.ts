import { describe, expect, it } from "vitest";

import { matchesUrlPattern } from "../../src/transport/urlPatterns.js";

describe("matchesUrlPattern", () => {
  it("matches by case-insensitive substring when no wildcards are present", () => {
    expect(matchesUrlPattern("https://example.com/Docs/keep", ["/docs/"])).toBe(true);
    expect(matchesUrlPattern("https://example.com/blog/keep", ["/docs/"])).toBe(false);
  });

  it("returns false for empty pattern lists", () => {
    expect(matchesUrlPattern("https://example.com/anything", undefined)).toBe(false);
    expect(matchesUrlPattern("https://example.com/anything", [])).toBe(false);
  });

  it("treats * as a glob that matches any sequence anywhere in the url", () => {
    expect(matchesUrlPattern("https://example.com/blog/2025/launch", ["/blog/*/launch"])).toBe(true);
    expect(matchesUrlPattern("https://example.com/blog/2025/launch", ["/news/*/launch"])).toBe(false);
    expect(matchesUrlPattern("https://example.com/docs/anything", ["/docs/*"])).toBe(true);
  });

  it("escapes regex specials so they remain literal in patterns", () => {
    expect(matchesUrlPattern("https://example.com/path?page=2", ["?page=*"])).toBe(true);
    expect(matchesUrlPattern("https://example.com/path?pages=2", ["?page=*"])).toBe(false);
    expect(matchesUrlPattern("https://example.com/file.html", ["*.html"])).toBe(true);
  });

  it("returns true if any pattern matches", () => {
    expect(
      matchesUrlPattern("https://example.com/admin/login", ["/docs/*", "/admin/*"]),
    ).toBe(true);
  });
});
