import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TemporalCandidateRetrievalInput, TemporalCandidateRetrievalPort } from "../../../src/modules/retrieval/domain/temporal/temporalCandidateRetrieval.js";
import type { RetrievedChunk } from "../../../src/modules/retrieval/domain/vectorSearch.js";
import { CandidatePreparationService } from "../../../src/modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../../src/modules/retrieval/services/conversationContextService.js";
import { PromptBuilder } from "../../../src/modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../../src/modules/retrieval/services/promptContextSelectorService.js";
import { ModelQueryRewriteGateway } from "../../../src/modules/retrieval/services/queryRewriteGateways.js";
import { QueryRewriteService } from "../../../src/modules/retrieval/services/queryRewriteService.js";
import { RerankService, type RerankGateway } from "../../../src/modules/retrieval/services/rerankService.js";
import { RetrievalExecutionTelemetryService } from "../../../src/modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { RetrievalPipelineService } from "../../../src/modules/retrieval/services/retrievalPipelineService.js";
import type { ReferenceTimeZone } from "../../../src/shared/domain/referenceTimeZone.js";
import type { ModelInferencePipeline } from "../../../src/shared/infra/llm/modelInferencePipeline.js";
import { lexicalSearchStub } from "../../support/lexicalSearchStub.js";

// 02:00 UTC on Tuesday 3 November 2026 is 18:00 on Monday 2 November in Los Angeles.
const NOW = "2026-11-03T02:00:00.000Z";

const settings = {
  workspaceId: "workspace-1",
  queryRewriteEnabled: true,
  rerankEnabled: true,
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

const event = (date: string): RetrievedChunk => ({
  chunkId: `chunk-${date}`,
  documentId: `doc-${date}`,
  title: `Evening concert ${date}`,
  content: `An evening concert on ${date} in the main hall.`,
  searchText: `Evening concert ${date}`,
  similarity: 0.6,
  chunkIndex: 0,
  startOffset: 0,
  endOffset: 60,
  metadata: { dateFrom: date, dateTo: date },
});

const nextDay = (isoDate: string): string => {
  const day = new Date(`${isoDate}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

/**
 * Stands in for the rewrite model: it reads the prompt's date line and resolves "tomorrow" from
 * it, the arithmetic the real model does. Whatever "today" the prompt carries decides the range.
 */
const tomorrowResolvingInference = (prompts: string[]): ModelInferencePipeline => ({
  async complete(request: { prompt?: string }) {
    const prompt = request.prompt ?? "";
    prompts.push(prompt);
    const today = /Today's date: (\d{4}-\d{2}-\d{2})/.exec(prompt)?.[1] ?? "";
    const tomorrow = nextDay(today);
    return {
      text: JSON.stringify({
        rewrittenQuery: "events tomorrow",
        semanticQuery: "events tomorrow",
        lexicalQuery: "events tomorrow",
        queryShape: "event_date_lookup",
        temporalQueryMode: "listing",
        requestedDateRange: { dateFrom: tomorrow, dateTo: tomorrow },
        turnKind: "fresh_subject",
        relatedEntities: [],
        unresolved: false,
        confidence: 0.9,
      }),
    };
  },
}) as unknown as ModelInferencePipeline;

const runTomorrowTurn = async (input: {
  referenceTimeZone?: ReferenceTimeZone;
  workspaceTimeZone?: string | null;
}) => {
  const rewritePrompts: string[] = [];
  const lookups: TemporalCandidateRetrievalInput[] = [];
  const rerankTodays: string[] = [];
  const temporal: TemporalCandidateRetrievalPort = {
    async findInWindow(lookup) {
      lookups.push(lookup);
      return lookup.window.kind === "requested_range" ? [event(lookup.window.range.dateFrom)] : [];
    },
  };
  const rerankGateway: RerankGateway = {
    async rerank(request) {
      rerankTodays.push(request.today);
      return request.contexts.map((context) => ({ chunkId: context.chunkId, relevanceScore: 0.9 }));
    },
  };
  const service = new RetrievalPipelineService(
    { getDefaults: () => settings } as never,
    { async embedQueries() { return { space, vectors: [[1, 0, 0]] }; } },
    { async search() { return []; } },
    lexicalSearchStub({ async search() { return []; } }),
    new ConversationContextService(),
    new QueryRewriteService(new ModelQueryRewriteGateway(tomorrowResolvingInference(rewritePrompts))),
    new CandidatePreparationService(),
    new RerankService(rerankGateway),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(),
    undefined,
    { async hydrate() { return []; } },
    temporal,
    input.workspaceTimeZone === undefined
      ? undefined
      : { async readWorkspaceTimeZone() { return input.workspaceTimeZone ?? null; } },
  );

  const result = await service.run({
    workspaceId: "workspace-1",
    query: "What's on tomorrow?",
    history: [],
    ...(input.referenceTimeZone ? { referenceTimeZone: input.referenceTimeZone } : {}),
  });
  const contextStage = result.trace.stages.find((stage) => stage.stageId === "context");
  return { result, rewritePrompts, lookups, rerankTodays, timeZoneSource: contextStage?.inputs?.timeZoneSource };
};

describe("relative dates resolve in the turn's time zone", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a Los Angeles visitor at 18:00 local their tomorrow, not UTC's", async () => {
    const turn = await runTomorrowTurn({
      referenceTimeZone: { timeZone: "America/Los_Angeles", source: "visitor" },
    });

    expect(turn.rewritePrompts[0]).toContain("Today's date: 2026-11-02 (Monday)");
    const rangeLookup = turn.lookups.find((lookup) => lookup.window.kind === "requested_range");
    expect(rangeLookup?.window).toMatchObject({ range: { dateFrom: "2026-11-03", dateTo: "2026-11-03" } });
    expect(turn.result.contexts.map((context) => context.title)).toEqual(["Evening concert 2026-11-03"]);
    expect(turn.rerankTodays).toEqual(["2026-11-02 (Monday)"]);
    expect(turn.result.systemPrompt).toContain("The current date is 2026-11-02 (Monday)");
    expect(turn.timeZoneSource).toBe("visitor");
  });

  it("reads the workspace's zone when the run carries none", async () => {
    const turn = await runTomorrowTurn({ workspaceTimeZone: "America/New_York" });

    expect(turn.rewritePrompts[0]).toContain("Today's date: 2026-11-02 (Monday)");
    expect(turn.result.systemPrompt).toContain("The current date is 2026-11-02 (Monday)");
    expect(turn.timeZoneSource).toBe("workspace");
  });

  it("is UTC when neither the run nor the workspace names a zone", async () => {
    const turn = await runTomorrowTurn({ workspaceTimeZone: null });

    expect(turn.rewritePrompts[0]).toContain("Today's date: 2026-11-03 (Tuesday)");
    const rangeLookup = turn.lookups.find((lookup) => lookup.window.kind === "requested_range");
    expect(rangeLookup?.window).toMatchObject({ range: { dateFrom: "2026-11-04", dateTo: "2026-11-04" } });
    expect(turn.timeZoneSource).toBe("default");
  });

  it("keeps the zone a chat turn resolved instead of reading the workspace's", async () => {
    const turn = await runTomorrowTurn({
      referenceTimeZone: { timeZone: "America/Los_Angeles", source: "visitor" },
      workspaceTimeZone: "Asia/Tokyo",
    });

    expect(turn.rewritePrompts[0]).toContain("Today's date: 2026-11-02 (Monday)");
    expect(turn.timeZoneSource).toBe("visitor");
  });
});
