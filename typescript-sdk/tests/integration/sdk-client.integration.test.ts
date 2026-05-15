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
          activitySummary: {},
          activityTrace: {},
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
    const chat = await client.chat.create({ message: "hello", stream: false });

    expect(documents.documents).toEqual([]);
    expect(ingestionSettings.chunkingStrategy).toBe("fixed_window");
    expect(generalSettings.anonymousChatEnabled).toBe(true);
    expect(searchHistory.searches).toEqual([]);
    expect(chatHistory.conversations).toEqual([]);
    expect(chat.answer).toBe("hello");
  });

  it("imports a source file through the SDK document facade", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        documentId: "doc-1",
        status: "accepted",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createRadiosoClient({
      baseUrl: "https://api.example.com",
      apiToken: "token-123",
      fetch: fetchMock as typeof fetch,
    });

    const result = await client.documents.importFile({
      file: new Blob(["Policy content"], { type: "text/plain" }),
      filename: "policy.txt",
      title: "Policy",
    });

    expect(result.documentId).toBe("doc-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("https://api.example.com/api/v1/document/import");
    expect(init.method).toBe("POST");
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("Content-Type")).toBeNull();
    expect(init.body).toBeInstanceOf(FormData);
    const formData = init.body as FormData;
    expect(formData.get("title")).toBe("Policy");
    expect(formData.get("file")).toBeInstanceOf(File);
    expect((formData.get("file") as File).name).toBe("policy.txt");
  });
});
