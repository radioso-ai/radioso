import { describe, expect, it } from "vitest";

import {
  normalizeWordpressSiteUrl,
  wordpressUrlBelongsToSite,
} from "../../../../src/modules/connectors/plugins/wordpress/wordpressSource.js";

describe("WordPress source URLs", () => {
  it("normalizes equivalent site URLs to one source identity", () => {
    expect(normalizeWordpressSiteUrl(" HTTPS://Example.COM/blog/// ")).toBe(
      "https://example.com/blog",
    );
  });

  it("accepts post permalinks under the configured site path", () => {
    expect(
      wordpressUrlBelongsToSite(
        "https://example.com/blog",
        "https://example.com/blog/posts/welcome",
      ),
    ).toBe(true);
  });

  it("rejects sibling paths, foreign origins, and invalid URLs", () => {
    expect(
      wordpressUrlBelongsToSite(
        "https://example.com/blog",
        "https://example.com/blogger/welcome",
      ),
    ).toBe(false);
    expect(
      wordpressUrlBelongsToSite(
        "https://example.com/blog",
        "https://other.example/blog/welcome",
      ),
    ).toBe(false);
    expect(wordpressUrlBelongsToSite("https://example.com/blog", "not a URL")).toBe(
      false,
    );
  });
});
