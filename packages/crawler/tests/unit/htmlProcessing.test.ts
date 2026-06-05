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

  it("uses a later contentful main element when the first main is empty", () => {
    expect(extractStructuredTextFromHtml(
      `
        <html>
          <body>
            <main aria-hidden="true"><div><span></span></div></main>
            <main>
              <h1>Real page content</h1>
              <p>Readable body copy should be extracted.</p>
            </main>
          </body>
        </html>
      `,
      "https://example.com/"
    )).toBe("# Real page content\n\nReadable body copy should be extracted.");
  });

  it("preserves main priority over a longer sibling article", () => {
    expect(extractStructuredTextFromHtml(
      `
        <html>
          <body>
            <main><p>Primary page summary.</p></main>
            <article>
              <p>This longer article-like block belongs to a sibling card or teaser list.</p>
              <p>It should not replace the explicit main content container.</p>
            </article>
          </body>
        </html>
      `,
      "https://example.com/"
    )).toBe("Primary page summary.");
  });

  it("matches role main containers case-insensitively", () => {
    expect(extractStructuredTextFromHtml(
      `
        <html>
          <body>
            <div role="Main">
              <p>Role main content is primary.</p>
            </div>
          </body>
        </html>
      `,
      "https://example.com/"
    )).toBe("Role main content is primary.");
  });
});
