import { describe, expect, it } from "vitest";

import { sanitizeInlineDocumentContent } from "../../src/modules/documents/services/inlineDocumentContentSanitizer.js";

describe("inline document content sanitizer", () => {
  it("leaves regular inline documents intact apart from basic normalization", () => {
    const result = sanitizeInlineDocumentContent({
      title: "Plain note",
      sourceContent: "  First line\r\nSecond line  ",
      metadata: {},
    });

    expect(result).toEqual({
      sourceContent: "First line\nSecond line",
      markdownContent: "First line\nSecond line",
    });
  });

  it("trims URL-backed page chrome around the primary title", () => {
    const content = [
      "## Video and Audio",
      "",
      "SEARCH",
      "",
      "Speakers",
      "",
      "## How to begin with meditation? 5 Tips - Kirtani",
      "",
      "Can we use this period of quarantine to deepen the practice of meditation?",
      "",
      "#whymeditate #meditation #keepmeditating",
      "",
      "## Next in Pearls from Ananda",
      "",
      "## Other recommended item",
    ].join("\n");

    const result = sanitizeInlineDocumentContent({
      title: "How to begin with meditation? 5 Tips - Kirtani - Ananda Europe",
      sourceContent: content,
      metadata: {
        sourceUrl: "https://anandaeurope.org/video/how-to-begin-with-meditation-5-tips-kirtani",
      },
    });

    expect(result.markdownContent).toBe(
      [
        "## How to begin with meditation? 5 Tips - Kirtani",
        "",
        "Can we use this period of quarantine to deepen the practice of meditation?",
      ].join("\n"),
    );
    expect(result.sourceContent).toBe(result.markdownContent);
  });

  it("removes trailing related-content headings after the last real content line", () => {
    const content = [
      "## Article Title",
      "",
      "Real article body paragraph.",
      "",
      "## Related content",
      "",
      "## Another recommendation",
    ].join("\n");

    const result = sanitizeInlineDocumentContent({
      title: "Article Title",
      sourceContent: content,
      metadata: {
        sourceUrl: "https://example.com/article",
      },
    });

    expect(result.markdownContent).toBe([
      "## Article Title",
      "",
      "Real article body paragraph.",
    ].join("\n"));
  });

  it("preserves legitimate trailing short list items for sourceUrl-backed documents", () => {
    const content = [
      "## Meditation Benefits",
      "",
      "A short intro paragraph with enough detail to count as real content.",
      "",
      "- Calm mind",
      "- Better focus",
    ].join("\n");

    const result = sanitizeInlineDocumentContent({
      title: "Meditation Benefits",
      sourceContent: content,
      metadata: {
        sourceUrl: "https://example.com/meditation-benefits",
      },
    });

    expect(result.markdownContent).toBe(content);
    expect(result.sourceContent).toBe(content);
  });
});
