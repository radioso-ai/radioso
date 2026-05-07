import { describe, expect, it } from "vitest";

import { CandidatePreparationStageService } from "../../src/modules/retrieval/services/candidatePreparationStage.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { MetadataRuleScoringService } from "../../src/modules/retrieval/services/metadataRuleScoringService.js";
import { selectRetrievalAnswerShape } from "../../src/modules/retrieval/services/retrievalShapeResolver.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import type { CandidateRetrievalStageResult } from "../../src/modules/retrieval/services/retrievalPipelineStages.js";
import type { RetrievedChunk } from "../../src/modules/retrieval/infra/vectorSearch.js";

const semanticChunk = (index: number, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  chunkId: `chunk-${index}`,
  documentId: `doc-${index}`,
  title: `Document ${index}`,
  content: `Document ${index} content`,
  searchText: `Document ${index} content`,
  similarity: 0.4 + index / 1000,
  chunkIndex: index,
  startOffset: 0,
  endOffset: 20,
  metadata: {},
  ...overrides,
});

const buildInput = (rewrittenContexts: RetrievedChunk[]): CandidateRetrievalStageResult => ({
  request: {
    workspaceId: "workspace-1",
    query: "when is the next family camp?",
    history: [],
  },
  settings: {
    workspaceId: "workspace-1",
    queryRewriteEnabled: true,
    semanticRewriteInstructions: "",
    lexicalRewriteInstructions: "",
    conversationMode: "guided",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    rerankEnabled: false,
    vectorTopK: 60,
    similarityThreshold: 0.14,
    rerankTopK: 15,
    citationDisplayEnabled: true,
    customInstruction: "",
    metadataRules: [
      {
        id: "future-date-boost",
        field: "dateFrom",
        valueType: "date",
        operator: "gt",
        value: "2026-01-01",
        effect: "boost",
        enabled: true,
        triggerMode: "always_on",
      },
    ],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  contextWindow: {
    selectedMessages: [],
    truncated: false,
    selectionReason: "no-history",
  },
  originalParsedQuery: {
    originalQuery: "when is the next family camp?",
    semanticQuery: "when is the next family camp?",
    lexicalQuery: "next family camp",
    constraints: [],
  },
  originalPreparedQuery: {
    originalQuery: "when is the next family camp?",
    semanticQuery: "when is the next family camp?",
    lexicalQuery: "next family camp",
    constraints: [],
  },
  rewrittenQuery: {
    originalQuery: "when is the next family camp?",
    rewrittenQuery: "when is the next family camp?",
    effectiveQuery: "when is the next family camp?",
    status: "applied",
    semanticQuery: "when is the next family camp?",
    lexicalQuery: "next family camp",
    responseIntent: "retrieval",
    responseLanguagePolicy: "match_user_question",
    retrievalSubqueries: [
      {
        id: "primary",
        label: "when is the next family camp?",
        semanticQuery: "when is the next family camp?",
        lexicalQuery: "next family camp",
        responseLanguagePolicy: "match_user_question",
      },
    ],
    rewriteApplied: true,
    retrievalEligible: true,
    confidence: 0.9,
  },
  responseIntent: "retrieval",
  activeQuery: "when is the next family camp?",
  activeParsedQuery: {
    originalQuery: "when is the next family camp?",
    semanticQuery: "when is the next family camp?",
    lexicalQuery: "next family camp",
    constraints: [],
  },
  activeSemanticQuery: "when is the next family camp?",
  activeRetrievalSubqueries: [
    {
      id: "primary",
      label: "when is the next family camp?",
      semanticQuery: "when is the next family camp?",
      lexicalQuery: "next family camp",
      responseLanguagePolicy: "match_user_question",
    },
  ],
  triggerAnalysis: {
    status: "skipped_not_configured",
    consideredRules: [],
    matchedRuleIds: [],
    unmatchedRuleIds: [],
    matchCount: 0,
    matcherVersion: "none",
  },
  promptHistory: [],
  continuityDecision: "unresolved",
  activeEmbedding: [0.1, 0.2],
  activeEmbeddingDurationMs: 10,
  originalContexts: [],
  rewrittenContexts,
  lexicalContexts: [],
  retrievalBranches: [],
  vectorFallbackApplied: false,
});

describe("candidate preparation stage", () => {
  it("applies metadata boosts before capping merged candidates", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );

    const candidateCount = RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap + 1;
    const rewrittenContexts = Array.from({ length: candidateCount }, (_, index) =>
      semanticChunk(index, {
        similarity: 0.9 - index / 1000,
      }),
    );

    const boostedCandidate = semanticChunk(candidateCount + 10, {
      chunkId: "future-family-camp",
      documentId: "future-family-camp-doc",
      title: "International Ananda Family Camp",
      content: "Family camp in July 2026",
      searchText: "Family camp in July 2026",
      similarity: 0.75,
      metadata: {
        dateFrom: "2026-07-05",
      },
    });

    rewrittenContexts[RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap] = boostedCandidate;

    const result = await stage.execute(buildInput(rewrittenContexts));

    expect(result.normalizedCandidates).toHaveLength(candidateCount);
    expect(result.scoredCandidates).toHaveLength(RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap);
    expect(result.scoredCandidates.some((candidate) => candidate.chunkId === "future-family-camp")).toBe(true);
    expect(result.mergedCandidates.some((candidate) => candidate.chunkId === "future-family-camp")).toBe(true);
    expect(result.appliedConstraints).toContainEqual({
      signalKey: "metadata.dateFrom",
      mode: "boost_only",
      outcome: "applied",
      summary: "dateFrom > 2026-01-01",
    });
  });

  it("applies lexical-preferred resolved shape clauses before capping candidates", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );
    const candidateCount = RETRIEVAL_BEHAVIOR.hybrid.mergedCandidateCap + 1;
    const rewrittenContexts = Array.from({ length: candidateCount }, (_, index) =>
      semanticChunk(index, {
        similarity: 0.99 - index / 1000,
      }),
    );
    const lexicalCandidate = semanticChunk(999, {
      chunkId: "lexical-definition",
      documentId: "lexical-definition-doc",
      title: "BM25",
      content: "BM25 definition content",
      searchText: "BM25 definition content",
      similarity: 0.2,
    });

    const result = await stage.execute({
      ...buildInput(rewrittenContexts),
      rewrittenQuery: {
        ...buildInput([]).rewrittenQuery,
        structuredResult: {
          rewrittenQuery: "BM25",
          queryShape: "definition_lookup",
          turnKind: "fresh_subject",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        },
      },
      shapeSelection: selectRetrievalAnswerShape({
        query: "BM25",
        rewrittenQuery: {
          ...buildInput([]).rewrittenQuery,
          structuredResult: {
            rewrittenQuery: "BM25",
            queryShape: "definition_lookup",
            turnKind: "fresh_subject",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.9,
          },
        },
      }),
      lexicalContexts: [lexicalCandidate],
    });

    expect(result.scoredCandidates[0]?.chunkId).toBe("lexical-definition");
    expect(result.scoredCandidates.some((candidate) => candidate.chunkId === "lexical-definition")).toBe(true);
  });

  it("enacts only matched trigger rules and records backoff for empty hard filters", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );

    const result = await stage.execute({
      ...buildInput([
        semanticChunk(1, {
          metadata: {
            language: "en",
            dateFrom: "2026-06-20",
          },
        }),
      ]),
      settings: {
        ...buildInput([]).settings,
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
          {
            id: "matched-events",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact when the user asks about upcoming events.",
          },
          {
            id: "unmatched-definitions",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "glossary",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for pure definitions.",
          },
        ],
      },
      triggerAnalysis: {
        status: "applied",
        consideredRules: [
          {
            ruleId: "matched-events",
            matched: true,
            matchStrength: 0.94,
            reason: "The question is clearly asking about upcoming events.",
            triggerInstructionPreview: "Enact when the user asks about upcoming events.",
          },
          {
            ruleId: "unmatched-definitions",
            matched: false,
            matchStrength: 0.03,
            reason: "The question is not definition-seeking.",
            triggerInstructionPreview: "Enact for pure definitions.",
          },
        ],
        matchedRuleIds: ["matched-events"],
        unmatchedRuleIds: ["unmatched-definitions"],
        matchCount: 1,
        matcherVersion: "test",
      },
    });

    expect(result.appliedConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signalKey: "metadata.language", mode: "boost_only" }),
        expect.objectContaining({ signalKey: "metadata.category", mode: "hard_filter" }),
      ]),
    );
    expect(result.appliedConstraints).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ summary: "category equals glossary" })]),
    );
    expect(result.triggerBackoff).toMatchObject({
      applied: true,
      reason: "empty_filtered_candidates",
      relaxedRuleIds: ["matched-events"],
    });
    expect(result.appliedConstraints).toContainEqual({
      signalKey: "metadata.category",
      mode: "hard_filter",
      outcome: "relaxed",
      summary: "category equals event",
    });
    expect(result.appliedConstraints).not.toContainEqual({
      signalKey: "metadata.category",
      mode: "hard_filter",
      outcome: "applied",
      summary: "category equals event",
    });
    expect(result.scoredCandidates).toHaveLength(1);
  });

  it("backs off trigger hard filters when they leave only weak support", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );

    const result = await stage.execute({
      ...buildInput([
        semanticChunk(1, {
          metadata: {
            category: "event",
            language: "en",
          },
        }),
        semanticChunk(2, {
          metadata: {
            category: "glossary",
            language: "en",
          },
        }),
        semanticChunk(3, {
          metadata: {
            category: "glossary",
            language: "en",
          },
        }),
        semanticChunk(4, {
          metadata: {
            category: "glossary",
            language: "en",
          },
        }),
      ]),
      settings: {
        ...buildInput([]).settings,
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
          {
            id: "matched-events",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact when the user asks about upcoming events.",
          },
        ],
      },
      triggerAnalysis: {
        status: "applied",
        consideredRules: [
          {
            ruleId: "matched-events",
            matched: true,
            matchStrength: 0.94,
            reason: "The question is clearly asking about upcoming events.",
            triggerInstructionPreview: "Enact when the user asks about upcoming events.",
          },
        ],
        matchedRuleIds: ["matched-events"],
        unmatchedRuleIds: [],
        matchCount: 1,
        matcherVersion: "test",
      },
    });

    expect(result.triggerBackoff).toMatchObject({
      applied: true,
      reason: "weak_filtered_support",
      relaxedRuleIds: ["matched-events"],
      restoredCandidateCount: 4,
    });
    expect(result.appliedConstraints).toContainEqual({
      signalKey: "metadata.category",
      mode: "hard_filter",
      outcome: "relaxed",
      summary: "category equals event",
    });
    expect(result.appliedConstraints).not.toContainEqual({
      signalKey: "metadata.category",
      mode: "hard_filter",
      outcome: "applied",
      summary: "category equals event",
    });
    expect(result.scoredCandidates).toHaveLength(4);
  });

  it("relaxes only the weakest trigger hard filters needed to restore support", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );

    const result = await stage.execute({
      ...buildInput([
        semanticChunk(1, {
          metadata: {
            category: "event",
            registrationStatus: "open",
            language: "en",
          },
        }),
        semanticChunk(2, {
          metadata: {
            category: "event",
            registrationStatus: "closed",
            language: "en",
          },
        }),
        semanticChunk(3, {
          metadata: {
            category: "event",
            registrationStatus: "closed",
            language: "en",
          },
        }),
        semanticChunk(4, {
          metadata: {
            category: "event",
            registrationStatus: "closed",
            language: "en",
          },
        }),
      ]),
      settings: {
        ...buildInput([]).settings,
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
          {
            id: "events-only",
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
            id: "open-registration-only",
            field: "registrationStatus",
            valueType: "string",
            operator: "equals",
            value: "open",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact for open registration windows.",
          },
        ],
      },
      triggerAnalysis: {
        status: "applied",
        consideredRules: [
          {
            ruleId: "events-only",
            matched: true,
            matchStrength: 0.97,
            reason: "The user is clearly asking about an event.",
            triggerInstructionPreview: "Enact for upcoming events.",
          },
          {
            ruleId: "open-registration-only",
            matched: true,
            matchStrength: 0.86,
            reason: "The query may also care about open registration.",
            triggerInstructionPreview: "Enact for open registration windows.",
          },
        ],
        matchedRuleIds: ["events-only", "open-registration-only"],
        unmatchedRuleIds: [],
        matchCount: 2,
        matcherVersion: "test",
      },
    });

    expect(result.triggerBackoff).toMatchObject({
      applied: true,
      reason: "weak_filtered_support",
      relaxedRuleIds: ["open-registration-only"],
      restoredCandidateCount: 4,
    });
    expect(result.appliedConstraints).toContainEqual({
      signalKey: "metadata.category",
      mode: "hard_filter",
      outcome: "applied",
      summary: "category equals event",
    });
    expect(result.appliedConstraints).toContainEqual({
      signalKey: "metadata.registrationStatus",
      mode: "hard_filter",
      outcome: "relaxed",
      summary: "registrationStatus equals open",
    });
    expect(result.appliedConstraints).not.toContainEqual({
      signalKey: "metadata.category",
      mode: "hard_filter",
      outcome: "relaxed",
      summary: "category equals event",
    });
    expect(result.scoredCandidates).toHaveLength(4);
  });

  it("does not relax trigger hard filters when an always-on filter is the bottleneck", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );

    const result = await stage.execute({
      ...buildInput([
        semanticChunk(1, {
          metadata: {
            category: "event",
            language: "en",
          },
        }),
        semanticChunk(2, {
          metadata: {
            category: "event",
            language: "et",
          },
        }),
        semanticChunk(3, {
          metadata: {
            category: "event",
            language: "lv",
          },
        }),
        semanticChunk(4, {
          metadata: {
            category: "event",
            language: "de",
          },
        }),
      ]),
      settings: {
        ...buildInput([]).settings,
        metadataRules: [
          {
            id: "always-on-language",
            field: "language",
            valueType: "string",
            operator: "equals",
            value: "en",
            effect: "filter",
            enabled: true,
            triggerMode: "always_on",
          },
          {
            id: "events-only",
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
      },
      triggerAnalysis: {
        status: "applied",
        consideredRules: [
          {
            ruleId: "events-only",
            matched: true,
            matchStrength: 0.97,
            reason: "The user is clearly asking about an event.",
            triggerInstructionPreview: "Enact for upcoming events.",
          },
        ],
        matchedRuleIds: ["events-only"],
        unmatchedRuleIds: [],
        matchCount: 1,
        matcherVersion: "test",
      },
    });

    expect(result.triggerBackoff).toEqual({
      applied: false,
      reason: undefined,
      relaxedRuleIds: [],
      restoredCandidateCount: undefined,
    });
    expect(result.appliedConstraints).toContainEqual({
      signalKey: "metadata.language",
      mode: "hard_filter",
      outcome: "applied",
      summary: "language equals en",
    });
    expect(result.appliedConstraints).toContainEqual({
      signalKey: "metadata.category",
      mode: "hard_filter",
      outcome: "applied",
      summary: "category equals event",
    });
    expect(result.appliedConstraints).not.toContainEqual({
      signalKey: "metadata.category",
      mode: "hard_filter",
      outcome: "relaxed",
      summary: "category equals event",
    });
    expect(result.scoredCandidates).toHaveLength(1);
  });
});
