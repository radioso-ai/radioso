import { describe, expect, it } from "vitest";

import { buildFetchedHtmlPage } from "../../src/transport/htmlContentExtraction.js";

const page = (loadedUrl: string, body: string) =>
  buildFetchedHtmlPage({
    loadedUrl,
    originalHtml: `<html><head><title>Page</title></head><body>${body}</body></html>`,
    statusCode: 200,
    headers: {}
  });

describe("content quality gate", () => {
  it("keeps a short page whose extraction is otherwise clean", () => {
    const result = page(
      "https://example.com/contact-us",
      `<main>
        <p><a href="https://example.com/author/admin">Admin</a> 2026-02-27</p>
        <h1>Contact Us</h1>
        <h2>INFO:</h2><p>info@example.com</p>
        <h2>PRESS:</h2><p>For press events and interviews please contact us: info@example.com</p>
        <h2>OFFICE:</h2><p>+372 53 848 108</p>
      </main>`
    );

    expect(result.text.length).toBeLessThan(300);
    expect(result.skipReason).toBeNull();
  });

  it("still skips a short page that is mostly links", () => {
    const result = page(
      "https://example.com/related",
      `<main>
        <p>See also</p>
        <p><a href="https://example.com/articles/first-long-slug">First</a></p>
        <p><a href="https://example.com/articles/second-long-slug">Second</a></p>
        <p><a href="https://example.com/articles/third-long-slug">Third</a></p>
      </main>`
    );

    expect(result.skipReason).toBe("Skipped low-quality extracted content");
  });

  it("still skips a short page dominated by unrendered template markup", () => {
    const result = page(
      "https://example.com/shell",
      "<main><p>{{ page.title }}</p><p>{{ page.body | render }}</p><p>Loading</p></main>"
    );

    expect(result.skipReason).toBe("Skipped low-quality extracted content");
  });

  it("does not let a single byline link count as link-dense content", () => {
    const result = page(
      "https://example.com/note",
      `<main>
        <p><a href="https://example.com/author/some-long-author-slug">Author Name</a></p>
        <p>A brief note with a handful of words that stands on its own as content.</p>
      </main>`
    );

    expect(result.skipReason).toBeNull();
  });

  it("still skips an empty page", () => {
    expect(page("https://example.com/empty", "<main></main>").skipReason).toBe(
      "Page did not contain crawlable content"
    );
  });
});
