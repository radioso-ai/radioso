import { describe, expect, it } from "vitest";

import { CandidatePreparationStageService } from "../../src/modules/retrieval/services/candidatePreparationStage.js";
import { CandidatePreparationService } from "../../src/modules/retrieval/services/candidatePreparationService.js";
import { MetadataRuleScoringService } from "../../src/modules/retrieval/services/metadataRuleScoringService.js";
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
    answerSupportPolicy: "strict",
    conversationMode: "guided",
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
    status: "applied",
    semanticQuery: "when is the next family camp?",
    lexicalQuery: "next family camp",
    rewrittenQuery: "when is the next family camp?",
    retrievalEligible: true,
    promptHistoryCount: 0,
    activeSubjectChanged: false,
    continuityDecision: "unresolved",
    responseLanguagePolicy: "match_user_question",
  },
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
});
