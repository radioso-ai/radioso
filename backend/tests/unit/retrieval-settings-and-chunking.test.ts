import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../../src/modules/retrieval/domain/chunkingService.js";
import { validateRetrievalSettings } from "../../src/modules/settings/domain/retrievalSettings.js";

describe("retrieval settings and chunking", () => {
  it("rejects invalid retrieval settings", () => {
    expect(() =>
      validateRetrievalSettings({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 0,
        similarityThreshold: 0.2,
        rerankTopK: 5,
      }),
    ).toThrow("vectorTopK must be between 1 and 300");
  });

  it("creates overlapping chunks for long content", () => {
    const longText = "word ".repeat(400);
    const chunks = chunkMarkdown(longText);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
  });
});
