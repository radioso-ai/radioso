import { describe, expect, it } from "vitest";

import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";

describe("chat retrieval domain", () => {
  it("rewrites queries when enabled and prior user history exists", async () => {
    const service = new QueryRewriteService();

    const result = await service.rewrite({
      query: "What does it do?",
      enabled: true,
      history: [
        {
          id: "1",
          conversationId: "c1",
          accountId: "a1",
          role: "user",
          content: "Tell me about the test page",
          createdAt: new Date(),
        },
      ],
    });

    expect(result).toContain("Tell me about the test page");
    expect(result).toContain("What does it do?");
  });

  it("reranks contexts when enabled", () => {
    const service = new RerankService();
    const result = service.rerank({
      query: "test page",
      enabled: true,
      topK: 1,
      contexts: [
        { chunkId: "c1", documentId: "d1", title: "A", content: "nothing relevant", similarity: 0.9 },
        { chunkId: "c2", documentId: "d2", title: "B", content: "this test page explains behavior", similarity: 0.3 },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0].chunkId).toBe("c2");
  });

  it("builds prompts with contexts and citations", () => {
    const builder = new PromptBuilder();
    const result = builder.build({
      query: "What does the page do?",
      history: [],
      contexts: [{ chunkId: "c1", documentId: "d1", title: "Intro", content: "The page parses content.", similarity: 0.8 }],
    });

    expect(result.prompt).toContain("The page parses content.");
    expect(result.citations).toEqual([{ documentId: "d1", chunkId: "c1", title: "Intro" }]);
  });
});
