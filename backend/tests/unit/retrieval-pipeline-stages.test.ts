import { describe, expect, it, vi } from "vitest";

import { QueryRewriteService } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { QueryInterpretationStageService } from "../../src/modules/retrieval/services/queryInterpretationStage.js";
import { CandidateRetrievalStageService } from "../../src/modules/retrieval/services/candidateRetrievalStage.js";
import { RetrievalContextStageService } from "../../src/modules/retrieval/services/retrievalContextStage.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { RetrievalDiagnosticsStageService } from "../../src/modules/retrieval/services/retrievalDiagnosticsStage.js";
import { RetrievalExecutionTelemetryService } from "../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { PromptAssemblyStageService } from "../../src/modules/retrieval/services/promptAssemblyStage.js";
import type { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { CandidatePreparationStageService } from "../../src/modules/retrieval/services/candidatePreparationStage.js";
import { MetadataRuleScoringService } from "../../src/modules/retrieval/services/metadataRuleScoringService.js";
import { ContextSelectionStageService } from "../../src/modules/retrieval/services/contextSelectionStage.js";
import { RerankService } from "../../src/modules/retrieval/services/rerankService.js";
import { PromptContextSelectorService } from "../../src/modules/retrieval/services/promptContextSelectorService.js";
import type { TemporalCandidateRetrievalPort } from "../../src/modules/retrieval/domain/temporal/temporalCandidateRetrieval.js";
import {
  buildCandidatePreparationTraceAttributes,
  buildCandidateRetrievalTraceAttributes,
  buildContextSelectionTraceAttributes,
  buildQueryInterpretationTraceAttributes,
  buildRetrievalPipelineTraceAttributes,
} from "../../src/modules/retrieval/services/retrievalPipelineStages.js";
import { hathaRajaYogaCandidates } from "../fixtures/retrievalSenseCorpus.js";

const embeddingSpace = { id: "space-active", dimensions: 3, distanceMetric: "cosine" as const };
const emptyChunkHydrator = { async hydrate() { return []; } };

const baseCandidateRetrievalInput = (documentScope?: string[]) => ({
  request: {
    workspaceId: "workspace-1",
    query: "tell me about yoga",
    history: [],
    ...(documentScope ? { documentScope } : {}),
  },
  settings: {
    workspaceId: "workspace-1",
        queryRewriteEnabled: false,
        temporalStructuredLookupEnabled: true,
        temporalBoostUpcomingEnabled: true,
        temporalDeterministicSortEnabled: true,
        semanticRewriteInstructions: "",
    lexicalRewriteInstructions: "",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    rerankEnabled: false,
    vectorTopK: 20,
    similarityThreshold: 0.2,
    rerankTopK: 5,
    customInstruction: "",
    metadataRules: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  contextWindow: { selectedMessages: [], truncated: false, selectionReason: "full-history" },
  originalParsedQuery: { semanticQuery: "yoga", lexicalQuery: "yoga", constraints: [] },
  originalPreparedQuery: { semanticQuery: "yoga", lexicalQuery: "yoga", constraints: [] },
  rewrittenQuery: {
    originalQuery: "tell me about yoga",
    rewrittenQuery: "tell me about yoga",
    effectiveQuery: "tell me about yoga",
    semanticQuery: "yoga",
    lexicalQuery: "yoga",
    responseIntent: "retrieval" as const,
    rewriteApplied: false,
    retrievalEligible: true,
    status: "skipped" as const,
    confidence: 1,
  },
  responseIntent: "retrieval" as const,
  activeQuery: "tell me about yoga",
  activeParsedQuery: { semanticQuery: "yoga", lexicalQuery: "yoga", constraints: [] },
  activeSemanticQuery: "yoga",
  activeRetrievalSubqueries: [
    {
      id: "primary",
      label: "primary",
      semanticQuery: "yoga",
      lexicalQuery: "yoga",
    },
  ],
  triggerAnalysis: {
    status: "skipped_not_configured" as const,
    consideredRules: [],
    matchedRuleIds: [],
    unmatchedRuleIds: [],
    matchCount: 0,
    matcherVersion: "none",
  },
  promptHistory: [],
  promptHistoryReset: false,
  continuityDecision: "unchanged" as const,
  activeEmbedding: [],
  activeEmbeddingDurationMs: 0,
  originalContexts: [],
  rewrittenContexts: hathaRajaYogaCandidates().slice(0, 4),
  lexicalContexts: [],
  retrievalBranches: [],
  vectorFallbackApplied: false,
});

describe("retrieval pipeline stages", () => {
  it("uses a precomputed rewrite proposal without calling the rewrite gateway", async () => {
    const gateway = {
      rewrite: vi.fn(async () => {
        throw new Error("rewrite gateway should not be called");
      }),
    };
    const stage = new QueryInterpretationStageService(new QueryRewriteService(gateway));

    const result = await stage.execute({
      request: {
        workspaceId: "workspace-1",
        query: "tell me about it",
        history: [],
        precomputedRewriteProposal: {
          rewrittenQuery: "known topic details",
          semanticQuery: "known topic details",
          lexicalQuery: "known topic",
          queryShape: "general_grounding",
          temporalQueryMode: "none",
          retrievalSubqueries: [
            {
              id: "",
              label: "known topic",
              semanticQuery: "known topic details",
              lexicalQuery: "known topic",
            },
          ],
          turnKind: "referential_followup",
          proposedActiveSubject: "known topic",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.91,
        },
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
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [
          {
            id: "m1",
            conversationId: "c1",
            workspaceId: "workspace-1",
            role: "user",
            content: "Tell me about known topic",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(gateway.rewrite).not.toHaveBeenCalled();
    expect(result.rewrittenQuery).toMatchObject({
      rewrittenQuery: "known topic details",
      semanticQuery: "known topic details",
      lexicalQuery: "known topic",
      status: "applied",
      retrievalEligible: true,
    });
  });

  it("assembles answer prompts with the detector response language from the request", () => {
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
    const stage = new PromptAssemblyStageService(promptBuilder);

    const result = stage.execute({
      request: {
        workspaceId: "workspace-1",
        query: "What is meditation?",
        history: [],
        responseIdentity: null,
        responseLanguage: "English",
        responseBehavior: { citationDisplayEnabled: true },
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
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      rewrittenQuery: {
        originalQuery: "What is meditation?",
        rewrittenQuery: "What is meditation?",
        effectiveQuery: "What is meditation?",
        semanticQuery: "What is meditation?",
        lexicalQuery: "What is meditation?",
        responseLanguagePolicy: "match_user_question",
        rewriteApplied: false,
        retrievalEligible: false,
        status: "skipped",
        confidence: 0,
        structuredResult: {
          rewrittenQuery: "What is meditation?",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.5,
          responseLanguage: "Italian",
        },
      },
      activeQuery: "What is meditation?",
      promptHistory: [],
      contexts: [],
    } as never);

    expect(calls[0]?.settings.responseLanguage).toBe("English");
    expect(calls[0]?.settings.responseLanguagePolicy).toBe("match_user_question");
    expect(result.responseSettings.responseLanguagePolicy).toBe("match_user_question");
  });

  it("applies documentScope at candidate preparation before rerank inputs are built", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );

    const result = await stage.execute(baseCandidateRetrievalInput(["doc-raja"]));

    expect(result.normalizedCandidates.map((candidate) => candidate.documentId)).toEqual(["doc-raja", "doc-raja"]);
    expect(result.mergedCandidates.map((candidate) => candidate.documentId)).toEqual(["doc-raja", "doc-raja"]);
    expect(result.scoredCandidates.map((candidate) => candidate.documentId)).toEqual(["doc-raja", "doc-raja"]);
  });

  it("requests temporal candidates for event listing rewrites when structured lookup is enabled", async () => {
    const temporalCalls: Parameters<TemporalCandidateRetrievalPort["findUpcoming"]>[0][] = [];
    const temporalCandidate = {
      chunkId: "future-retreat",
      documentId: "doc-future-retreat",
      title: "Future Retreat",
      content: "Future retreat happens tomorrow.",
      searchText: "Future Retreat Future retreat happens tomorrow.",
      similarity: 0.001,
      chunkIndex: 0,
      startOffset: 0,
      endOffset: 32,
      metadata: { dateFrom: "2026-07-03", dateTo: "2026-07-03" },
    };
    const stage = new CandidateRetrievalStageService(
      {
        async embedQueries() {
          return { space: embeddingSpace, vectors: [[0.1, 0.2]] };
        },
      },
      { async search() { return []; } },
      { async search() { return []; } },
      emptyChunkHydrator,
      {
        async findUpcoming(input) {
          temporalCalls.push(input);
          return [temporalCandidate];
        },
      },
      () => new Date("2026-07-02T12:00:00.000Z"),
    );

    const result = await stage.execute({
      ...baseCandidateRetrievalInput(),
      rewrittenQuery: {
        ...baseCandidateRetrievalInput().rewrittenQuery,
        structuredResult: {
          rewrittenQuery: "upcoming events",
          semanticQuery: "upcoming events",
          lexicalQuery: "events",
          queryShape: "event_date_lookup",
          temporalQueryMode: "listing",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        },
      },
    });

    expect(temporalCalls).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-1",
        today: "2026-07-02",
        metadataFilter: undefined,
        sourceFilter: undefined,
      }),
    ]);
    expect(result.temporalContexts).toEqual([temporalCandidate]);
    expect(buildCandidateRetrievalTraceAttributes(result)).toMatchObject({
      "retrieval.temporal.mode": "listing",
      "retrieval.temporal.structured_lookup.enabled": true,
      "retrieval.candidates.temporal.count": 1,
    });
  });

  it("does not request temporal candidates when structured lookup is disabled", async () => {
    let temporalCalls = 0;
    const stage = new CandidateRetrievalStageService(
      {
        async embedQueries() {
          return { space: embeddingSpace, vectors: [[0.1, 0.2]] };
        },
      },
      { async search() { return []; } },
      { async search() { return []; } },
      emptyChunkHydrator,
      {
        async findUpcoming() {
          temporalCalls += 1;
          return [];
        },
      },
    );

    const result = await stage.execute({
      ...baseCandidateRetrievalInput(),
      settings: {
        ...baseCandidateRetrievalInput().settings,
        temporalStructuredLookupEnabled: false,
      },
      rewrittenQuery: {
        ...baseCandidateRetrievalInput().rewrittenQuery,
        structuredResult: {
          rewrittenQuery: "upcoming events",
          queryShape: "event_date_lookup",
          temporalQueryMode: "listing",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        },
      },
    });

    expect(temporalCalls).toBe(0);
    expect(result.temporalContexts).toEqual([]);
    expect(buildCandidateRetrievalTraceAttributes(result)).toMatchObject({
      "retrieval.temporal.mode": "listing",
      "retrieval.temporal.structured_lookup.enabled": false,
      "retrieval.candidates.temporal.count": 0,
    });
  });

  it("keeps absent documentScope behavior identical", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );
    const input = baseCandidateRetrievalInput();

    const result = await stage.execute(input);

    expect(result.normalizedCandidates.map((candidate) => candidate.chunkId)).toEqual(
      hathaRajaYogaCandidates().slice(0, 4).map((candidate) => candidate.chunkId),
    );
    expect(result.mergedCandidates.map((candidate) => candidate.chunkId)).toEqual(
      hathaRajaYogaCandidates().slice(0, 4).map((candidate) => candidate.chunkId),
    );
  });

  it("builds privacy-safe bounded retrieval span attributes", () => {
    const request = {
      workspaceId: "workspace-1",
      query: "What is the admin password?",
      history: [
        {
          id: "message-1",
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          role: "user",
          content: "secret conversation text",
          createdAt: new Date(),
        },
      ],
      execution: {
        surface: "assistant",
        path: "assistant_retrieval",
        retrievalInvoked: true,
      },
      usageContext: {
        workspaceId: "workspace-1",
        requestId: "request-1",
        surface: "assistant",
        attemptKey: "attempt-1",
      },
    };
    const pipelineAttributes = buildRetrievalPipelineTraceAttributes(request);

    expect(pipelineAttributes).toMatchObject({
      "radioso.workspace_id": "workspace-1",
      "radioso.request_id": "request-1",
      "retrieval.execution.surface": "assistant",
      "retrieval.execution.path": "assistant_retrieval",
      "retrieval.history.count": 1,
    });
    expect(JSON.stringify(pipelineAttributes)).not.toContain("admin password");
    expect(JSON.stringify(pipelineAttributes)).not.toContain("secret conversation text");

    const interpretationResult = {
      request,
      rewrittenQuery: {
        status: "fallback",
        retrievalEligible: true,
        confidence: 0.62,
      },
      promptHistory: [{}, {}, {}],
      promptHistoryReset: false,
      triggerAnalysis: {
        status: "applied",
        consideredRules: new Array(1_500).fill({}),
        matchedRuleIds: new Array(1_500).fill("rule"),
        unmatchedRuleIds: [],
        matchCount: 1_500,
        matcherVersion: "test",
      },
    };
    expect(buildQueryInterpretationTraceAttributes(interpretationResult)).toMatchObject({
      "retrieval.rewrite.status": "fallback",
      "retrieval.query_history.count": 3,
      "retrieval.trigger.match_count": 1_000,
      "retrieval.trigger.considered_rule.count": 1_000,
    });

    const candidateRetrievalResult = {
      ...interpretationResult,
      originalContexts: new Array(1_500).fill({}),
      rewrittenContexts: [],
      lexicalContexts: [{}, {}],
      retrievalBranches: [{}, {}, {}],
      vectorFallbackApplied: false,
      activeRetrievalSubqueries: new Array(1_500).fill({}),
    };
    expect(buildCandidateRetrievalTraceAttributes(candidateRetrievalResult)).toMatchObject({
      "retrieval.candidates.semantic_original.count": 1_000,
      "retrieval.candidates.semantic_rewritten.count": 0,
      "retrieval.candidates.lexical.count": 2,
      "retrieval.branch.count": 3,
      "retrieval.subquery.count": 1_000,
    });

    const candidatePreparationResult = {
      ...candidateRetrievalResult,
      normalizedCandidates: new Array(4).fill({}),
      mergedCandidates: new Array(5).fill({}),
      scoredCandidates: new Array(6).fill({}),
      appliedConstraints: new Array(7).fill({}),
      candidateFallbackApplied: true,
    };
    expect(buildCandidatePreparationTraceAttributes(candidatePreparationResult)).toMatchObject({
      "retrieval.candidates.normalized.count": 4,
      "retrieval.candidates.merged.count": 5,
      "retrieval.candidates.scored.count": 6,
      "retrieval.constraint.count": 7,
      "retrieval.candidate_fallback.applied": true,
    });

    expect(buildContextSelectionTraceAttributes({
      ...candidatePreparationResult,
      rerankStatus: "skipped",
      rerankedContexts: new Array(2).fill({}),
      temporalDeterministicSortEnabled: true,
      temporalDeterministicSortApplied: true,
      temporalDeterministicSortDatedContextCount: 2,
      contexts: new Array(1).fill({}),
    })).toMatchObject({
      "retrieval.rerank.status": "skipped",
      "retrieval.candidates.reranked.count": 2,
      "retrieval.temporal.deterministic_sort.enabled": true,
      "retrieval.temporal.deterministic_sort.applied": true,
      "retrieval.temporal.deterministic_sort.dated_context.count": 2,
      "retrieval.context.final.count": 1,
    });
  });

  it("orders event date lookup contexts deterministically before prompt selection", async () => {
    const stage = new ContextSelectionStageService(
      new RerankService(undefined, undefined, () => new Date("2026-07-02T23:30:00.000Z")),
      new PromptContextSelectorService(10_000),
      () => new Date("2026-07-02T23:30:00.000Z"),
    );
    const scoredCandidates = [
      {
        chunkId: "undated-rank-1",
        documentId: "doc-undated",
        title: "Undated",
        content: "Undated event details.",
        similarity: 0.99,
        retrievalSources: ["semantic_original"],
        retrievalText: "Undated event details.",
        semanticScore: 0.99,
        lexicalScore: 0,
      },
      {
        chunkId: "august-rank-2",
        documentId: "doc-august",
        title: "August",
        content: "August event details.",
        similarity: 0.98,
        retrievalSources: ["semantic_original"],
        retrievalText: "August event details.",
        semanticScore: 0.98,
        lexicalScore: 0,
        metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
      },
      {
        chunkId: "july-rank-3",
        documentId: "doc-july",
        title: "July",
        content: "July event details.",
        similarity: 0.97,
        retrievalSources: ["semantic_original"],
        retrievalText: "July event details.",
        semanticScore: 0.97,
        lexicalScore: 0,
        metadata: { dateFrom: "2026-07-03", dateTo: "2026-07-03" },
      },
    ];

    const result = await stage.execute({
      ...baseCandidateRetrievalInput(),
      settings: {
        ...baseCandidateRetrievalInput().settings,
        rerankEnabled: false,
        temporalDeterministicSortEnabled: true,
      },
      rewrittenQuery: {
        ...baseCandidateRetrievalInput().rewrittenQuery,
        structuredResult: {
          rewrittenQuery: "events by actuality",
          queryShape: "event_date_lookup",
          temporalQueryMode: "listing",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        },
      },
      temporalQueryMode: "listing",
      scoredCandidates,
    } as never);

    expect(result.rerankedContexts.map((context) => context.chunkId)).toEqual([
      "undated-rank-1",
      "august-rank-2",
      "july-rank-3",
    ]);
    expect(result.contexts.map((context) => context.chunkId)).toEqual([
      "july-rank-3",
      "august-rank-2",
      "undated-rank-1",
    ]);
    expect(result).toMatchObject({
      temporalDeterministicSortEnabled: true,
      temporalDeterministicSortApplied: true,
      temporalDeterministicSortToday: "2026-07-02",
      temporalDeterministicSortDatedContextCount: 2,
    });

    const disabled = await stage.execute({
      ...baseCandidateRetrievalInput(),
      settings: {
        ...baseCandidateRetrievalInput().settings,
        rerankEnabled: false,
        temporalDeterministicSortEnabled: false,
      },
      rewrittenQuery: {
        ...baseCandidateRetrievalInput().rewrittenQuery,
        structuredResult: {
          rewrittenQuery: "events by actuality",
          queryShape: "event_date_lookup",
          temporalQueryMode: "listing",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        },
      },
      temporalQueryMode: "listing",
      scoredCandidates,
    } as never);

    expect(disabled.contexts.map((context) => context.chunkId)).toEqual([
      "undated-rank-1",
      "august-rank-2",
      "july-rank-3",
    ]);
    expect(disabled.temporalDeterministicSortApplied).toBe(false);
  });

  it("keeps structured query literals during query interpretation", async () => {
    const stage = new QueryInterpretationStageService(new QueryRewriteService());

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "Find retreats in Estonia under 300 EUR",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.activeParsedQuery.semanticQuery).toBe("Find retreats in Estonia under 300 EUR");
    expect(result.activeParsedQuery.lexicalQuery).toBe("Find retreats in Estonia under 300 EUR");
    expect(result.activeQuery).toBe("Find retreats in Estonia under 300 EUR");
    expect(result.promptHistory).toEqual([]);
    expect(result.triggerAnalysis).toMatchObject({
      status: "skipped_not_configured",
      matchedRuleIds: [],
      matchCount: 0,
    });
  });

  it("propagates non-retrieval response intent and skips trigger analysis", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "Thanks again",
            semanticQuery: "Thanks again",
            lexicalQuery: "Thanks again",
            turnKind: "ambiguous",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.94,
          };
        },
      }, {
        async analyze() {
          return {
            status: "applied" as const,
            consideredRules: [],
            matchedRuleIds: [],
            unmatchedRuleIds: [],
            matchCount: 0,
            matcherVersion: "should-not-run",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "Thanks again",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-only",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact when the user is asking about upcoming events.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.triggerAnalysis).toMatchObject({
      status: "applied",
      matcherVersion: "should-not-run",
      matchCount: 0,
    });
  });

  it("keeps intent routing active when query rewriting is disabled", async () => {
    let rewriteCalls = 0;
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          rewriteCalls += 1;
          return {
            rewrittenQuery: "Thanks",
            semanticQuery: "Thanks",
            lexicalQuery: "Thanks",
            turnKind: "ambiguous",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.94,
          };
        },
      }, {
        async analyze() {
          throw new Error("trigger analysis should not run for social-only turns");
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "Thanks",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-only",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact when the user is asking about upcoming events.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(rewriteCalls).toBe(0);
    expect(result.rewrittenQuery).toMatchObject({
      status: "skipped",
      rewriteApplied: false,
      retrievalEligible: false,
    });
    expect(result.activeQuery).toBe("Thanks");
    expect(result.triggerAnalysis).toMatchObject({
      status: "fallback",
      matcherVersion: "fallback",
      matchCount: 0,
    });
  });

  it("skips trigger matching when no triggerable rules are configured", async () => {
    let triggerCalls = 0;
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(undefined, {
        async analyze() {
          triggerCalls += 1;
          return {
            status: "applied",
            consideredRules: [],
            matchedRuleIds: [],
            unmatchedRuleIds: [],
            matchCount: 0,
            matcherVersion: "test",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "What is mononuclear disease?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [
          {
            id: "always-on-language",
            field: "language",
            valueType: "string",
            operator: "equals",
            value: "en",
            effect: "boost",
            enabled: true,
            triggerMode: "always_on",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(triggerCalls).toBe(0);
    expect(result.triggerAnalysis).toMatchObject({
      status: "skipped_not_configured",
      matchedRuleIds: [],
      unmatchedRuleIds: [],
      matchCount: 0,
    });
  });

  it("records matched triggerable rules during query interpretation", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(undefined, {
        async analyze() {
          return {
            status: "applied",
            consideredRules: [
              {
                ruleId: "events-filter",
                matched: true,
                matchStrength: 0.93,
                reason: "The user is asking for an upcoming event.",
                triggerInstructionPreview: "Enact for upcoming events.",
              },
              {
                ruleId: "definitions-filter",
                matched: false,
                matchStrength: 0.08,
                reason: "The user is not asking for a definition-only answer.",
                triggerInstructionPreview: "Enact for pure definitions.",
              },
            ],
            matchedRuleIds: ["events-filter"],
            unmatchedRuleIds: ["definitions-filter"],
            matchCount: 1,
            matcherVersion: "test",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "When is the next conference?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-filter",
            field: "dateFrom",
            valueType: "date",
            operator: "gte",
            value: "today()",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for upcoming events.",
          },
          {
            id: "definitions-filter",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "glossary",
            effect: "boost",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for pure definitions.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.triggerAnalysis).toMatchObject({
      status: "applied",
      matchedRuleIds: ["events-filter"],
      unmatchedRuleIds: ["definitions-filter"],
      matchCount: 1,
      matcherVersion: "test",
    });
  });

  it("suppresses low-confidence trigger matches from enactment", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(undefined, {
        async analyze() {
          return {
            status: "applied",
            consideredRules: [
              {
                ruleId: "events-filter",
                matched: true,
                matchStrength: 0.42,
                reason: "The query loosely overlaps with upcoming events.",
                triggerInstructionPreview: "Enact for upcoming events.",
              },
            ],
            matchedRuleIds: ["events-filter"],
            unmatchedRuleIds: [],
            matchCount: 1,
            matcherVersion: "test",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "Tell me something interesting happening soon.",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-filter",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for upcoming events.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.triggerAnalysis.matchedRuleIds).toEqual([]);
    expect(result.triggerAnalysis.unmatchedRuleIds).toEqual(["events-filter"]);
    expect(result.triggerAnalysis.matchCount).toBe(0);
    expect(result.triggerAnalysis.consideredRules[0]).toMatchObject({
      ruleId: "events-filter",
      matched: false,
      matchStrength: 0.42,
    });
    expect(result.triggerAnalysis.consideredRules[0]?.reason).toContain("below the enactment threshold");
  });

  it("supports multiple trigger rules crossing the enactment threshold", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(undefined, {
        async analyze() {
          return {
            status: "applied",
            consideredRules: [
              {
                ruleId: "events-filter",
                matched: true,
                matchStrength: 0.94,
                reason: "The user is asking about an upcoming event.",
                triggerInstructionPreview: "Enact for upcoming events.",
              },
              {
                ruleId: "active-registration-filter",
                matched: true,
                matchStrength: 0.88,
                reason: "The question is also about currently open registration windows.",
                triggerInstructionPreview: "Enact for active registrations.",
              },
            ],
            matchedRuleIds: ["events-filter", "active-registration-filter"],
            unmatchedRuleIds: [],
            matchCount: 2,
            matcherVersion: "test",
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "Which upcoming camps still have open registration?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-filter",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for upcoming events.",
          },
          {
            id: "active-registration-filter",
            field: "registrationStatus",
            valueType: "string",
            operator: "equals",
            value: "open",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for active registrations.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.triggerAnalysis.matchedRuleIds).toEqual(["events-filter", "active-registration-filter"]);
    expect(result.triggerAnalysis.matchCount).toBe(2);
  });

  it("calls trigger analysis with the active query and no raw history context", async () => {
    let triggerAnalysisInput:
      | {
          query: string;
          activeQuery: string;
          contextMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
        }
      | undefined;

    const stage = new QueryInterpretationStageService(
      new QueryRewriteService(
        {
          async rewrite({ contextMessages }) {
            expect(contextMessages).toHaveLength(2);
            return {
              rewrittenQuery: "When is the conference in Riga?",
              semanticQuery: "When is the conference in Riga?",
              lexicalQuery: "conference Riga date",
              turnKind: "referential_followup",
              proposedActiveSubject: "conference in Riga",
              relatedEntities: ["conference"],
              unresolved: false,
              confidence: 0.93,
            };
          },
        },
        {
	          async analyze({ query, activeQuery, contextMessages }) {
	            const normalizedContextMessages: Array<{ role: "user" | "assistant"; content: string }> = contextMessages
	              .filter((message) => message.role === "user" || message.role === "assistant")
	              .map((message) => ({
	                role: message.role as "user" | "assistant",
	                content: message.content,
	              }));

	            triggerAnalysisInput = {
	              query,
	              activeQuery,
	              contextMessages: normalizedContextMessages,
	            };

            return {
              status: "applied",
              consideredRules: [
                {
                  ruleId: "events-filter",
                  matched: true,
                  matchStrength: 0.94,
                  reason: "The resolved follow-up is still asking about the conference schedule.",
                  triggerInstructionPreview: "Enact for upcoming events.",
                },
              ],
              matchedRuleIds: ["events-filter"],
              unmatchedRuleIds: [],
              matchCount: 1,
              matcherVersion: "test",
            };
          },
        },
      ),
    );

    const history = [
      {
        id: "u1",
        conversationId: "c1",
        workspaceId: "a1",
        role: "user" as const,
        content: "Tell me about the conference in Riga.",
        createdAt: new Date(),
      },
      {
        id: "a1",
        conversationId: "c1",
        workspaceId: "a1",
        role: "assistant" as const,
        content: "The conference in Riga is our annual event.",
        createdAt: new Date(),
      },
    ];

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "When is it?",
        history,
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [
          {
            id: "events-filter",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for upcoming events.",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: history,
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.activeQuery).toBe("When is the conference in Riga?");
    expect(triggerAnalysisInput).toEqual({
      query: "When is it?",
      activeQuery: "When is the conference in Riga?",
      contextMessages: [],
    });
    expect(result.triggerAnalysis.matchedRuleIds).toEqual(["events-filter"]);
  });

  it("keeps prompt history even when rewrite marks a fresh subject", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "Eestis hetkel kehtiv kaibemaksumaar (kaibemaks)",
            semanticQuery: "Eestis hetkel kehtiv kaibemaksumaar",
            lexicalQuery: "Eestis kehtiv km maar (kaibemaks)",
            turnKind: "fresh_subject",
            proposedActiveSubject: "kaibemaksumaar Eestis",
            relatedEntities: ["tulumaks"],
            unresolved: false,
            confidence: 0.74,
          };
        },
      }),
    );

    const history = [
      {
        id: "u1",
        conversationId: "c1",
        workspaceId: "a1",
        role: "user" as const,
        content: "Mis juhtub, kui ma ei maksa tulumaksu?",
        createdAt: new Date(),
      },
      {
        id: "a1",
        conversationId: "c1",
        workspaceId: "a1",
        role: "assistant" as const,
        content: "Tulumaksu vastus",
        createdAt: new Date(),
      },
    ];

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "mis on hetkel kehtiv kaibemaks?",
        history,
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: history,
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.activeQuery).toBe("Eestis hetkel kehtiv kaibemaksumaar");
    expect(result.activeQuery).toBe("Eestis hetkel kehtiv kaibemaksumaar");
    expect(result.activeParsedQuery.semanticQuery).toBe("Eestis hetkel kehtiv kaibemaksumaar");
    expect(result.activeParsedQuery.lexicalQuery).toBe("Eestis kehtiv km maar (kaibemaks)");
    expect(result.promptHistory).toEqual(history);
    expect(result.promptHistoryReset).toBe(false);
  });

  it("uses distinct semantic and lexical rewritten queries when both are provided", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "tulumaksuseadus 2015 paragraaf 4",
            semanticQuery: "tulumaksuseadus 2015 paragraaf 4",
            lexicalQuery: "tulumaksuseadus 2015 § 4",
            turnKind: "referential_followup",
            proposedActiveSubject: "tulumaksuseadus 2015",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.91,
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "tulumaksuseadus 2015 paragraaf 4",
        history: [       
          {
            id: "u1",
            conversationId: "c1",
            workspaceId: "a1",
            role: "user" as const,
            content: "räägi tulumaksuseadusest",
            createdAt: new Date(),
          },
        ],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer section symbols and citation notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [
          {
            id: "u1",
            conversationId: "c1",
            workspaceId: "a1",
            role: "user" as const,
            content: "räägi tulumaksuseadusest",
            createdAt: new Date(),
          },
        ],
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.activeQuery).toBe("tulumaksuseadus 2015 paragraaf 4");
    expect(result.activeSemanticQuery).toBe("tulumaksuseadus 2015 paragraaf 4");
    expect(result.activeParsedQuery.lexicalQuery).toBe("tulumaksuseadus 2015 § 4");
  });

  it("applies focused lexical rewrites for standalone searches without prior history", async () => {
    const stage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "tulumaksuseadus paragrahv 4 osa 5",
            semanticQuery: "tulumaksuseadus paragrahv 4 osa 5",
            lexicalQuery: "tulumaksuseadus § 4 lg 5",
            turnKind: "fresh_subject",
            proposedActiveSubject: "tulumaksuseadus",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.88,
          };
        },
      }),
    );

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "tulumaksuseadus paragrahv 4 osa 5",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer section symbols and legal citation notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
    });

    expect(result.rewrittenQuery.status).toBe("applied");
    expect(result.activeSemanticQuery).toBe("tulumaksuseadus paragrahv 4 osa 5");
    expect(result.activeParsedQuery.lexicalQuery).toBe("tulumaksuseadus § 4 lg 5");
    expect(result.promptHistory).toEqual([]);
  });

  it("keeps prompt history smaller than the rewrite context window", async () => {
    const stage = new QueryInterpretationStageService(new QueryRewriteService());
    const history = Array.from({ length: 10 }, (_, index) => ({
      id: `m${index + 1}`,
      conversationId: "c1",
      workspaceId: "a1",
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn-${index + 1}`,
      createdAt: new Date(),
    }));

    const result = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "tell me more",
        history,
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: history,
        truncated: false,
        selectionReason: "full-history",
      },
    });

    expect(result.promptHistory.map((message) => message.content)).toEqual(["turn-7", "turn-8", "turn-9", "turn-10"]);
  });

  it("keeps decomposed retrieval branches for history-free comparative turns", async () => {
    const interpretationStage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "who is narayani and arudra",
            semanticQuery: "who is narayani and arudra",
            lexicalQuery: "who is narayani and arudra",
            retrievalSubqueries: [
              {
                id: "",
                label: "Narayani",
                semanticQuery: "who is narayani",
                lexicalQuery: "narayani",
              },
              {
                id: "",
                label: "Arudra",
                semanticQuery: "who is arudra",
                lexicalQuery: "arudra",
              },
            ],
            turnKind: "comparative",
            proposedActiveSubject: "Narayani",
            relatedEntities: ["Arudra"],
            unresolved: false,
            confidence: 0.92,
          };
        },
      }),
    );

    const interpreted = await interpretationStage.execute({
      request: {
        workspaceId: "a1",
        query: "who is narayani and arudra?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
        lexicalRewriteInstructions: "Prefer exact literals and names.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "no-history",
      },
    });

    expect(interpreted.activeRetrievalSubqueries).toHaveLength(2);
    expect(interpreted.activeRetrievalSubqueries.map((subquery) => subquery.label)).toEqual(["Narayani", "Arudra"]);

    const vectorQueries: string[] = [];
    const lexicalQueries: string[] = [];
    const retrievalStage = new CandidateRetrievalStageService(
      {
        async embedQueries(input) {
          return {
            space: embeddingSpace,
            vectors: input.texts.map((_: string, index: number) => [index + 1]),
          };
        },
      },
      {
        async search(input) {
          vectorQueries.push(String(input.queryVector[0]));
          return [
            {
              chunkId: `semantic-${input.queryVector[0]}`,
              documentId: `doc-semantic-${input.queryVector[0]}`,
              embeddingSpaceId: input.space.id,
              version: "1",
              score: 0.9,
            },
          ];
        },
      },
      {
        async search(input) {
          lexicalQueries.push(input.query);
          return [
            {
              chunkId: `lexical-${input.query}`,
              documentId: `doc-lexical-${input.query}`,
              title: input.query,
              content: "profile",
              similarity: 0.8,
            },
          ];
        },
      },
      {
        async hydrate(input) {
          return input.candidates.map((candidate) => ({
            chunkId: candidate.chunkId,
            documentId: candidate.documentId ?? `doc-${candidate.chunkId}`,
            title: candidate.chunkId,
            content: "profile",
            similarity: candidate.score,
          }));
        },
      },
    );

    const retrieved = await retrievalStage.execute(interpreted);

    expect(vectorQueries).toEqual(["1", "2"]);
    expect(lexicalQueries).toEqual(["narayani", "arudra"]);
    expect(retrieved.retrievalBranches).toHaveLength(2);
    expect(retrieved.retrievalBranches.map((branch) => branch.label)).toEqual(["Narayani", "Arudra"]);
    expect(retrieved.originalContexts).toHaveLength(0);
    expect(retrieved.rewrittenContexts).toHaveLength(2);
    expect(retrieved.lexicalContexts).toHaveLength(2);
  });

  it("splits vector results between original and rewritten contexts", async () => {
    const contextStage = new RetrievalContextStageService(
      {
        getDefaults() {
          return {
            workspaceId: "a1",
            queryRewriteEnabled: true,
            semanticRewriteInstructions: "Keep semantic retrieval meaning-preserving.",
            lexicalRewriteInstructions: "Prefer exact notation.",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 3,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.2,
            rerankTopK: 5,
            customInstruction: "",
            metadataRules: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      new ConversationContextService(),
    );
    const interpretationStage = new QueryInterpretationStageService(
      new QueryRewriteService({
        async rewrite() {
          return {
            rewrittenQuery: "summer retreat pricing",
            semanticQuery: "summer retreat pricing",
            lexicalQuery: "summer retreat price",
            turnKind: "referential_followup",
            proposedActiveSubject: "summer retreat",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.9,
          };
        },
      }),
    );
    const retrievalStage = new CandidateRetrievalStageService(
      {
        async embedQueries() {
          return { space: embeddingSpace, vectors: [[1, 0, 0]] };
        },
      },
      {
        async search(input) {
          return [
            {
              chunkId: "c1",
              documentId: "d1",
              embeddingSpaceId: input.space.id,
              version: "1",
              score: 0.6,
            },
          ];
        },
      },
      {
        async search() {
          return [];
        },
      },
      {
        async hydrate(input) {
          return input.candidates.map((candidate) => ({
            chunkId: candidate.chunkId,
            documentId: candidate.documentId ?? `doc-${candidate.chunkId}`,
            title: "Summer Retreat",
            content: "Summer retreat in Estonia costs 290 EUR.",
            similarity: candidate.score,
          }));
        },
      },
    );

    const context = await contextStage.execute({
      workspaceId: "a1",
      query: "Is it under 300 EUR?",
      history: [
        {
          id: "1",
          conversationId: "c1",
          workspaceId: "a1",
          role: "user",
          content: "Tell me about the summer retreat",
          createdAt: new Date(),
        },
      ],
    });
    const interpretation = await interpretationStage.execute(context);
    const result = await retrievalStage.execute(interpretation);

    expect(result.originalContexts).toEqual([]);
    expect(result.rewrittenContexts).toHaveLength(1);
    expect(result.lexicalContexts).toEqual([]);
    expect(result.activeQuery).toBe("summer retreat pricing");
    expect(result.activeParsedQuery.lexicalQuery).toBe("summer retreat price");
  });

  it("reports rejected rewrites as having run in diagnostics", async () => {
    const stage = new RetrievalDiagnosticsStageService(new RetrievalExecutionTelemetryService());

    const diagnostics = await stage.execute({
      request: {
        workspaceId: "a1",
        query: "what about her later work?",
        history: [],
      },
      settings: {
        workspaceId: "a1",
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "Keep meaning.",
        lexicalRewriteInstructions: "Prefer exact notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        customInstruction: "",
        metadataRules: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contextWindow: {
        selectedMessages: [],
        truncated: false,
        selectionReason: "full-history",
      },
      originalParsedQuery: {
        originalQuery: "what about her later work?",
        semanticQuery: "what about her later work?",
        lexicalQuery: "what about her later work?",
        constraints: [],
      },
      originalPreparedQuery: {
        originalQuery: "what about her later work?",
        semanticQuery: "what about her later work?",
        lexicalQuery: "what about her later work?",
        constraints: [],
      },
      rewrittenQuery: {
        originalQuery: "what about her later work?",
        rewrittenQuery: "What did Arudra publish later?",
        effectiveQuery: "what about her later work?",
        semanticQuery: "what about her later work?",
        lexicalQuery: "what about her later work?",
        rewriteApplied: false,
        retrievalEligible: false,
        status: "rejected",
        confidence: 0.9,
        rejectionReason: "rewrite_not_materially_different",
      },
      activeQuery: "what about her later work?",
      activeParsedQuery: {
        originalQuery: "what about her later work?",
        semanticQuery: "what about her later work?",
        lexicalQuery: "what about her later work?",
        constraints: [],
      },
      activeSemanticQuery: "what about her later work?",
      activeRetrievalSubqueries: [
        {
          id: "primary",
          label: "what about her later work?",
          semanticQuery: "what about her later work?",
          lexicalQuery: "what about her later work?",
        },
      ],
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
      continuityDecision: "rejected",
      activeEmbedding: [1, 0, 0],
      activeEmbeddingDurationMs: 0,
      originalContexts: [],
      rewrittenContexts: [],
      lexicalContexts: [],
      retrievalBranches: [],
      vectorFallbackApplied: false,
      normalizedCandidates: [],
      mergedCandidates: [],
      scoredCandidates: [],
      appliedConstraints: [],
      candidateFallbackApplied: false,
      triggerBackoff: {
        applied: false,
        relaxedRuleIds: [],
      },
      rerankedContexts: [],
      rerankStatus: "skipped",
      contexts: [],
      systemPrompt: "system prompt",
      prompt: "prompt",
      citations: [],
      responseSettings: {
        citationDisplayEnabled: true,
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
      },
    });

    expect(diagnostics.rewriteStatus).toBe("rejected");
    expect(diagnostics.rewriteRan).toBe(true);
  });
});
