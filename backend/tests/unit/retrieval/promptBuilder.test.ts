import { describe, expect, it } from "vitest";

import type { FinalPromptContext } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { PromptBuilder } from "../../../src/modules/retrieval/services/promptBuilder.js";

const wordpressContext = (metadata: Record<string, unknown>): FinalPromptContext =>
  ({
    chunkId: "chunk-49642",
    documentId: "document-49642",
    title: "Who Was Swamiji, Really?",
    content: "There are encounters that change your life.",
    metadata,
    similarity: 0.9,
    retrievalSources: ["semantic_original"],
    retrievalText: "Who Was Swamiji, Really?",
    semanticScore: 0.9,
    lexicalScore: 0,
    relevanceScore: 0.9,
    rerankPosition: 0,
    promptPosition: 0,
    estimatedTokenCost: 20,
  });

describe("PromptBuilder context metadata", () => {
  it("keeps a WordPress author and publish date available to the grounded answer", () => {
    const result = new PromptBuilder().build({
      query: "Who wrote this article and when was it published?",
      history: [],
      contexts: [
        wordpressContext({
          sourceUrl: "https://anandaeurope.org/blog/2026/07/22/who-was-swamiji-really/",
          author: "Bikram Mario Liguori",
          published_at: "2026-07-22T14:16:07",
          dateFrom: "2026-07-22",
        }),
      ],
      settings: {},
    });

    expect(result.prompt).toContain(
      "Source: https://anandaeurope.org/blog/2026/07/22/who-was-swamiji-really/",
    );
    expect(result.prompt).toContain(
      "Attributes: Date from: 2026-07-22 | Author: Bikram Mario Liguori",
    );
  });

  it("does not let control-character metadata create new prompt lines", () => {
    const result = new PromptBuilder().build({
      query: "What is this?",
      history: [],
      contexts: [
        wordpressContext({
          author: "Bikram Mario\nLiguori",
          published_at: "tomorrow\nnot-a-date",
        }),
      ],
      settings: {},
    });

    expect(result.prompt).toContain("Attributes: Author: Bikram Mario Liguori");
    expect(result.prompt).not.toContain("\nLiguori");
    expect(result.prompt).not.toContain("not-a-date");
  });
});
