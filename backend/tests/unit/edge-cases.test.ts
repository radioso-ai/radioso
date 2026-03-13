import { describe, expect, it } from "vitest";

import { chunkMarkdown, normalizeMarkdown } from "../../src/modules/retrieval/domain/chunkingService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";

describe("edge cases", () => {
  it("normalizes short content into a single chunk", () => {
    const content = "   short content   ";
    const normalized = normalizeMarkdown(content);
    const chunks = chunkMarkdown(content);

    expect(normalized).toBe("short content");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("short content");
  });

  it("builds a prompt safely when no context is retrieved", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What happened?",
      history: [],
      contexts: [],
    });

    expect(result.prompt).toContain("No retrieved context");
    expect(result.citations).toEqual([]);
  });
});
