import { describe, expect, it } from "vitest";

import { button, escapeHtml } from "./index.js";

describe("escapeHtml", () => {
  it("escapes the five standard HTML entities", () => {
    expect(escapeHtml("<b>\"hi\" & 'world'</b>")).toBe("&lt;b&gt;&quot;hi&quot; &amp; &#39;world&#39;&lt;/b&gt;");
  });

  it("returns identical output for inputs with no special characters", () => {
    expect(escapeHtml("hello")).toBe("hello");
  });
});

describe("button", () => {
  it("escapes both the href and label", () => {
    const html = button({ href: "https://example.com/x?q=\"a\"&b=<c>", label: "Click & see" });

    expect(html).toContain("https://example.com/x?q=&quot;a&quot;&amp;b=&lt;c&gt;");
    expect(html).toContain("Click &amp; see");
    expect(html).not.toContain("\"a\"");
    expect(html).not.toContain("Click & see");
  });
});
