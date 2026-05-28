import { describe, expect, it } from "vitest";

import { resolveContextSourceUrl } from "../../src/modules/retrieval/services/contextSourceUrl.js";

describe("resolveContextSourceUrl", () => {
  it("returns a safe http(s) url from sourceUrl metadata", () => {
    expect(resolveContextSourceUrl({ sourceUrl: "https://example.com/doc" })).toBe(
      "https://example.com/doc",
    );
    expect(resolveContextSourceUrl({ url: "http://example.com/page" })).toBe(
      "http://example.com/page",
    );
  });

  it("falls back to nested parsedData.url", () => {
    expect(
      resolveContextSourceUrl({ parsedData: { url: "https://example.com/nested" } }),
    ).toBe("https://example.com/nested");
  });

  it("rejects non-url strings", () => {
    expect(resolveContextSourceUrl({ sourceUrl: "not-a-url" })).toBeUndefined();
  });

  it("rejects unsafe schemes", () => {
    expect(resolveContextSourceUrl({ sourceUrl: "javascript:alert(1)" })).toBeUndefined();
    expect(resolveContextSourceUrl({ sourceUrl: "data:text/html,hi" })).toBeUndefined();
    expect(resolveContextSourceUrl({ sourceUrl: "file:///etc/passwd" })).toBeUndefined();
  });

  it("skips invalid candidates and uses the next safe one", () => {
    expect(
      resolveContextSourceUrl({ sourceUrl: "not-a-url", url: "https://example.com/ok" }),
    ).toBe("https://example.com/ok");
  });

  it("returns undefined when no metadata is present", () => {
    expect(resolveContextSourceUrl()).toBeUndefined();
    expect(resolveContextSourceUrl({})).toBeUndefined();
  });
});
