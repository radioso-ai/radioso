import { describe, expect, it } from "vitest";

import { CandidatePreparationStageService } from "../../src/modules/retrieval/services/candidatePreparationStage.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { MetadataRuleScoringService } from "../../src/modules/retrieval/services/metadataRuleScoringService.js";
import { selectRetrievalAnswerShape } from "../../src/modules/retrieval/services/retrievalShapeResolver.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import type { CandidateRetrievalStageResult } from "../../src/modules/retrieval/services/retrievalPipelineStages.js";
import type { RetrievedChunk } from "../../src/modules/retrieval/public.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { answerCandidatePoolSize } from "../../src/modules/retrieval/domain/answerCandidatePool.js";

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
    temporalStructuredLookupEnabled: true,
    temporalBoostUpcomingEnabled: true,
    temporalDeterministicSortEnabled: true,
    semanticRewriteInstructions: "",
    lexicalRewriteInstructions: "",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
    rerankEnabled: false,
    vectorTopK: 60,
    similarityThreshold: 0.14,
    rerankTopK: 15,
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
  },
  originalPreparedQuery: {
    originalQuery: "when is the next family camp?",
    semanticQuery: "when is the next family camp?",
    lexicalQuery: "next family camp",
  },
  rewrittenQuery: {
    originalQuery: "when is the next family camp?",
    rewrittenQuery: "when is the next family camp?",
    effectiveQuery: "when is the next family camp?",
    status: "applied",
    semanticQuery: "when is the next family camp?",
    lexicalQuery: "next family camp",
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
  activeQuery: "when is the next family camp?",
  activeParsedQuery: {
    originalQuery: "when is the next family camp?",
    semanticQuery: "when is the next family camp?",
    lexicalQuery: "next family camp",
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
  promptHistoryReset: false,
  continuityDecision: "unresolved",
  activeEmbedding: [0.1, 0.2],
  activeEmbeddingDurationMs: 10,
  originalContexts: [],
  rewrittenContexts,
  lexicalContexts: [],
  temporalContexts: [],
  temporalQueryMode: "none",
  temporalStructuredLookupEnabled: true,
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

  it("applies built-in upcoming event boost only for temporal event lookups when enabled", async () => {
    // Fixed clock: the fixture event date must stay "upcoming" regardless of
    // when the suite runs.
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
      () => new Date("2026-07-01T12:00:00.000Z"),
    );
    const datedCandidate = semanticChunk(1, {
      chunkId: "future-event",
      similarity: 0.4,
      metadata: { dateFrom: "2026-07-03" },
    });

    const boosted = await stage.execute({
      ...buildInput([datedCandidate]),
      settings: {
        ...buildInput([]).settings,
        metadataRules: [],
        temporalBoostUpcomingEnabled: true,
      },
      rewrittenQuery: {
        ...buildInput([]).rewrittenQuery,
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
      temporalQueryMode: "listing",
    });

    const unboosted = await stage.execute({
      ...buildInput([datedCandidate]),
      settings: {
        ...buildInput([]).settings,
        metadataRules: [],
        temporalBoostUpcomingEnabled: false,
      },
      rewrittenQuery: boosted.rewrittenQuery,
      temporalQueryMode: "listing",
    });

    expect(boosted.scoredCandidates[0]?.attributeMatchScore).toBeGreaterThan(0);
    expect(boosted.scoredCandidates[0]?.similarity).toBeGreaterThan(unboosted.scoredCandidates[0]?.similarity ?? 0);
    expect(boosted.scoredCandidates[0]?.similarity).toBeLessThanOrEqual(1);
    expect(boosted.scoredCandidates[0]?.fusedScore).toBe(boosted.scoredCandidates[0]?.similarity);
    expect(unboosted.scoredCandidates[0]?.attributeMatchScore).toBe(0);
  });

  it("boosts the events in a requested range instead of every upcoming event, whatever the temporal mode", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
      () => new Date("2026-10-21T12:00:00.000Z"),
    );
    const inRange = semanticChunk(1, {
      chunkId: "december-retreat",
      similarity: 0.4,
      metadata: { dateFrom: "2026-12-08", dateTo: "2026-12-10" },
    });
    const soonerUpcoming = semanticChunk(2, {
      chunkId: "november-class",
      similarity: 0.4,
      metadata: { dateFrom: "2026-11-04", dateTo: "2026-11-04" },
    });

    const result = await stage.execute({
      ...buildInput([inRange, soonerUpcoming]),
      settings: {
        ...buildInput([]).settings,
        metadataRules: [],
        temporalBoostUpcomingEnabled: true,
      },
      temporalQueryMode: "none",
      temporalDateRange: { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
    });

    const scoreOf = (chunkId: string) =>
      result.scoredCandidates.find((candidate) => candidate.chunkId === chunkId)?.attributeMatchScore;
    expect(scoreOf("december-retreat")).toBeGreaterThan(0);
    expect(scoreOf("november-class")).toBe(0);
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

  it("does not treat an all-junk lexical pool as useful hard-filter backoff support", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );
    const lexicalContexts = Array.from({ length: 4 }, (_, index) =>
      semanticChunk(index, {
        similarity: 1 - index / 10,
        lexicalRankScore: 0.001 - index / 10_000,
        metadata: { category: index === 0 ? "event" : "article" },
      }),
    );

    const result = await stage.execute({
      ...buildInput([]),
      lexicalContexts,
      settings: {
        ...buildInput([]).settings,
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
            triggerInstruction: "Enact for event requests.",
          },
        ],
      },
      triggerAnalysis: {
        status: "applied",
        consideredRules: [
          {
            ruleId: "events-only",
            matched: true,
            matchStrength: 0.95,
            reason: "The question asks about events.",
            triggerInstructionPreview: "Enact for event requests.",
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
    expect(result.scoredCandidates).toHaveLength(1);
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

  it("does not boost a candidate whose date is not a calendar date", async () => {
    const stage = new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
      () => new Date("2026-10-21T12:00:00.000Z"),
    );

    const result = await stage.execute({
      ...buildInput([semanticChunk(1, { chunkId: "bad-date", metadata: { dateFrom: "2026-13-40" } })]),
      settings: { ...buildInput([]).settings, metadataRules: [] },
      temporalQueryMode: "listing",
    });

    expect(result.scoredCandidates[0]?.attributeMatchScore).toBe(0);
  });

  describe("temporal candidates", () => {
    const italianOnlyRule = {
      id: "italian-only",
      field: "language",
      valueType: "string" as const,
      operator: "equals" as const,
      value: "it",
      effect: "filter" as const,
      enabled: true,
      triggerMode: "match_turn" as const,
      triggerInstruction: "Enact when the visitor writes in Italian.",
    };
    const italianTurn = (input: ReturnType<typeof buildInput>): ReturnType<typeof buildInput> => ({
      ...input,
      settings: { ...input.settings, metadataRules: [italianOnlyRule] },
      triggerAnalysis: {
        status: "applied",
        consideredRules: [{
          ruleId: "italian-only",
          matched: true,
          matchStrength: 0.95,
          reason: "The visitor writes in Italian.",
          triggerInstructionPreview: "Enact when the visitor writes in Italian.",
        }],
        matchedRuleIds: ["italian-only"],
        unmatchedRuleIds: [],
        matchCount: 1,
        matcherVersion: "test",
      },
    });
    const dated = (id: string, language: string): RetrievedChunk =>
      semanticChunk(0, {
        chunkId: id,
        documentId: `doc-${id}`,
        metadata: { dateFrom: "2026-12-09", dateTo: "2026-12-09", language },
      });
    const stage = () => new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
      () => new Date("2026-10-21T12:00:00.000Z"),
    );

    it("keeps a requested range's candidates apart from the ranked list, through the turn's filter rules", async () => {
      const italianSemantic = [1, 2, 3, 4].map((index) =>
        semanticChunk(index, { metadata: { language: "it" }, similarity: 0.8 }));

      const result = await stage().execute({
        ...italianTurn(buildInput(italianSemantic)),
        temporalQueryMode: "topic_refinement",
        temporalDateRange: { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
        temporalLookupRanking: "similarity",
        temporalContexts: [dated("range-en", "en"), dated("range-it", "it")],
      });

      expect(result.rangeCandidates?.map((candidate) => candidate.chunkId)).toEqual(["range-it"]);
      expect(result.scoredCandidates.map((candidate) => candidate.chunkId)).not.toContain("range-it");
    });

    it("keeps temporal candidates inside the request's document scope", async () => {
      const base = buildInput([semanticChunk(1), semanticChunk(2)]);
      const scoped = { ...base, request: { ...base.request, documentScope: ["doc-1", "doc-range-in-scope"] } };

      const range = await stage().execute({
        ...scoped,
        temporalQueryMode: "none",
        temporalDateRange: { dateFrom: "2026-12-07", dateTo: "2026-12-13" },
        temporalLookupRanking: "date",
        temporalContexts: [dated("range-in-scope", "it"), dated("range-out-of-scope", "it")],
      });
      const upcoming = await stage().execute({
        ...scoped,
        temporalQueryMode: "listing",
        temporalContexts: [dated("range-in-scope", "it"), dated("range-out-of-scope", "it")],
      });

      expect(range.rangeCandidates?.map((candidate) => candidate.chunkId)).toEqual(["range-in-scope"]);
      expect(upcoming.scoredCandidates.map((candidate) => candidate.chunkId)).not.toContain("range-out-of-scope");
      expect(upcoming.scoredCandidates.map((candidate) => candidate.chunkId)).toContain("range-in-scope");
    });
  });
  // #1576: a lexical hit holding only part of the query corroborates other evidence.
  describe("some-terms lexical matches", () => {
    const stage = () => new CandidatePreparationStageService(
      new CandidatePreparationService(),
      new MetadataRuleScoringService(),
    );
    const someTermsChunk = (id: string): RetrievedChunk => semanticChunk(0, {
      chunkId: id,
      documentId: `doc-${id}`,
      similarity: 0.8,
      lexicalRankScore: 0.6,
      lexicalTermCoverage: "some_terms",
    });
    const definitionLookup = (input: CandidateRetrievalStageResult): CandidateRetrievalStageResult => {
      const rewrittenQuery = {
        ...input.rewrittenQuery,
        structuredResult: {
          rewrittenQuery: "BM25",
          queryShape: "definition_lookup" as const,
          turnKind: "fresh_subject" as const,
          relatedEntities: [],
          unresolved: false,
          confidence: 0.9,
        },
      };
      return {
        ...input,
        rewrittenQuery,
        shapeSelection: selectRetrievalAnswerShape({ query: "BM25", rewrittenQuery }),
      };
    };

    it("do not make a turn with no other evidence look answerable", async () => {
      const result = await stage().execute({
        ...buildInput([]),
        lexicalContexts: [someTermsChunk("partial-1"), someTermsChunk("partial-2")],
      });

      expect(result.scoredCandidates).toEqual([]);
    });

    it("join the candidates when semantic search found something", async () => {
      const result = await stage().execute({
        ...buildInput([semanticChunk(1)]),
        lexicalContexts: [someTermsChunk("partial-1")],
      });

      expect(result.scoredCandidates.map((candidate) => candidate.chunkId)).toEqual(["chunk-1", "partial-1"]);
    });

    it("join the candidates when another lexical branch found every term", async () => {
      const result = await stage().execute({
        ...buildInput([]),
        lexicalContexts: [
          someTermsChunk("partial-1"),
          semanticChunk(2, { lexicalRankScore: 0.2, similarity: 1, lexicalTermCoverage: "all_terms" }),
        ],
      });

      expect(result.scoredCandidates.map((candidate) => candidate.chunkId)).toEqual(["chunk-2", "partial-1"]);
    });

    it("left alone by a hard filter, still let the filter back off", async () => {
      const result = await stage().execute({
        ...buildInput([semanticChunk(1, { metadata: { category: "course" } })]),
        lexicalContexts: [semanticChunk(0, {
          chunkId: "partial-event",
          documentId: "doc-partial-event",
          similarity: 0.8,
          lexicalRankScore: 0.6,
          lexicalTermCoverage: "some_terms",
          metadata: { category: "event" },
        })],
        settings: {
          ...buildInput([]).settings,
          metadataRules: [{
            id: "matched-events",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact when the user asks about events.",
          }],
        },
        triggerAnalysis: {
          status: "applied",
          consideredRules: [{
            ruleId: "matched-events",
            matched: true,
            matchStrength: 0.94,
            reason: "The question asks about events.",
            triggerInstructionPreview: "Enact when the user asks about events.",
          }],
          matchedRuleIds: ["matched-events"],
          unmatchedRuleIds: [],
          matchCount: 1,
          matcherVersion: "test",
        },
      });

      expect(result.triggerBackoff).toMatchObject({
        applied: true,
        reason: "empty_filtered_candidates",
        relaxedRuleIds: ["matched-events"],
      });
      expect(result.scoredCandidates.map((candidate) => candidate.chunkId)).toEqual(["chunk-1", "partial-event"]);
    });

    // The production shape (d9d2becd): semantic search returns more candidates than the
    // answer pool holds, and the page that answers sits low among them.
    it("lift a low-ranked semantic candidate into the answer pool, and add none of their own", async () => {
      const settings = { ...buildInput([]).settings, rerankTopK: 12 };
      const poolSize = answerCandidatePoolSize(settings.rerankTopK);
      const semantic = Array.from({ length: 15 }, (_, index) => semanticChunk(index + 1, { similarity: 0.9 - index / 100 }));
      const target = semantic[14];
      const poolOf = (candidates: RetrievedCandidate[]) => candidates.slice(0, poolSize).map((candidate) => candidate.chunkId);

      const without = await stage().execute({ ...buildInput(semantic), settings });
      const withPartial = await stage().execute({
        ...buildInput(semantic),
        settings,
        lexicalContexts: [
          { ...target, similarity: 0.6, lexicalRankScore: 0.1, lexicalTermCoverage: "some_terms" },
          someTermsChunk("lexical-only"),
        ],
      });

      expect(poolSize).toBeLessThan(semantic.length);
      expect(poolOf(without.scoredCandidates)).not.toContain(target.chunkId);
      expect(poolOf(withPartial.scoredCandidates)).toContain(target.chunkId);
      expect(withPartial.scoredCandidates[0]?.chunkId).toBe(target.chunkId);
      // A partial match semantic search did not find ranks below every semantic
      // candidate, so it stays out of a full pool.
      expect(poolOf(withPartial.scoredCandidates)).not.toContain("lexical-only");
      expect(withPartial.scoredCandidates.at(-1)?.chunkId).toBe("lexical-only");
    });

    it("are not the lexical hits a lexical-preferred shape puts first", async () => {
      const semantic = [1, 2, 3].map((index) => semanticChunk(index, { similarity: 0.9 - index / 100 }));

      const result = await stage().execute({
        ...definitionLookup(buildInput(semantic)),
        lexicalContexts: [someTermsChunk("partial-1")],
      });

      expect(result.scoredCandidates.map((candidate) => candidate.chunkId)).toEqual([
        "chunk-1",
        "chunk-2",
        "chunk-3",
        "partial-1",
      ]);
    });
  });
});
