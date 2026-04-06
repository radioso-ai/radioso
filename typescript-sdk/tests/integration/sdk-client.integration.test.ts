import { describe, expect, it, vi } from "vitest";

import { createRadiosoClient } from "../../src/index.js";

describe("sdk client integration", () => {
  it("supports token-based document and retrieval operations through the public surface", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          documents: [],
          page: { limit: 10, offset: 0, nextCursor: null, hasMore: false },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          workspaceId: "w1",
          queryRewriteEnabled: true,
          semanticRewriteInstructions: "",
          lexicalRewriteInstructions: "",
          answerSupportPolicy: "strict",
          rerankEnabled: true,
          vectorTopK: 20,
          similarityThreshold: 0.2,
          rerankTopK: 20,
          citationDisplayEnabled: true,
          metadataFieldSuggestions: [],
          metadataRules: [],
          customInstruction: "",
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          conversationId: "c1",
          answer: "hello",
          retrievalInfo: {},
          retrievalTrace: {},
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const client = createRadiosoClient({
      baseUrl: "https://api.example.com",
      apiToken: "token-123",
      fetch: fetchMock as typeof fetch,
    });

    const documents = await client.documents.list({ limit: 10 });
    const settings = await client.settings.getRetrieval();
    const chat = await client.chat.create({ query: "hello", stream: false });

    expect(documents.documents).toEqual([]);
    expect(settings.answerSupportPolicy).toBe("strict");
    expect(chat.answer).toBe("hello");
  });
});
