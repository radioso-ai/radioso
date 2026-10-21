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

describe("PromptBuilder dates", () => {
  const wednesday = () => new Date("2026-10-21T23:30:00.000Z");
  const build = (requestedDateRange?: { dateFrom: string; dateTo: string }) =>
    new PromptBuilder(undefined, wednesday).build({
      query: "What's on this weekend?",
      history: [],
      contexts: [wordpressContext({})],
      settings: {},
      ...(requestedDateRange ? { requestedDateRange } : {}),
    });

  it("dates the answer with today's weekday, so it can count days the way the rewrite did", () => {
    expect(build().systemPrompt).toContain("The current date is 2026-10-21 (Wednesday).");
  });

  it("tells the answer the period the question asks about, in the request rather than the standing instructions", () => {
    const result = build({ dateFrom: "2026-10-24", dateTo: "2026-10-25" });

    expect(result.prompt).toContain("Requested period:\n2026-10-24 (Saturday) to 2026-10-25 (Sunday)");
    expect(result.systemPrompt).not.toContain("2026-10-24");
    expect(result.systemPrompt).not.toContain("Requested period");
  });

  it("names a single requested day once", () => {
    expect(build({ dateFrom: "2026-10-24", dateTo: "2026-10-24" }).prompt)
      .toContain("Requested period:\n2026-10-24 (Saturday)\n");
  });

  it("adds nothing to the request when the question names no period", () => {
    const withoutRange = build();
    const withRange = build({ dateFrom: "2026-10-24", dateTo: "2026-10-25" });

    expect(withoutRange.prompt).not.toContain("Requested period");
    expect(withoutRange.systemPrompt).toBe(withRange.systemPrompt);
    expect(withoutRange.prompt).toContain("Answer request:\nWhat's on this weekend?\n\nStandalone retrieval query:");
  });
});
