import { describe, expect, it, vi } from "vitest";

import { createRadiosoClient } from "../../src/index.js";

describe("sdk client integration", () => {
  it("supports token-based document, settings, and chat history operations through the public surface", async () => {
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
          workspaceId: "w1",
          chunkingStrategy: "fixed_window",
          fixedWindowChunkSize: 800,
          fixedWindowChunkOverlap: 120,
          structuredMinChunkSize: 400,
          structuredMaxChunkSize: 1200,
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          anonymousChatEnabled: true,
          anonymousChatUrl: "https://chat.example.com/token",
          anonymousRateLimit: 10,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          searches: [],
          total: 0,
          nextCursor: null,
          hasMore: false,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          conversations: [],
          total: 0,
          nextCursor: null,
          hasMore: false,
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
    const retrievalSettings = await client.settings.getRetrieval();
    const ingestionSettings = await client.settings.getIngestion();
    const generalSettings = await client.settings.getGeneral();
    const searchHistory = await client.documents.listHistory({ limit: 10 });
    const chatHistory = await client.chat.listHistory({ limit: 10 });
    const chat = await client.chat.create({ query: "hello", stream: false });

    expect(documents.documents).toEqual([]);
    expect(retrievalSettings.answerSupportPolicy).toBe("strict");
    expect(ingestionSettings.chunkingStrategy).toBe("fixed_window");
    expect(generalSettings.anonymousChatEnabled).toBe(true);
    expect(searchHistory.searches).toEqual([]);
    expect(chatHistory.conversations).toEqual([]);
    expect(chat.answer).toBe("hello");
  });
});
