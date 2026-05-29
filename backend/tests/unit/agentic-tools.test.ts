import { describe, expect, it } from "vitest";

import {
  InMemoryChunkRegistry,
  buildSnippet,
  createFetchChunkTool,
  createFinalizeTool,
  createLexicalSearchTool,
  createRerankTool,
  createRewriteQueryTool,
  createSemanticSearchTool,
  fromRetrievedChunk,
  type FinalizedSelection,
} from "../../src/modules/retrieval/services/agenticTools/index.js";
import { mergeMetadataFilters } from "../../src/modules/retrieval/services/agenticTools/semanticSearchTool.js";
import type { RetrievedChunk, VectorSearchPort } from "../../src/modules/retrieval/public.js";
import type { LexicalSearchPort } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import type { EmbeddingGateway } from "../../src/modules/retrieval/services/embeddingService.js";
import type { QueryRewritePort } from "../../src/modules/retrieval/domain/queryRewritePort.js";
import type { RerankGateway } from "../../src/modules/retrieval/services/rerankService.js";

const toolCtx = { signal: new AbortController().signal, stepIndex: 0, callId: "tool-call-1" };
const usageContext = {
  workspaceId: "ws-1",
  requestId: "req-1",
  surface: "retrieval",
  attemptKey: "agentic",
};

const chunk = (overrides: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  chunkId: overrides.chunkId ?? "chunk-1",
  documentId: overrides.documentId ?? "doc-1",
  title: overrides.title ?? "Document Title",
  content: overrides.content ?? "Mahatma Gandhi was an Indian lawyer and political ethicist.",
  searchText: overrides.searchText,
  similarity: overrides.similarity ?? 0.82,
  chunkIndex: overrides.chunkIndex ?? 0,
  startOffset: overrides.startOffset,
  endOffset: overrides.endOffset,
  metadata: overrides.metadata ?? {},
});

describe("InMemoryChunkRegistry", () => {
  it("records and resolves chunks", () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([fromRetrievedChunk(chunk({ chunkId: "a" })), fromRetrievedChunk(chunk({ chunkId: "b" }))]);
    expect(registry.resolve(["a", "b"]).map((c) => c.chunkId)).toEqual(["a", "b"]);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
  });

  it("returns only known chunkIds when resolving a mixed list", () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([fromRetrievedChunk(chunk({ chunkId: "known" }))]);
    expect(registry.resolve(["known", "missing"]).map((c) => c.chunkId)).toEqual(["known"]);
  });

  it("buildSnippet truncates long content with an ellipsis", () => {
    const long = "x".repeat(500);
    const snippet = buildSnippet({ content: long }, 100);
    expect(snippet.length).toBeLessThanOrEqual(101); // 100 chars + ellipsis
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("buildSnippet prefers searchText over content when available", () => {
    const snippet = buildSnippet({ content: "from content", searchText: "from search" });
    expect(snippet).toBe("from search");
  });
});

describe("mergeMetadataFilters", () => {
  it("returns undefined when both filters are absent", () => {
    expect(mergeMetadataFilters(undefined, undefined)).toBeUndefined();
  });

  it("returns the caller filter when model has none", () => {
    expect(mergeMetadataFilters(undefined, { type: "policy" })).toEqual({ type: "policy" });
  });

  it("returns the model filter when caller has none", () => {
    expect(mergeMetadataFilters({ year: "2025" }, undefined)).toEqual({ year: "2025" });
  });

  it("merges non-overlapping keys (both apply)", () => {
    expect(mergeMetadataFilters({ year: "2025" }, { type: "policy" })).toEqual({
      year: "2025",
      type: "policy",
    });
  });

  it("caller wins on key conflict (model cannot relax caller scope)", () => {
    expect(mergeMetadataFilters({ type: "marketing" }, { type: "policy" })).toEqual({
      type: "policy",
    });
  });
});

describe("semantic_search tool", () => {
  it("embeds the query, searches, registers the chunks, and returns snippets", async () => {
    const embeddingCalls: string[][] = [];
    const searchCalls: Array<Parameters<VectorSearchPort["search"]>[0]> = [];
    const embeddings: EmbeddingGateway = {
      async embedTexts(texts) {
        embeddingCalls.push(texts);
        return [Array(4).fill(0.1)];
      },
    };
    const vectorSearch: VectorSearchPort = {
      async search(input) {
        searchCalls.push(input);
        return [chunk({ chunkId: "s1" }), chunk({ chunkId: "s2", similarity: 0.7 })];
      },
    };
    const registry = new InMemoryChunkRegistry();
    const tool = createSemanticSearchTool({
      workspaceId: "ws-1",
      embeddings,
      vectorSearch,
      registry,
    });

    const result = await tool.invoke({ query: "who was gandhi" }, toolCtx);

    expect(embeddingCalls).toEqual([["who was gandhi"]]);
    expect(searchCalls[0]).toMatchObject({ workspaceId: "ws-1", topK: 5 });
    expect(result.results.map((r) => r.chunkId)).toEqual(["s1", "s2"]);
    expect(result.results[0].snippet.length).toBeGreaterThan(0);
    expect(registry.has("s1")).toBe(true);
    expect(registry.has("s2")).toBe(true);
  });

  it("scopes embedding usage idempotency to the tool call", async () => {
    const embeddingOptions: Array<Parameters<EmbeddingGateway["embedTexts"]>[1]> = [];
    const embeddings: EmbeddingGateway = {
      async embedTexts(_texts, options) {
        embeddingOptions.push(options);
        return [[0.1]];
      },
    };
    const vectorSearch: VectorSearchPort = { async search() { return []; } };
    const tool = createSemanticSearchTool({
      workspaceId: "ws-1",
      embeddings,
      vectorSearch,
      registry: new InMemoryChunkRegistry(),
      usageContext,
    });

    await tool.invoke({ query: "anything" }, { ...toolCtx, stepIndex: 2, callId: "call-semantic-a" });

    expect(embeddingOptions[0]?.usageContext).toMatchObject({
      operation: "query_embedding",
      attemptKey: "semantic_search:2:call-semantic-a",
    });
  });

  it("returns no results when the embedding gateway returns nothing", async () => {
    const embeddings: EmbeddingGateway = { async embedTexts() { return []; } };
    const vectorSearch: VectorSearchPort = { async search() { throw new Error("should not be called"); } };
    const tool = createSemanticSearchTool({
      workspaceId: "ws-1",
      embeddings,
      vectorSearch,
      registry: new InMemoryChunkRegistry(),
    });
    const result = await tool.invoke({ query: "anything" }, toolCtx);
    expect(result.results).toEqual([]);
  });

  it("applies the caller-supplied metadataFilter even when the model omits its own", async () => {
    const searchCalls: Array<Parameters<VectorSearchPort["search"]>[0]> = [];
    const embeddings: EmbeddingGateway = { async embedTexts() { return [[0.1]]; } };
    const vectorSearch: VectorSearchPort = {
      async search(input) {
        searchCalls.push(input);
        return [];
      },
    };
    const tool = createSemanticSearchTool({
      workspaceId: "ws-1",
      embeddings,
      vectorSearch,
      registry: new InMemoryChunkRegistry(),
      callerMetadataFilter: { tenant: "acme" },
    });
    await tool.invoke({ query: "anything" }, toolCtx);
    expect(searchCalls[0].metadataFilter).toEqual({ tenant: "acme" });
  });

  it("caller's metadataFilter wins on key conflict with the model's filter", async () => {
    const searchCalls: Array<Parameters<VectorSearchPort["search"]>[0]> = [];
    const tool = createSemanticSearchTool({
      workspaceId: "ws-1",
      embeddings: { async embedTexts() { return [[0.1]]; } },
      vectorSearch: {
        async search(input) {
          searchCalls.push(input);
          return [];
        },
      },
      registry: new InMemoryChunkRegistry(),
      callerMetadataFilter: { tenant: "acme" },
    });
    await tool.invoke({ query: "q", metadataFilter: { tenant: "other", year: "2025" } }, toolCtx);
    expect(searchCalls[0].metadataFilter).toEqual({ tenant: "acme", year: "2025" });
  });

  it("respects topK from the agent and caps via Zod at 20", () => {
    const tool = createSemanticSearchTool({
      workspaceId: "ws-1",
      embeddings: { async embedTexts() { return [[0]]; } },
      vectorSearch: { async search() { return []; } },
      registry: new InMemoryChunkRegistry(),
    });
    expect(tool.inputSchema.safeParse({ query: "q", topK: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ query: "q", topK: 21 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ query: "q", topK: 10 }).success).toBe(true);
  });
});

describe("lexical_search tool", () => {
  it("delegates to LexicalSearchPort and registers results", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const lexicalSearch: LexicalSearchPort = {
      async search(input) {
        calls.push(input);
        return [chunk({ chunkId: "l1" })];
      },
    };
    const registry = new InMemoryChunkRegistry();
    const tool = createLexicalSearchTool({ workspaceId: "ws-1", lexicalSearch, registry });

    const result = await tool.invoke({ query: "Gandhi", topK: 3 }, toolCtx);

    expect(calls[0]).toMatchObject({ workspaceId: "ws-1", query: "Gandhi", topK: 3 });
    expect(result.results[0].chunkId).toBe("l1");
    expect(registry.has("l1")).toBe(true);
  });
});

describe("rewrite_query tool", () => {
  it("delegates to QueryRewritePort and returns its output verbatim", async () => {
    const port: QueryRewritePort = {
      async rewrite(input) {
        expect(input.query).toBe("gandhi and kasturbai");
        return { semantic: "Mahatma Gandhi Kasturbai", lexical: "Gandhi OR Kasturbai" };
      },
    };
    const tool = createRewriteQueryTool({ queryRewrite: port });
    const result = await tool.invoke({ query: "gandhi and kasturbai" }, toolCtx);
    expect(result).toEqual({ semantic: "Mahatma Gandhi Kasturbai", lexical: "Gandhi OR Kasturbai" });
  });

  it("scopes rewrite usage idempotency to the tool call", async () => {
    const calls: Array<Parameters<QueryRewritePort["rewrite"]>[0]> = [];
    const port: QueryRewritePort = {
      async rewrite(input) {
        calls.push(input);
        return { semantic: input.query, lexical: input.query };
      },
    };
    const tool = createRewriteQueryTool({ queryRewrite: port, usageContext });

    await tool.invoke({ query: "gandhi" }, { ...toolCtx, stepIndex: 3, callId: "call-rewrite-a" });

    expect(calls[0].usageContext).toMatchObject({
      attemptKey: "rewrite_tool:3:call-rewrite-a",
    });
  });
});

describe("rerank tool", () => {
  it("reorders previously-registered chunks by gateway scores and reports unknown ids", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([
      fromRetrievedChunk(chunk({ chunkId: "a", similarity: 0.5 })),
      fromRetrievedChunk(chunk({ chunkId: "b", similarity: 0.6 })),
    ]);
    const gateway: RerankGateway = {
      async rerank({ contexts }) {
        return contexts.map((c) => ({ chunkId: c.chunkId, relevanceScore: c.chunkId === "b" ? 0.9 : 0.2 }));
      },
    };
    const tool = createRerankTool({ rerankGateway: gateway, registry });

    const result = await tool.invoke({ query: "policy", chunkIds: ["a", "b", "missing"] }, toolCtx);

    expect(result.ranked.map((r) => r.chunkId)).toEqual(["b", "a"]);
    expect(result.ranked[0].relevanceScore).toBeCloseTo(0.9);
    expect(result.unknownChunkIds).toEqual(["missing"]);
  });

  it("scopes rerank usage idempotency to the tool call", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([fromRetrievedChunk(chunk({ chunkId: "a", similarity: 0.5 }))]);
    const calls: Array<Parameters<RerankGateway["rerank"]>[0]> = [];
    const gateway: RerankGateway = {
      async rerank(input) {
        calls.push(input);
        return [];
      },
    };
    const tool = createRerankTool({ rerankGateway: gateway, registry, usageContext });

    await tool.invoke({ query: "policy", chunkIds: ["a"] }, { ...toolCtx, stepIndex: 4, callId: "call-rerank-a" });

    expect(calls[0].usageContext).toMatchObject({
      operation: "rerank",
      attemptKey: "rerank_tool:4:call-rerank-a",
    });
  });

  it("falls back to registered similarity when the gateway omits a chunkId", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([fromRetrievedChunk(chunk({ chunkId: "only", similarity: 0.4 }))]);
    const gateway: RerankGateway = { async rerank() { return []; } };
    const tool = createRerankTool({ rerankGateway: gateway, registry });

    const result = await tool.invoke({ query: "q", chunkIds: ["only"] }, toolCtx);

    expect(result.ranked[0]).toMatchObject({ chunkId: "only", relevanceScore: 0.4 });
  });

  it("returns empty ranked list when none of the supplied chunkIds are known", async () => {
    const registry = new InMemoryChunkRegistry();
    const gateway: RerankGateway = { async rerank() { return []; } };
    const tool = createRerankTool({ rerankGateway: gateway, registry });

    const result = await tool.invoke({ query: "q", chunkIds: ["x", "y"] }, toolCtx);

    expect(result.ranked).toEqual([]);
    expect(result.unknownChunkIds).toEqual(["x", "y"]);
  });
});

describe("fetch_chunk tool", () => {
  it("returns the full chunk body from the registry", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([fromRetrievedChunk(chunk({ chunkId: "c1", content: "FULL BODY" }))]);
    const tool = createFetchChunkTool({ registry });

    const result = await tool.invoke({ chunkId: "c1" }, toolCtx);

    expect(result).toMatchObject({ chunkId: "c1", content: "FULL BODY" });
  });

  it("returns an unknown_chunk error when the chunkId was never surfaced via search", async () => {
    const tool = createFetchChunkTool({ registry: new InMemoryChunkRegistry() });
    const result = await tool.invoke({ chunkId: "ghost" }, toolCtx);
    expect(result).toEqual({ chunkId: "ghost", error: "unknown_chunk" });
  });
});

describe("finalize tool", () => {
  it("captures the selection and rationale via the callback", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([
      fromRetrievedChunk(chunk({ chunkId: "x" })),
      fromRetrievedChunk(chunk({ chunkId: "y" })),
    ]);
    const captured: FinalizedSelection[] = [];
    const tool = createFinalizeTool({
      registry,
      onFinalized: (selection) => captured.push(selection),
    });

    const result = await tool.invoke({ chunkIds: ["x", "y"], rationale: "covers both hops" }, toolCtx);

    expect(result).toEqual({ accepted: true, chunkIds: ["x", "y"] });
    expect(captured).toEqual([{ chunkIds: ["x", "y"], rationale: "covers both hops" }]);
  });

  it("dedups repeated chunkIds while preserving first-seen order", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([
      fromRetrievedChunk(chunk({ chunkId: "c1" })),
      fromRetrievedChunk(chunk({ chunkId: "c2" })),
    ]);
    const captured: FinalizedSelection[] = [];
    const tool = createFinalizeTool({ registry, onFinalized: (s) => captured.push(s) });

    const result = await tool.invoke({ chunkIds: ["c1", "c1", "c2", "c1"] }, toolCtx);

    expect(result).toEqual({ accepted: true, chunkIds: ["c1", "c2"] });
    expect(captured).toEqual([{ chunkIds: ["c1", "c2"], rationale: null }]);
  });

  it("accepts an empty chunkIds selection as an explicit no-evidence signal", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([fromRetrievedChunk(chunk({ chunkId: "surfaced-but-not-selected" }))]);
    const captured: FinalizedSelection[] = [];
    const tool = createFinalizeTool({ registry, onFinalized: (s) => captured.push(s) });

    const result = await tool.invoke({ chunkIds: [], rationale: "insufficient_evidence" }, toolCtx);

    expect(result).toEqual({ accepted: true, chunkIds: [] });
    expect(captured).toEqual([{ chunkIds: [], rationale: "insufficient_evidence" }]);
  });

  it("treats whitespace-only rationale as null", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([fromRetrievedChunk(chunk({ chunkId: "x" }))]);
    const captured: FinalizedSelection[] = [];
    const tool = createFinalizeTool({ registry, onFinalized: (s) => captured.push(s) });

    await tool.invoke({ chunkIds: ["x"], rationale: "   " }, toolCtx);

    expect(captured[0].rationale).toBeNull();
  });

  it("rejects selections containing unknown chunkIds without invoking the callback", async () => {
    const registry = new InMemoryChunkRegistry();
    registry.record([fromRetrievedChunk(chunk({ chunkId: "known" }))]);
    const captured: FinalizedSelection[] = [];
    const tool = createFinalizeTool({ registry, onFinalized: (s) => captured.push(s) });

    const result = await tool.invoke({ chunkIds: ["known", "ghost"] }, toolCtx);

    expect(result).toEqual({ accepted: false, error: "unknown_chunks", unknownChunkIds: ["ghost"] });
    expect(captured).toEqual([]);
  });

  it("rejects an answer-shaped rationale field if it would exceed the cap", () => {
    const registry = new InMemoryChunkRegistry();
    const tool = createFinalizeTool({ registry, onFinalized: () => {} });
    const tooLong = "x".repeat(3000);
    expect(tool.inputSchema.safeParse({ chunkIds: ["a"], rationale: tooLong }).success).toBe(false);
  });
});
