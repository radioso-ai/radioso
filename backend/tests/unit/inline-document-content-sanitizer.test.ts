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
        url: "https://anandaeurope.org/video/how-to-begin-with-meditation-5-tips-kirtani",
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
});
