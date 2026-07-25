import { describe, expect, it } from "vitest";

import {
  renderMetadataPromptText,
  renderMetadataSearchText,
} from "../../../src/modules/retrieval/services/searchTextRenderer.js";

describe("renderMetadataSearchText", () => {
  it("includes the author so documents are findable by author name", () => {
    const text = renderMetadataSearchText({ author: "Sabine Kaphingst" });
    expect(text).toContain("Author: Sabine Kaphingst");
  });

  it("omits the author when absent", () => {
    expect(renderMetadataSearchText({})).not.toContain("Author:");
  });

  it("omits the author when blank or non-string", () => {
    expect(renderMetadataSearchText({ author: "   " })).not.toContain("Author:");
    expect(renderMetadataSearchText({ author: 42 })).not.toContain("Author:");
  });

  it("renders searchable attributes for the answer prompt without duplicating the source URL", () => {
    const text = renderMetadataPromptText({
      author: "Mario Liguori",
      dateFrom: "2026-07-25",
      sourceUrl: "https://example.com/article",
      internal_note: "do not expose",
    });

    expect(text).toContain("Author: Mario Liguori");
    expect(text).toContain("Date from: 2026-07-25");
    expect(text).not.toContain("https://example.com/article");
    expect(text).not.toContain("Month key:");
    expect(text).not.toContain("Month label:");
    expect(text).not.toContain("internal_note");
    expect(text).not.toContain("do not expose");
  });
});
