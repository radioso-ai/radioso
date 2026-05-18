import { describe, expect, it } from "vitest";

import { button, escapeHtml } from "./index.js";

describe("Enterprise mail layout helpers", () => {
  it("escapes HTML-sensitive values", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    );
  });

  it("renders escaped button links", () => {
    expect(button({ href: "https://example.com/?x=<y>", label: "Open <link>" }))
      .toContain("https://example.com/?x=&lt;y&gt;");
    expect(button({ href: "https://example.com/", label: "Open <link>" }))
      .toContain("Open &lt;link&gt;");
  });
});
