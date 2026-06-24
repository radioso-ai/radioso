import { describe, expect, it } from "vitest";

import { renderMetadataSearchText } from "../../../src/modules/retrieval/services/searchTextRenderer.js";

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
});
