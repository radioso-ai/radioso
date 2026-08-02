import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AgenticCapabilityRunner,
  DefaultAgentRuntime,
  type ModelToolCall,
  type ModelToolCallRequest,
  type ModelToolCallResponse,
  type ModelToolCallingGateway,
} from "../../src/shared/agent-runtime/index.js";
import type { QueryEmbeddingPort } from "../../src/modules/embeddingProfiles/contracts/embeddingConsumers.js";
import type { RetrievalSubquery } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import type { VectorCandidateSearchPort } from "../../src/modules/retrieval/domain/vectorAdapter.js";
import type { LexicalSearchPort } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { AgenticRetrievalRunner } from "../../src/modules/retrieval/services/agenticRetrievalRunner.js";
import { CandidateRetrievalStageService } from "../../src/modules/retrieval/services/candidateRetrievalStage.js";
import type { QueryInterpretationStageResult } from "../../src/modules/retrieval/services/retrievalPipelineStages.js";

const embeddingSpace = {
  id: "space-active",
  dimensions: 2,
  distanceMetric: "cosine" as const,
};

const semanticHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const makeInterpretation = (
  activeRetrievalSubqueries: RetrievalSubquery[],
): QueryInterpretationStageResult => ({
  request: {
    workspaceId: "workspace-1",
    query: "combined visitor question",
    history: [],
  },
  settings: {
    workspaceId: "workspace-1",
    queryRewriteEnabled: true,
    semanticRewriteInstructions: "",
    lexicalRewriteInstructions: "",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    rerankEnabled: false,
    vectorTopK: 20,
    similarityThreshold: 0.2,
    rerankTopK: 5,
    metadataRules: [],
    customInstruction: "",
    createdAt: new Date("2026-08-02T12:00:00.000Z"),
    updatedAt: new Date("2026-08-02T12:00:00.000Z"),
  },
  contextWindow: {
    selectedMessages: [],
    truncated: false,
    selectionReason: "no-history",
  },
  originalParsedQuery: {
    originalQuery: "combined visitor question",
    semanticQuery: "combined visitor question",
    lexicalQuery: "combined visitor question",
    constraints: [],
  },
  originalPreparedQuery: {
    originalQuery: "combined visitor question",
    semanticQuery: "combined visitor question",
    lexicalQuery: "combined visitor question",
    constraints: [],
  },
  rewrittenQuery: {
    originalQuery: "combined visitor question",
    rewrittenQuery: "combined visitor question",
    effectiveQuery: "combined visitor question",
    semanticQuery: "combined visitor question",
    lexicalQuery: "combined visitor question",
    retrievalSubqueries: activeRetrievalSubqueries,
    rewriteApplied: true,
    retrievalEligible: true,
    status: "applied",
    confidence: 0.9,
  },
  activeQuery: "combined visitor question",
  activeParsedQuery: {
    originalQuery: "combined visitor question",
    semanticQuery: "combined visitor question",
    lexicalQuery: "combined visitor question",
    constraints: [],
  },
  activeSemanticQuery: "combined visitor question",
  activeRetrievalSubqueries,
  triggerAnalysis: {
    status: "skipped_not_configured",
    consideredRules: [],
    matchedRuleIds: [],
    unmatchedRuleIds: [],
    matchCount: 0,
    matcherVersion: "test",
  },
  promptHistory: [],
  promptHistoryReset: false,
  continuityDecision: "updated",
});

const makeDeterministicStage = (input: {
  embeddedTexts?: string[][];
  searchedVectors?: number[][];
  failVector?: number;
  failEmbedding?: boolean;
}) => new CandidateRetrievalStageService(
  {
    async embedQueries(request) {
      input.embeddedTexts?.push([...request.texts]);
      if (input.failEmbedding) {
        throw new Error("embedding unavailable");
      }
      return {
        space: embeddingSpace,
        vectors: request.texts.map((_, index) => [index + 1, index + 11]),
      };
    },
  },
  {
    async search(request) {
      input.searchedVectors?.push([...request.queryVector]);
      if (request.queryVector[0] === input.failVector) {
        throw new Error("vector search unavailable");
      }
      return [];
    },
  },
  { async search() { return []; } },
  { async hydrate() { return []; } },
);

describe("semantic vector envelopes", () => {
  it("returns one deterministic envelope per distinct successfully searched semantic query", async () => {
    const embeddedTexts: string[][] = [];
    const searchedVectors: number[][] = [];
    const stage = makeDeterministicStage({ embeddedTexts, searchedVectors });

    const result = await stage.execute(makeInterpretation([
      { id: "subquery_1", label: "Recovery", semanticQuery: "recover account access", lexicalQuery: "recovery" },
      { id: "subquery_2", label: "Reset", semanticQuery: "recover account access", lexicalQuery: "reset" },
      { id: "subquery_3", label: "MFA", semanticQuery: "replace an MFA device", lexicalQuery: "MFA device" },
    ]));

    expect(embeddedTexts).toEqual([["recover account access", "replace an MFA device"]]);
    expect(searchedVectors).toEqual([[1, 11], [2, 12]]);
    expect(result.semanticVectors).toEqual([
      {
        intentId: "subquery_1",
        semanticTextHash: semanticHash("recover account access"),
        vector: [1, 11],
        space: embeddingSpace,
      },
      {
        intentId: "subquery_3",
        semanticTextHash: semanticHash("replace an MFA device"),
        vector: [2, 12],
        space: embeddingSpace,
      },
    ]);
  });

  it("omits deterministic envelopes for failed and capped semantic searches", async () => {
    const embeddedTexts: string[][] = [];
    const searchedVectors: number[][] = [];
    const stage = makeDeterministicStage({ embeddedTexts, searchedVectors, failVector: 2 });

    const result = await stage.execute(makeInterpretation([
      { id: "subquery_1", label: "One", semanticQuery: "semantic one", lexicalQuery: "one" },
      { id: "subquery_2", label: "Two", semanticQuery: "semantic two", lexicalQuery: "two" },
      { id: "subquery_3", label: "Three", semanticQuery: "semantic three", lexicalQuery: "three" },
    ]));

    expect(embeddedTexts).toEqual([["semantic one", "semantic two"]]);
    expect(searchedVectors).toEqual([[1, 11], [2, 12]]);
    expect(result.semanticVectors).toEqual([
      {
        intentId: "subquery_1",
        semanticTextHash: semanticHash("semantic one"),
        vector: [1, 11],
        space: embeddingSpace,
      },
    ]);
  });

  it("returns no deterministic envelopes when query embedding fails", async () => {
    const searchedVectors: number[][] = [];
    const stage = makeDeterministicStage({ searchedVectors, failEmbedding: true });

    const result = await stage.execute(makeInterpretation([
      { id: "primary", label: "Question", semanticQuery: "semantic question", lexicalQuery: "question" },
    ]));

    expect(searchedVectors).toEqual([]);
    expect(result.semanticVectors).toEqual([]);
  });

  it("collects successful agentic semantic searches and deduplicates repeated semantic text", async () => {
    const gateway = scriptedGateway([
      { say: "first", tools: [toolCall("semantic_search", { query: "refund policy" }, "semantic-call-1")] },
      { say: "repeat", tools: [toolCall("semantic_search", { query: "refund policy" }, "semantic-call-2")] },
      { say: "second", tools: [toolCall("semantic_search", { query: "billing schedule" }, "semantic-call-3")] },
      { say: "finish", tools: [toolCall("finalize", { chunkIds: [] }, "finalize-call")] },
      { say: "done" },
    ]);
    const embeddingRequests: string[][] = [];
    const queryEmbeddings: QueryEmbeddingPort = {
      async embedQueries(request) {
        embeddingRequests.push([...request.texts]);
        return {
          space: embeddingSpace,
          vectors: [request.texts[0] === "refund policy" ? [0.25, 0.75] : [0.5, 0.5]],
        };
      },
    };
    const vectorSearch: VectorCandidateSearchPort = { async search() { return []; } };
    const lexicalSearch: LexicalSearchPort = { async search() { return []; } };
    const runner = new AgenticRetrievalRunner({
      capabilityRunner: new AgenticCapabilityRunner({ runtime: new DefaultAgentRuntime({ gateway }) }),
      queryEmbeddings,
      vectorSearch,
      chunkHydrator: { async hydrate() { return []; } },
      lexicalSearch,
      queryRewrite: { async rewrite({ query }) { return { semantic: query, lexical: query }; } },
      rerankGateway: { async rerank() { return []; } },
    });

    const result = await runner.run({
      workspaceId: "workspace-1",
      query: "visitor question",
      systemPrompt: "Retrieve supporting context.",
    });

    expect(embeddingRequests).toEqual([["refund policy"], ["refund policy"], ["billing schedule"]]);
    expect(result.semanticVectors).toEqual([
      {
        intentId: "semantic-call-1",
        semanticTextHash: semanticHash("refund policy"),
        vector: [0.25, 0.75],
        space: embeddingSpace,
      },
      {
        intentId: "semantic-call-3",
        semanticTextHash: semanticHash("billing schedule"),
        vector: [0.5, 0.5],
        space: embeddingSpace,
      },
    ]);
    const serializedTrace = JSON.stringify(result.trace);
    expect(serializedTrace).not.toContain(semanticHash("refund policy"));
    expect(serializedTrace).not.toContain('"vector"');
  });

  it("does not collect an agentic envelope when semantic search fails", async () => {
    const gateway = scriptedGateway([
      { say: "try", tools: [toolCall("semantic_search", { query: "unavailable topic" }, "failed-call-1")] },
      { say: "retry", tools: [toolCall("semantic_search", { query: "unavailable topic" }, "failed-call-2")] },
    ]);
    const runner = new AgenticRetrievalRunner({
      capabilityRunner: new AgenticCapabilityRunner({ runtime: new DefaultAgentRuntime({ gateway }) }),
      queryEmbeddings: {
        async embedQueries() {
          return { space: embeddingSpace, vectors: [[0.4, 0.6]] };
        },
      },
      vectorSearch: { async search() { throw new Error("vector search unavailable"); } },
      chunkHydrator: { async hydrate() { throw new Error("should not hydrate"); } },
      lexicalSearch: { async search() { return []; } },
      queryRewrite: { async rewrite({ query }) { return { semantic: query, lexical: query }; } },
      rerankGateway: { async rerank() { return []; } },
    });

    const result = await runner.run({
      workspaceId: "workspace-1",
      query: "visitor question",
      systemPrompt: "Retrieve supporting context.",
    });

    expect(result.terminatedReason).toBe("tool_invocation_failed");
    expect(result.semanticVectors).toEqual([]);
  });
});

type ScriptedTurn = { say: string; tools?: ModelToolCall[] };

const scriptedGateway = (script: ScriptedTurn[]): ModelToolCallingGateway => {
  let index = 0;
  return {
    async request(_request: ModelToolCallRequest): Promise<ModelToolCallResponse> {
      const turn = script[index++];
      return turn
        ? { assistantMessage: turn.say, toolCalls: turn.tools ?? [] }
        : { assistantMessage: "done", toolCalls: [] };
    },
  };
};

const toolCall = (toolName: string, args: unknown, callId: string): ModelToolCall => ({
  callId,
  toolName,
  rawArguments: JSON.stringify(args),
});
