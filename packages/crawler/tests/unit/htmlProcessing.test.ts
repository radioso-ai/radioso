import { describe, expect, it } from "vitest";

import {
  extractStructuredTextFromHtml,
  extractStructuredTextWithFallback,
  formatHtmlAsMarkdown
} from "../../src/transport/htmlProcessing.js";

describe("HTML processing helpers", () => {
  it("keeps exported extraction helpers backward-compatible when baseUrl is omitted", () => {
    expect(extractStructuredTextFromHtml("<main><p>Hello <a href=\"/docs\">Docs</a></p></main>")).toBe(
      "Hello [Docs](http://localhost/docs)"
    );
    expect(formatHtmlAsMarkdown("<p>Hello <a href=\"/docs\">Docs</a></p>")).toBe(
      "Hello [Docs](http://localhost/docs)"
    );
  });

  it("keeps fallback extraction backward-compatible when baseUrl is omitted", () => {
    expect(extractStructuredTextWithFallback({
      cleanedHtml: "<main><p>Hello <a href=\"/docs\">Docs</a></p></main>",
      originalHtml: "<main><p>Hello <a href=\"/docs\">Docs</a></p></main>"
    })).toBe("Hello [Docs](http://localhost/docs)");
  });

  it("still resolves relative links against an explicit baseUrl", () => {
    expect(extractStructuredTextFromHtml(
      "<main><p>Hello <a href=\"/docs\">Docs</a></p></main>",
      "https://example.com/base"
    )).toBe("Hello [Docs](https://example.com/docs)");
  });
});
