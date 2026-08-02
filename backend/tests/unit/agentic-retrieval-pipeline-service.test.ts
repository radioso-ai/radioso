import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { AgenticRetrievalPipelineService } from "../../src/modules/retrieval/services/agenticRetrievalPipelineService.js";
import type { AgenticRetrievalRunResult, AgenticRetrievalRunner } from "../../src/modules/retrieval/services/agenticRetrievalRunner.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import type { RegisteredChunk } from "../../src/modules/retrieval/services/agenticTools/index.js";
import { REWRITE_STATUS } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import type { ActivityTrace } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";
import type {
  RetrievalPipelineInterpretationResult,
  RetrievalPipelineResult,
  RetrievalPipelineService,
} from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import type { RetrievalPipelineRequest } from "../../src/modules/retrieval/services/retrievalPipelineStages.js";

const baseSettings = (overrides: Partial<ReturnType<typeof defaultRetrievalSettings>> = {}) => ({
  ...defaultRetrievalSettings("ws-1"),
  citationDisplayEnabled: true,
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 3,
  customInstruction: "be concise",
  ...overrides,
});

const buildInterpretation = (
  request: RetrievalPipelineRequest,
  overrides: {
    semanticQuery?: string;
    retrievalEligible?: boolean;
    activeParsedSemanticQuery?: string;
    activeRetrievalSubqueries?: RetrievalPipelineInterpretationResult["interpretation"]["result"]["activeRetrievalSubqueries"];
  } = {},
): RetrievalPipelineInterpretationResult => ({
  request,
  traceStartedAtMs: 0,
  context: {
    result: {
      request,
      settings: baseSettings(),
      contextWindow: { selectedMessages: [], truncated: false, selectionReason: "no history" },
    },
    startedAt: 0,
    durationMs: 0,
  },
  interpretation: {
    result: {
      request,
      settings: baseSettings(),
      contextWindow: { selectedMessages: [], truncated: false, selectionReason: "no history" },
      originalParsedQuery: { semanticQuery: request.query, lexicalQuery: request.query, constraints: [] },
      originalPreparedQuery: { semanticQuery: request.query, lexicalQuery: request.query, constraints: [] },
      rewrittenQuery: {
        originalQuery: request.query,
        rewrittenQuery: overrides.semanticQuery ?? request.query,
        effectiveQuery: overrides.semanticQuery ?? request.query,
        semanticQuery: overrides.semanticQuery ?? request.query,
        lexicalQuery: request.query,
        responseLanguagePolicy: "match_user_question",
        rewriteApplied: Boolean(overrides.semanticQuery),
        retrievalEligible: overrides.retrievalEligible ?? true,
        status: REWRITE_STATUS.APPLIED,
        confidence: 0.9,
      },
      activeQuery: overrides.semanticQuery ?? request.query,
      activeParsedQuery: {
        semanticQuery: overrides.activeParsedSemanticQuery ?? overrides.semanticQuery ?? request.query,
        lexicalQuery: request.query,
        constraints: [],
      },
      activeSemanticQuery: overrides.semanticQuery ?? request.query,
      activeRetrievalSubqueries: overrides.activeRetrievalSubqueries ?? [],
      triggerAnalysis: {
        status: "skipped_not_configured",
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "none",
      },
      promptHistory: [],
      promptHistoryReset: false,
      continuityDecision: "unchanged",
    },
    startedAt: 0,
    durationMs: 0,
  },
});

const buildRequest = (overrides: Partial<RetrievalPipelineRequest> = {}): RetrievalPipelineRequest => ({
  workspaceId: "ws-1",
  query: "who was Mahatma Gandhi",
  history: [],
  responseIdentity: null,
  ...overrides,
});

const stubChunk = (chunkId: string, content = "evidence body"): RegisteredChunk => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  title: `Title ${chunkId}`,
  snippet: content.slice(0, 80),
  fullContent: content,
  similarity: 0.7,
});

const emptyTrace = (): ActivityTrace => ({
  traceId: "agent-trace",
  startedAt: "2026-01-01T00:00:00.000Z",
  stages: [],
  links: [],
  summary: {
    agentic: {
      terminatedReason: "completed",
      stepsTaken: 2,
      toolResultTokensUsed: 100,
      wallTimeMs: 10,
      resolvedBudgets: { maxSteps: 6, maxToolResultTokens: 12000, maxWallTimeMs: 30000 },
      finalRationale: "covers it",
      selectedChunkIds: ["c1"],
    },
  },
});

const defaultSearchStats: AgenticRetrievalRunResult["searchStats"] = {
  semanticCandidateCount: 0,
  lexicalCandidateCount: 0,
  mergedCandidateCount: 0,
  rerankInvoked: false,
};

const semanticHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const semanticVector = (input: {
  intentId: string;
  text: string;
  vector: number[];
}) => ({
  intentId: input.intentId,
  semanticTextHash: semanticHash(input.text),
  vector: input.vector,
  space: {
    id: "space-1",
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: input.vector.length,
    distanceMetric: "cosine" as const,
  },
});

const stubRunner = (
  runResult: Omit<AgenticRetrievalRunResult, "searchStats"> & {
    searchStats?: AgenticRetrievalRunResult["searchStats"];
  },
): AgenticRetrievalRunner =>
  ({
    run: async () => ({ searchStats: defaultSearchStats, ...runResult }),
  }) as unknown as AgenticRetrievalRunner;

interface StubDeterministicState {
  interpretCalls: number;
  runWithoutRetrievalCalls: number;
  lastRunWithoutRetrievalInput: RetrievalPipelineInterpretationResult | null;
}

const stubDeterministic = (state: StubDeterministicState): RetrievalPipelineService => {
  const service = {
    async interpret(input: RetrievalPipelineRequest) {
      state.interpretCalls += 1;
      return buildInterpretation(input);
    },
    async run(input: RetrievalPipelineRequest) {
      const interpretation = await service.interpret(input);
      return service.runInterpreted(interpretation);
    },
    async runInterpreted(input: RetrievalPipelineInterpretationResult) {
      return buildEmptyResult(input);
    },
    async runWithoutRetrieval(input: RetrievalPipelineInterpretationResult) {
      state.runWithoutRetrievalCalls += 1;
      state.lastRunWithoutRetrievalInput = input;
      return buildEmptyResult(input, "non-retrieval");
    },
  };
  return service as unknown as RetrievalPipelineService;
};

const buildEmptyResult = (
  input: RetrievalPipelineInterpretationResult,
  marker = "empty",
): RetrievalPipelineResult => ({
  rewrittenQuery: input.request.query,
  contexts: [],
  systemPrompt: marker,
  prompt: marker,
  citations: [],
  responseIdentity: null,
  responseSettings: {
    citationDisplayEnabled: true,
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    customInstruction: "",
    responseLanguagePolicy: "match_user_question",
  },
  diagnostics: {
    rewriteStatus: REWRITE_STATUS.SKIPPED,
    rerankStatus: "skipped",
    originalCandidateCount: 0,
    rewrittenCandidateCount: 0,
    normalizedCandidateCount: 0,
    finalContextCount: 0,
    candidateFallbackApplied: false,
    fallbackApplied: false,
  },
  trace: emptyTrace(),
});

describe("AgenticRetrievalPipelineService", () => {
  it("runs the agent on retrieval intent and returns its selected chunks as contexts", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const runner = stubRunner({
      selectedChunks: [stubChunk("c1"), stubChunk("c2")],
      rationale: "covers both hops",
      trace: emptyTrace(),
      terminatedReason: "completed",
      stepsTaken: 3,
    });
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "agentic system",
    });

    const result = await service.run(buildRequest());

    expect(result.contexts.map((c) => c.chunkId)).toEqual(["c1", "c2"]);
    expect(result.responseIdentity).toBeNull();
    expect(detState.interpretCalls).toBe(1);
    expect(detState.runWithoutRetrievalCalls).toBe(0);
  });

  it("interpret() and runWithoutRetrieval() delegate cleanly to the deterministic instance", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner: stubRunner({
        selectedChunks: [],
        rationale: null,
        trace: emptyTrace(),
        terminatedReason: "completed",
        stepsTaken: 0,
      }),
      promptBuilder: new PromptBuilder(),
      systemPrompt: "agentic system",
    });

    const interpretation = await service.interpret(buildRequest());
    expect(detState.interpretCalls).toBe(1);
    expect(interpretation.request.query).toBe("who was Mahatma Gandhi");

    await service.runWithoutRetrieval(interpretation);
    expect(detState.runWithoutRetrievalCalls).toBe(1);
  });

  it("uses the rewritten semantic query as the agent's input when retrieval is eligible", async () => {
    let observedQuery: string | null = null;
    const runner = {
      run: async (input: { query: string }) => {
        observedQuery = input.query;
        return {
          selectedChunks: [stubChunk("c1")],
          rationale: null,
          trace: emptyTrace(),
          terminatedReason: "completed" as const,
          stepsTaken: 1,
          searchStats: defaultSearchStats,
        };
      },
    } as unknown as AgenticRetrievalRunner;
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const detService = {
      async interpret(input: RetrievalPipelineRequest) {
        detState.interpretCalls += 1;
        return buildInterpretation(input, { semanticQuery: "Mahatma Gandhi biography", retrievalEligible: true });
      },
      async run(input: RetrievalPipelineRequest) {
        const interpretation = await detService.interpret(input);
        return detService.runInterpreted(interpretation);
      },
      async runInterpreted(_input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult> {
        throw new Error("should not be called");
      },
      async runWithoutRetrieval(_input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult> {
        throw new Error("should not be called");
      },
    } as unknown as RetrievalPipelineService;
    const service = new AgenticRetrievalPipelineService({
      deterministic: detService,
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    await service.run(buildRequest({ query: "gandhi" }));

    expect(observedQuery).toBe("Mahatma Gandhi biography");
  });

  it("reports the active contextual intent and only reuses an exact agentic search vector", async () => {
    const semanticQuery = "Enterprise plan pricing";
    const runner = stubRunner({
      selectedChunks: [stubChunk("c1")],
      semanticVectors: [
        semanticVector({ intentId: "call-17", text: semanticQuery, vector: [0.1, 0.2] }),
        semanticVector({ intentId: "call-18", text: "invented agent search rewrite", vector: [0.3, 0.4] }),
      ],
      rationale: null,
      trace: emptyTrace(),
      terminatedReason: "completed",
      stepsTaken: 2,
    });
    const state: StubDeterministicState = {
      interpretCalls: 0,
      runWithoutRetrievalCalls: 0,
      lastRunWithoutRetrievalInput: null,
    };
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(state),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });
    const request = buildRequest({ query: "what does that cost?" });

    const result = await service.runInterpreted(buildInterpretation(request, {
      semanticQuery,
      activeParsedSemanticQuery: semanticQuery,
      activeRetrievalSubqueries: [{
        id: "primary",
        label: semanticQuery,
        semanticQuery,
        lexicalQuery: "enterprise plan pricing",
      }],
    }));

    expect(result.diagnostics.parsedQuery?.semanticQuery).toBe(semanticQuery);
    expect(result.diagnostics.retrievalSubqueries).toEqual([
      expect.objectContaining({ id: "primary", semanticQuery }),
    ]);
    expect(result.semanticVectors).toEqual([
      expect.objectContaining({
        intentId: "primary",
        semanticTextHash: semanticHash(semanticQuery),
        vector: [0.1, 0.2],
      }),
    ]);
  });

  it("maps exact agentic vectors onto the first canonical slot for each distinct subquery", async () => {
    const first = "SSO setup requirements";
    const second = "SCIM provisioning requirements";
    const subqueries = [
      { id: "subquery_1", label: "SSO", semanticQuery: first, lexicalQuery: "SSO setup" },
      { id: "subquery_2", label: "Duplicate", semanticQuery: first, lexicalQuery: "SSO docs" },
      { id: "subquery_3", label: "SCIM", semanticQuery: second, lexicalQuery: "SCIM" },
    ];
    const runner = stubRunner({
      selectedChunks: [],
      semanticVectors: [
        semanticVector({ intentId: "call-a", text: second, vector: [0.5, 0.6] }),
        semanticVector({ intentId: "call-b", text: first, vector: [0.1, 0.2] }),
      ],
      rationale: null,
      trace: emptyTrace(),
      terminatedReason: "completed",
      stepsTaken: 2,
    });
    const state: StubDeterministicState = {
      interpretCalls: 0,
      runWithoutRetrievalCalls: 0,
      lastRunWithoutRetrievalInput: null,
    };
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(state),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    const result = await service.runInterpreted(buildInterpretation(buildRequest(), {
      semanticQuery: first,
      activeParsedSemanticQuery: first,
      activeRetrievalSubqueries: subqueries,
    }));

    expect(result.diagnostics.retrievalSubqueries).toEqual(subqueries);
    expect(result.semanticVectors?.map((vector) => vector.intentId)).toEqual([
      "subquery_3",
      "subquery_1",
    ]);
  });

  it("uses PromptBuilder to construct systemPrompt and prompt from agent chunks", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const runner = stubRunner({
      selectedChunks: [stubChunk("c1", "first content"), stubChunk("c2", "second content")],
      rationale: null,
      trace: emptyTrace(),
      terminatedReason: "completed",
      stepsTaken: 2,
    });
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    const result = await service.run(buildRequest());

    expect(result.prompt.length).toBeGreaterThan(0);
    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.prompt).toContain("first content");
    expect(result.prompt).toContain("second content");
    expect(result.citations.map((c) => c.chunkId)).toEqual(["c1", "c2"]);
  });

  it("passes caller-supplied response language into agentic prompt assembly", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const calls: Array<Parameters<PromptBuilder["build"]>[0]> = [];
    const promptBuilder = {
      build(input: Parameters<PromptBuilder["build"]>[0]) {
        calls.push(input);
        return {
          systemPrompt: "system",
          prompt: "prompt",
          citations: [],
        };
      },
    } as unknown as PromptBuilder;
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner: stubRunner({
        selectedChunks: [stubChunk("c1")],
        rationale: null,
        trace: emptyTrace(),
        terminatedReason: "completed",
        stepsTaken: 1,
      }),
      promptBuilder,
      systemPrompt: "sp",
    });

    const result = await service.run(buildRequest({ responseLanguage: "English" }));

    expect(calls[0]?.settings.responseLanguage).toBe("English");
    expect(result.responseSettings.responseLanguage).toBe("English");
  });

  it("passes caller-supplied agentic tool factories into the runner", async () => {
    const agenticToolFactories = [() => []];
    const observed: { input?: { agenticToolFactories?: unknown } } = {};
    const runner = {
      run: async (input: { agenticToolFactories?: unknown }) => {
        observed.input = input;
        return {
          selectedChunks: [],
          rationale: null,
          trace: emptyTrace(),
          terminatedReason: "completed" as const,
          stepsTaken: 1,
          searchStats: defaultSearchStats,
        };
      },
    } as unknown as AgenticRetrievalRunner;
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "agentic system",
    });

    await service.runInterpreted(buildInterpretation(buildRequest({ agenticToolFactories })));

    expect(observed.input?.agenticToolFactories).toBe(agenticToolFactories);
  });

  it("returns the agent's trace as the pipeline trace", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const trace = emptyTrace();
    const runner = stubRunner({
      selectedChunks: [stubChunk("c1")],
      rationale: "ok",
      trace,
      terminatedReason: "completed",
      stepsTaken: 1,
    });
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    const result = await service.run(buildRequest());

    expect(result.trace).toBe(trace);
    expect(result.trace.summary?.agentic?.finalRationale).toBe("covers it");
  });

  it("reports real candidate counts and rerank status in diagnostics from the agent's searchStats", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const runner = stubRunner({
      selectedChunks: [stubChunk("c1")],
      rationale: null,
      trace: emptyTrace(),
      terminatedReason: "completed",
      stepsTaken: 3,
      searchStats: {
        semanticCandidateCount: 5,
        lexicalCandidateCount: 3,
        mergedCandidateCount: 7,
        rerankInvoked: true,
      },
    });
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    const result = await service.run(buildRequest());

    expect(result.diagnostics.rewrittenCandidateCount).toBe(5);
    expect(result.diagnostics.lexicalCandidateCount).toBe(3);
    expect(result.diagnostics.normalizedCandidateCount).toBe(7);
    expect(result.diagnostics.rerankStatus).toBe("applied");
  });

  it("reports rerankStatus 'skipped' when the agent did not invoke rerank", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const runner = stubRunner({
      selectedChunks: [stubChunk("c1")],
      rationale: null,
      trace: emptyTrace(),
      terminatedReason: "completed",
      stepsTaken: 2,
      searchStats: {
        semanticCandidateCount: 4,
        lexicalCandidateCount: 0,
        mergedCandidateCount: 4,
        rerankInvoked: false,
      },
    });
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    const result = await service.run(buildRequest());

    expect(result.diagnostics.rerankStatus).toBe("skipped");
    expect(result.diagnostics.rewrittenCandidateCount).toBe(4);
  });

  it("marks diagnostics.fallbackApplied true when the agent terminated by budget instead of finalize", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const runner = stubRunner({
      selectedChunks: [stubChunk("c1")],
      rationale: null,
      trace: emptyTrace(),
      terminatedReason: "step_budget_exhausted",
      stepsTaken: 6,
    });
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    const result = await service.run(buildRequest());

    expect(result.diagnostics.fallbackApplied).toBe(true);
    expect(result.diagnostics.finalContextCount).toBe(1);
    expect(result.diagnostics.retrievalSkipped).toBe(false);
  });

  it("threads the caller's metadataFilter and similarityThreshold into the runner", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    let captured: { metadataFilter?: unknown; similarityThreshold?: number } | null = null;
    const runner = {
      run: async (input: { metadataFilter?: unknown; similarityThreshold?: number }) => {
        captured = {
          metadataFilter: input.metadataFilter,
          similarityThreshold: input.similarityThreshold,
        };
        return {
          selectedChunks: [stubChunk("c1")],
          rationale: null,
          trace: emptyTrace(),
          terminatedReason: "completed" as const,
          stepsTaken: 1,
          searchStats: defaultSearchStats,
        };
      },
    } as unknown as AgenticRetrievalRunner;
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    await service.run(
      buildRequest({
        metadataFilter: { tenant: "acme" },
      }),
    );

    const captured2 = captured as { metadataFilter?: unknown; similarityThreshold?: number } | null;
    expect(captured2).not.toBeNull();
    expect(captured2?.metadataFilter).toEqual({ tenant: "acme" });
    // similarityThreshold comes from the resolved settings — defaultRetrievalSettings sets it.
    expect(typeof captured2?.similarityThreshold).toBe("number");
  });

  it("populates responseSettings from resolved settings and ignores suggested-question responseBehavior fields", async () => {
    const detState: StubDeterministicState = { interpretCalls: 0, runWithoutRetrievalCalls: 0, lastRunWithoutRetrievalInput: null };
    const runner = stubRunner({
      selectedChunks: [stubChunk("c1")],
      rationale: null,
      trace: emptyTrace(),
      terminatedReason: "completed",
      stepsTaken: 1,
    });
    const service = new AgenticRetrievalPipelineService({
      deterministic: stubDeterministic(detState),
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt: "sp",
    });

    const result = await service.run(
      buildRequest({
        responseBehavior: {
          suggestedQuestionsEnabled: false,
          suggestedQuestionsCount: 1,
          customInstruction: "override",
          citationDisplayEnabled: false,
        } as never,
      }),
    );

    expect(result.responseSettings.suggestedQuestionsEnabled).toBe(true);
    expect(result.responseSettings.suggestedQuestionsCount).toBe(3);
    expect(result.responseSettings.customInstruction).toBe("override");
    expect(result.responseSettings.citationDisplayEnabled).toBe(false);
  });
});
