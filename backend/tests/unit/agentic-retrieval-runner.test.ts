import { describe, expect, it } from "vitest";

import {
  DefaultAgentRuntime,
  type ModelToolCall,
  type ModelToolCallRequest,
  type ModelToolCallResponse,
  type ModelToolCallingGateway,
} from "../../src/shared/agent-runtime/index.js";
import { AgenticRetrievalRunner } from "../../src/modules/retrieval/services/agenticRetrievalRunner.js";
import type { EmbeddingGateway } from "../../src/modules/retrieval/services/embeddingService.js";
import type { LexicalSearchPort } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import type { QueryRewritePort } from "../../src/modules/retrieval/domain/queryRewritePort.js";
import type { RerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import type { RetrievedChunk, VectorSearchPort } from "../../src/modules/retrieval/public.js";

type ScriptedTurn = { say: string; tools?: ModelToolCall[] };

const makeGateway = (script: ScriptedTurn[]): ModelToolCallingGateway => {
  let i = 0;
  return {
    async request(_req: ModelToolCallRequest): Promise<ModelToolCallResponse> {
      const turn = script[i++];
      if (!turn) {
        return { assistantMessage: "exhausted", toolCalls: [] };
      }
      return { assistantMessage: turn.say, toolCalls: turn.tools ?? [] };
    },
  };
};

const call = (toolName: string, args: unknown, callId?: string): ModelToolCall => ({
  callId: callId ?? `c-${toolName}-${Math.random().toString(36).slice(2, 8)}`,
  toolName,
  rawArguments: JSON.stringify(args),
});

const chunk = (overrides: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  chunkId: overrides.chunkId ?? "chunk-1",
  documentId: overrides.documentId ?? "doc-1",
  title: overrides.title ?? "Document",
  content: overrides.content ?? "Some content describing the topic in detail for retrieval purposes.",
  searchText: overrides.searchText,
  similarity: overrides.similarity ?? 0.7,
  chunkIndex: overrides.chunkIndex,
  startOffset: overrides.startOffset,
  endOffset: overrides.endOffset,
  metadata: overrides.metadata ?? {},
});

const buildDeps = (overrides: {
  gateway?: ModelToolCallingGateway;
  vectorResults?: RetrievedChunk[];
  lexicalResults?: RetrievedChunk[];
} = {}) => {
  const embeddings: EmbeddingGateway = {
    async embedTexts(texts) {
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };
  const vectorSearch: VectorSearchPort = {
    async search() {
      return overrides.vectorResults ?? [];
    },
  };
  const lexicalSearch: LexicalSearchPort = {
    async search() {
      return overrides.lexicalResults ?? [];
    },
  };
  const queryRewrite: QueryRewritePort = {
    async rewrite(input) {
      return { semantic: `semantic: ${input.query}`, lexical: `lexical: ${input.query}` };
    },
  };
  const rerankGateway: RerankGateway = {
    async rerank({ contexts }) {
      return contexts.map((c, idx) => ({ chunkId: c.chunkId, relevanceScore: 1 - idx * 0.1 }));
    },
  };
  const runtime = new DefaultAgentRuntime({ gateway: overrides.gateway ?? makeGateway([{ say: "done" }]) });
  return { runtime, embeddings, vectorSearch, lexicalSearch, queryRewrite, rerankGateway };
};

const buildRunner = (overrides: Parameters<typeof buildDeps>[0] = {}) => new AgenticRetrievalRunner(buildDeps(overrides));

describe("AgenticRetrievalRunner", () => {
  it("returns the finalized chunks and rationale on a happy-path run", async () => {
    const gateway = makeGateway([
      { say: "searching", tools: [call("semantic_search", { query: "gandhi" }, "c1")] },
      {
        say: "finalizing",
        tools: [call("finalize", { chunkIds: ["chunk-a", "chunk-b"], rationale: "covers the question" }, "c2")],
      },
      { say: "complete" },
    ]);
    const runner = buildRunner({
      gateway,
      vectorResults: [chunk({ chunkId: "chunk-a" }), chunk({ chunkId: "chunk-b" })],
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      query: "who was gandhi",
      systemPrompt: "system",
    });

    expect(result.terminatedReason).toBe("completed");
    expect(result.selectedChunks.map((c) => c.chunkId)).toEqual(["chunk-a", "chunk-b"]);
    expect(result.rationale).toBe("covers the question");
  });

  it("reports search stats: distinct semantic/lexical/merged candidate counts and rerank invocation", async () => {
    const gateway = makeGateway([
      { say: "semantic", tools: [call("semantic_search", { query: "a" }, "c1")] },
      { say: "lexical", tools: [call("lexical_search", { query: "b" }, "c2")] },
      { say: "rerank", tools: [call("rerank", { query: "a", chunkIds: ["s1", "l1"] }, "c3")] },
      { say: "finalizing", tools: [call("finalize", { chunkIds: ["s1"] }, "c4")] },
      { say: "done" },
    ]);
    const runner = buildRunner({
      gateway,
      // s1 appears in both searches (dedup → merged counts it once); l1 only lexical.
      vectorResults: [chunk({ chunkId: "s1" })],
      lexicalResults: [chunk({ chunkId: "s1" }), chunk({ chunkId: "l1" })],
    });

    const result = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    expect(result.searchStats.semanticCandidateCount).toBe(1); // s1
    expect(result.searchStats.lexicalCandidateCount).toBe(2); // s1, l1
    expect(result.searchStats.mergedCandidateCount).toBe(2); // s1, l1 (s1 deduped)
    expect(result.searchStats.rerankInvoked).toBe(true);
  });

  it("reports rerankInvoked=false and zero counts when the agent only finalizes", async () => {
    const gateway = makeGateway([
      { say: "no search", tools: [call("finalize", { chunkIds: [], rationale: "insufficient_evidence" }, "c1")] },
      { say: "done" },
    ]);
    const runner = buildRunner({ gateway });

    const result = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    expect(result.searchStats).toEqual({
      semanticCandidateCount: 0,
      lexicalCandidateCount: 0,
      mergedCandidateCount: 0,
      rerankInvoked: false,
    });
  });

  it("maps each agent tool call onto an ActivityStage with kind agent_tool_call and sequence links", async () => {
    const gateway = makeGateway([
      { say: "searching", tools: [call("semantic_search", { query: "x" }, "c1")] },
      { say: "finalizing", tools: [call("finalize", { chunkIds: ["chunk-x"] }, "c2")] },
      { say: "done" },
    ]);
    const runner = buildRunner({ gateway, vectorResults: [chunk({ chunkId: "chunk-x" })] });

    const { trace } = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    const agenticStages = trace.stages.filter((s) => s.kind === "agent_tool_call");
    expect(agenticStages.map((s) => s.inputs?.toolName)).toEqual(["semantic_search", "finalize"]);
    expect(agenticStages.every((s) => s.status === "applied")).toBe(true);
    expect(trace.links).toHaveLength(agenticStages.length - 1);
    expect(trace.links.every((link) => link.kind === "sequence")).toBe(true);
  });

  it("populates ActivitySummary.agentic with run-level metadata", async () => {
    const gateway = makeGateway([
      { say: "go", tools: [call("semantic_search", { query: "q" }, "c1")] },
      { say: "fin", tools: [call("finalize", { chunkIds: ["c"], rationale: "why" }, "c2")] },
      { say: "done" },
    ]);
    const runner = buildRunner({ gateway, vectorResults: [chunk({ chunkId: "c" })] });

    const { trace } = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    expect(trace.summary?.agentic).toMatchObject({
      terminatedReason: "completed",
      stepsTaken: 3,
      finalRationale: "why",
      selectedChunkIds: ["c"],
    });
    expect(trace.summary?.agentic?.resolvedBudgets.maxSteps).toBeGreaterThan(0);
  });

  it("attaches the rationale to the finalize stage's outputs", async () => {
    const gateway = makeGateway([
      { say: "go", tools: [call("semantic_search", { query: "q" }, "c1")] },
      { say: "fin", tools: [call("finalize", { chunkIds: ["c"], rationale: "key reasoning" }, "c2")] },
      { say: "done" },
    ]);
    const runner = buildRunner({ gateway, vectorResults: [chunk({ chunkId: "c" })] });

    const { trace } = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    const finalizeStage = trace.stages.find((s) => s.inputs?.toolName === "finalize");
    expect(finalizeStage?.outputs).toMatchObject({ rationale: "key reasoning" });
  });

  it("returns fallback chunks when the agent exhausts the step budget without finalizing", async () => {
    const gateway = makeGateway([
      { say: "1", tools: [call("semantic_search", { query: "a" }, "c1")] },
      { say: "2", tools: [call("semantic_search", { query: "b" }, "c2")] },
      { say: "3", tools: [call("semantic_search", { query: "c" }, "c3")] },
    ]);
    const runner = buildRunner({
      gateway,
      vectorResults: [chunk({ chunkId: "from-search" })],
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      query: "q",
      systemPrompt: "sys",
      budgets: { maxSteps: 3 },
      fallbackChunkLimit: 5,
    });

    expect(result.terminatedReason).toBe("step_budget_exhausted");
    expect(result.rationale).toBeNull();
    expect(result.selectedChunks.map((c) => c.chunkId)).toContain("from-search");
  });

  it("falls back to default budgets when an override is NaN (does not loop unbounded)", async () => {
    // A NaN maxSteps would make `stepIndex >= NaN` always false. The guard must
    // treat NaN as absent and apply the default (6), so this 8-search script
    // terminates by step budget rather than running forever.
    const looping = Array.from({ length: 8 }, (_, i) => ({
      say: `${i}`,
      tools: [call("semantic_search", { query: `q${i}` }, `c${i}`)],
    }));
    const runner = buildRunner({
      gateway: makeGateway(looping),
      vectorResults: [chunk({ chunkId: "from-search" })],
    });

    const result = await runner.run({
      workspaceId: "ws-1",
      query: "q",
      systemPrompt: "sys",
      budgets: { maxSteps: Number("not-a-number") },
    });

    expect(result.terminatedReason).toBe("step_budget_exhausted");
    expect(result.stepsTaken).toBe(6); // default applied, not NaN
  });

  it("honors an explicit empty finalize as no-evidence — does NOT fall back to surfaced chunks", async () => {
    const gateway = makeGateway([
      { say: "searching", tools: [call("semantic_search", { query: "ghost topic" }, "c1")] },
      {
        say: "no luck",
        tools: [call("finalize", { chunkIds: [], rationale: "insufficient_evidence" }, "c2")],
      },
      { say: "done" },
    ]);
    const runner = buildRunner({
      gateway,
      vectorResults: [chunk({ chunkId: "surfaced-but-irrelevant" })],
    });

    const result = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    expect(result.terminatedReason).toBe("completed");
    expect(result.selectedChunks).toEqual([]);
    expect(result.rationale).toBe("insufficient_evidence");
  });

  it("supports a multi-hop run: first search yields nothing, agent rewrites and searches again", async () => {
    const calls: Array<{ query: string }> = [];
    const dynamicEmbedDeps = buildDeps();
    const vectorSearch: VectorSearchPort = {
      async search(input) {
        calls.push({ query: JSON.stringify(input.queryEmbedding.slice(0, 1)) });
        if (calls.length === 1) {
          return [];
        }
        return [chunk({ chunkId: "second-hop" })];
      },
    };
    const gateway = makeGateway([
      { say: "first try", tools: [call("semantic_search", { query: "ambiguous" }, "c1")] },
      { say: "rewriting", tools: [call("rewrite_query", { query: "ambiguous" }, "c2")] },
      { say: "retrying", tools: [call("semantic_search", { query: "specific" }, "c3")] },
      { say: "finalizing", tools: [call("finalize", { chunkIds: ["second-hop"] }, "c4")] },
      { say: "done" },
    ]);
    const runner = new AgenticRetrievalRunner({ ...dynamicEmbedDeps, runtime: new DefaultAgentRuntime({ gateway }), vectorSearch });

    const result = await runner.run({ workspaceId: "ws-1", query: "ambiguous", systemPrompt: "sys" });

    expect(result.terminatedReason).toBe("completed");
    expect(result.selectedChunks.map((c) => c.chunkId)).toEqual(["second-hop"]);
    const toolSequence = result.trace.stages.filter((s) => s.kind === "agent_tool_call").map((s) => s.inputs?.toolName);
    expect(toolSequence).toEqual(["semantic_search", "rewrite_query", "semantic_search", "finalize"]);
  });

  it("marks a terminal validation failure stage as rejected in the trace", async () => {
    const gateway = makeGateway([
      { say: "try ghost", tools: [call("ghost_tool", { x: 1 }, "c1")] },
      { say: "try ghost again", tools: [call("ghost_tool", { x: 1 }, "c2")] },
    ]);
    const runner = buildRunner({ gateway });

    const result = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    expect(result.terminatedReason).toBe("tool_validation_failed");
    const rejectedStages = result.trace.stages.filter((s) => s.status === "rejected");
    expect(rejectedStages.length).toBeGreaterThan(0);
    expect(rejectedStages.every((s) => s.kind === "agent_tool_call")).toBe(true);
  });

  it("marks only the LAST rejection as terminal — earlier rejections stay fallback", async () => {
    // Runtime terminates on the SECOND consecutive rejection of the same tool name
    // (FR-005). The trace should mark the second call as terminal, not the first.
    const gateway = makeGateway([
      { say: "first try", tools: [call("ghost_tool", { x: 1 }, "c1")] },
      { say: "second try", tools: [call("ghost_tool", { x: 1 }, "c2")] },
    ]);
    const runner = buildRunner({ gateway });

    const result = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    expect(result.terminatedReason).toBe("tool_validation_failed");
    const rejectedStages = result.trace.stages.filter((s) => s.kind === "agent_tool_call");
    // Two stages, both rejected by the validator. Only the LAST one should carry status="rejected".
    expect(rejectedStages).toHaveLength(2);
    expect(rejectedStages[0].status).toBe("fallback");
    expect(rejectedStages[1].status).toBe("rejected");
    expect(rejectedStages[0].inputs?.callId).toBe("c1");
    expect(rejectedStages[1].inputs?.callId).toBe("c2");
  });


  it("rejects a finalize with unknown chunkIds without marking the run as finalized", async () => {
    const gateway = makeGateway([
      { say: "go", tools: [call("semantic_search", { query: "q" }, "c1")] },
      { say: "premature", tools: [call("finalize", { chunkIds: ["never-seen"] }, "c2")] },
      { say: "done" },
    ]);
    const runner = buildRunner({ gateway, vectorResults: [chunk({ chunkId: "seen" })] });

    const result = await runner.run({ workspaceId: "ws-1", query: "q", systemPrompt: "sys" });

    expect(result.terminatedReason).toBe("completed");
    expect(result.rationale).toBeNull();
    // No finalize chunks accepted → fall back to what the agent surfaced via search.
    expect(result.selectedChunks.map((c) => c.chunkId)).toContain("seen");
  });
});
