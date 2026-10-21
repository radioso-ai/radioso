import { describe, expect, it } from "vitest";

import type { StructuredRewriteResult } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import type { TemporalCandidateRetrievalPort } from "../../../src/modules/retrieval/domain/temporal/temporalCandidateRetrieval.js";
import type { RetrievedChunk } from "../../../src/modules/retrieval/domain/vectorSearch.js";
import { ActivityTracePresenter } from "../../../src/modules/retrieval/services/activityTracePresenter.js";
import { CandidatePreparationService } from "../../../src/modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../../src/modules/retrieval/services/conversationContextService.js";
import { PromptBuilder } from "../../../src/modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../../src/modules/retrieval/services/promptContextSelectorService.js";
import { QueryRewriteService } from "../../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService } from "../../../src/modules/retrieval/services/rerankService.js";
import { RetrievalExecutionTelemetryService } from "../../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { RetrievalPipelineService } from "../../../src/modules/retrieval/services/retrievalPipelineService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../src/shared/domain/behaviorConfig.js";

// The production workspace's retrieval settings the live calendar verification ran with.
const productionSettings = {
  workspaceId: "workspace-1",
  queryRewriteEnabled: true,
  rerankEnabled: false,
  rerankTopK: 5,
  vectorTopK: 15,
  similarityThreshold: 0.2,
  retrievalStrategy: "fixed",
  temporalStructuredLookupEnabled: true,
  temporalBoostUpcomingEnabled: true,
  temporalDeterministicSortEnabled: true,
  suggestedQuestionsEnabled: false,
  suggestedQuestionsCount: 0,
  citationDisplayEnabled: true,
  metadataRules: [],
  customInstruction: "",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const space = { id: "space-active", dimensions: 3, distanceMetric: "cosine" as const };
const january = { dateFrom: "2027-01-01", dateTo: "2027-01-31" };

const passage = (id: string, input: { title: string; metadata?: Record<string, unknown>; similarity?: number }): RetrievedChunk => ({
  chunkId: `chunk-${id}`,
  documentId: `doc-${id}`,
  title: input.title,
  content: `${input.title}: arrive fifteen minutes early, bring a mat and a blanket, and register at the front desk.`,
  searchText: input.title,
  similarity: input.similarity ?? 0,
  chunkIndex: 0,
  startOffset: 0,
  endOffset: 100,
  metadata: input.metadata ?? {},
});

const januaryCourse = (index: number, similarity = 0.5): RetrievedChunk => {
  const date = `2027-01-${String(1 + (index % 28)).padStart(2, "0")}`;
  return passage(`january-${index + 1}`, {
    title: `January course ${index + 1}`,
    metadata: { dateFrom: date, dateTo: date },
    similarity,
  });
};

// Runs one turn through the real pipeline: the rewrite names January 2027 with the labels the
// live corpus showed (no temporal mode, general shape), the range lookup returns `rangeCount`
// January courses, and semantic search returns `semanticHits`.
const runJanuaryTurn = async (input: {
  rangeCount?: number;
  rangeCourses?: RetrievedChunk[];
  semanticHits: RetrievedChunk[];
  settings?: Record<string, unknown>;
  documentScope?: string[];
}) => {
  const rangeCourses = input.rangeCourses
    ?? Array.from({ length: input.rangeCount ?? 0 }, (_value, index) => januaryCourse(index));
  const settings = { ...productionSettings, ...input.settings };
  const temporal: TemporalCandidateRetrievalPort = {
    async findInWindow(lookup) {
      return rangeCourses.slice(0, lookup.topK);
    },
  };
  const hitsById = new Map(input.semanticHits.map((hit) => [hit.chunkId, hit]));
  const proposal: StructuredRewriteResult = {
    rewrittenQuery: "courses in January 2027",
    semanticQuery: "courses in January 2027",
    lexicalQuery: "courses January 2027",
    queryShape: "general_grounding",
    temporalQueryMode: "none",
    requestedDateRange: january,
    turnKind: "fresh_subject",
    relatedEntities: [],
    unresolved: false,
    confidence: 0.9,
  };
  const service = new RetrievalPipelineService(
    { getDefaults: () => settings } as never,
    { async embedQueries() { return { space, vectors: [[1, 0, 0]] }; } },
    {
      async search() {
        return input.semanticHits.map((hit) => ({
          chunkId: hit.chunkId,
          documentId: hit.documentId,
          embeddingSpaceId: space.id,
          version: "1",
          score: hit.similarity,
        }));
      },
    },
    { async search() { return []; } },
    new ConversationContextService(),
    new QueryRewriteService(),
    new CandidatePreparationService(),
    new RerankService(),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(),
    undefined,
    {
      async hydrate(request: { candidates: Array<{ chunkId: string; score: number }> }) {
        return request.candidates.flatMap((candidate) => {
          const hit = hitsById.get(candidate.chunkId);
          return hit ? [{ ...hit, similarity: candidate.score }] : [];
        });
      },
    },
    temporal,
  );

  const interpretation = await service.interpret({
    workspaceId: "workspace-1",
    query: "Which courses are there in January 2027?",
    history: [],
    ...(input.documentScope ? { documentScope: input.documentScope } : {}),
    precomputedRewriteProposal: proposal,
  });
  const result = await service.runInterpreted(interpretation);
  // The trace a chat turn persists and the turn-trace tools read.
  const presented = new ActivityTracePresenter().present(result.trace, {});
  const selection = presented.stages.find((stage) => stage.kind === "context_selection");
  return { result, selection };
};

describe("date range answers under the production retrieval settings", () => {
  const cap = RETRIEVAL_BEHAVIOR.temporal.dateRangeListingContextTopK;
  const reserved = RETRIEVAL_BEHAVIOR.temporal.dateRangeReservedOutsidePassages;

  it("holds the date listing limit of passages for a busy month, and the trace lists every one", async () => {
    const outOfRange = Array.from({ length: 6 }, (_value, index) =>
      passage(`february-${index + 1}`, {
        title: `February course ${index + 1}`,
        metadata: { dateFrom: "2027-02-10", dateTo: "2027-02-10" },
        similarity: 0.6 - index / 100,
      }));
    const { result, selection } = await runJanuaryTurn({
      rangeCount: 40,
      semanticHits: [...outOfRange, januaryCourse(0, 0.55), januaryCourse(1, 0.54)],
    });

    expect(result.contexts).toHaveLength(cap);
    expect(selection?.metrics?.finalContextCount).toBe(cap);
    expect(selection?.outputs?.finalContexts).toHaveLength(cap);
    // A pure date question keeps all but the reserved passages for the month's events.
    const januaryContexts = result.contexts.filter((context) => context.title.startsWith("January course"));
    expect(januaryContexts).toHaveLength(cap - reserved);
  });

  it("keeps the best match outside the range in the answer when a busy range would fill it", async () => {
    const policy = passage("cancellation-policy", { title: "Course cancellation policy", similarity: 0.82 });
    const { result } = await runJanuaryTurn({
      rangeCount: 40,
      semanticHits: [policy, januaryCourse(0, 0.4)],
    });

    expect(result.contexts.map((context) => context.title)).toContain("Course cancellation policy");
    expect(result.contexts).toHaveLength(cap);
  });

  it("gives unused reserved passages to the range when nothing outside it matched", async () => {
    const { result } = await runJanuaryTurn({ rangeCount: 40, semanticHits: [januaryCourse(0, 0.55)] });

    expect(result.contexts).toHaveLength(cap);
    expect(result.contexts.every((context) => context.title.startsWith("January course"))).toBe(true);
  });

  it("keeps the reserve however high the rerank top K raises the lookup's depth", async () => {
    const outOfRange = Array.from({ length: 6 }, (_value, index) =>
      passage(`venue-${index + 1}`, { title: `Venue page ${index + 1}`, similarity: 0.6 - index / 100 }));
    const { result } = await runJanuaryTurn({
      rangeCount: 60,
      semanticHits: outOfRange,
      settings: { rerankTopK: 50 },
    });

    expect(result.contexts.filter((context) => context.title.startsWith("Venue page"))).toHaveLength(reserved);
    expect(result.contexts).toHaveLength(cap);
  });

  it("selects the range's most relevant passages and orders only those by date", async () => {
    // The lookup ranks course 1 closest; dates run backwards from the 28th, so the most
    // relevant sixteen are not the earliest sixteen.
    const rangeCourses = Array.from({ length: 40 }, (_value, index) => {
      const date = `2027-01-${String(28 - (index % 28)).padStart(2, "0")}`;
      return passage(`january-${index + 1}`, {
        title: `January course ${index + 1}`,
        metadata: { dateFrom: date, dateTo: date },
      });
    });
    const { result } = await runJanuaryTurn({ rangeCourses, semanticHits: [], settings: { rerankTopK: 50 } });

    const january = result.contexts.filter((context) => context.title.startsWith("January course"));
    expect(new Set(january.map((context) => context.title)))
      .toEqual(new Set(Array.from({ length: cap }, (_value, index) => `January course ${index + 1}`)));
    const dates = january.map((context) => String(context.metadata?.dateFrom));
    expect(dates).toEqual([...dates].sort());
    expect(result.contexts.map((context) => context.promptPosition)).toEqual(result.contexts.map((_context, index) => index));
  });

  it("gives the range only the passages the prompt can keep, two per event", async () => {
    // Six events with three passages each, and plenty of other candidates.
    const rangeCourses = Array.from({ length: 18 }, (_value, index) => {
      const event = Math.floor(index / 3);
      const date = `2027-01-${String(10 + event).padStart(2, "0")}`;
      return {
        ...passage(`event-${event}-part-${index % 3}`, { title: `January event ${event}`, metadata: { dateFrom: date, dateTo: date } }),
        documentId: `doc-event-${event}`,
        content: `January event ${event}, part ${index % 3}: the schedule, the teacher, and what to bring.`,
        chunkIndex: index % 3,
      };
    });
    const others = Array.from({ length: 20 }, (_value, index) =>
      passage(`other-${index}`, { title: `Other page ${index}`, similarity: 0.6 - index / 100 }));
    const { result } = await runJanuaryTurn({ rangeCourses, semanticHits: others, settings: { rerankTopK: 50 } });

    expect(result.contexts.filter((context) => context.title.startsWith("January event"))).toHaveLength(12);
    expect(result.contexts.filter((context) => context.title.startsWith("Other page"))).toHaveLength(reserved);
  });

  it("answers in the ordinary order when the range lookup found nothing", async () => {
    const hits = Array.from({ length: 14 }, (_value, index) =>
      passage(`page-${index}`, { title: `Page ${index}`, similarity: 0.9 - index / 100 }));
    const { result } = await runJanuaryTurn({ rangeCount: 0, semanticHits: hits });

    expect(result.contexts.map((context) => context.title))
      .toEqual(Array.from({ length: RETRIEVAL_BEHAVIOR.finalContextTopK }, (_value, index) => `Page ${index}`));
  });

  it("keeps range passages to the request's document scope", async () => {
    const { result } = await runJanuaryTurn({
      rangeCount: 10,
      semanticHits: [],
      documentScope: ["doc-january-2", "doc-january-5"],
    });

    expect(result.contexts.map((context) => context.documentId).sort()).toEqual(["doc-january-2", "doc-january-5"]);
  });

  it("applies the agent's metadata filter rules to range passages", async () => {
    const rangeCourses = Array.from({ length: 10 }, (_value, index) => {
      const date = `2027-01-${String(10 + index).padStart(2, "0")}`;
      return passage(`january-${index}`, {
        title: `January course ${index}`,
        metadata: { dateFrom: date, dateTo: date, language: index % 2 === 0 ? "it" : "en" },
      });
    });
    const { result } = await runJanuaryTurn({
      rangeCourses,
      semanticHits: [],
      settings: {
        metadataRules: [{
          id: "italian-only",
          field: "language",
          valueType: "string",
          operator: "equals",
          value: "it",
          effect: "filter",
          enabled: true,
          triggerMode: "always_on",
        }],
      },
    });

    expect(result.contexts).toHaveLength(5);
    expect(result.contexts.every((context) => context.metadata?.language === "it")).toBe(true);
  });
});
