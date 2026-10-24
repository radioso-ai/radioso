import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import type {
  QueryEmbeddingPort,
} from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { LexicalSearchPort, LexicalSearchResult } from "../infra/lexicalSearch.js";
import { skippedSomeTermsPass } from "../domain/lexicalSomeTermsMatch.js";
import type { ChunkCandidateHydratorPort } from "../infra/chunkCandidateHydrator.js";
import type { VectorCandidateSearchPort } from "../domain/vectorAdapter.js";
import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";
import type {
  TemporalCandidateRetrievalInput,
  TemporalCandidateRetrievalPort,
  TemporalSimilarityQuery,
} from "../domain/temporal/temporalCandidateRetrieval.js";
import type { RequestedDateRange } from "../domain/temporal/requestedDateRange.js";
import type { TemporalQueryMode } from "../domain/retrievalPipelineTypes.js";
import { dateRangeLookupDepth } from "../domain/answerCandidatePool.js";
import { normalizeVectorMetadataFilter, type VectorMetadataFilter } from "../domain/vectorFilter.js";
import {
  DEGRADABLE_RETRIEVAL_CHANNELS,
  type CandidateRetrievalStage as CandidateRetrievalStageContract,
  type DegradableRetrievalChannel,
  type QueryInterpretationStageResult,
} from "./retrievalPipelineStages.js";

export class CandidateRetrievalStageService implements CandidateRetrievalStageContract {
  constructor(
    private readonly queryEmbeddings: QueryEmbeddingPort,
    private readonly vectorSearch: VectorCandidateSearchPort,
    private readonly lexicalSearch: LexicalSearchPort,
    private readonly chunkHydrator: ChunkCandidateHydratorPort,
    private readonly temporalCandidateRetrieval?: TemporalCandidateRetrievalPort,
    clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  private readonly clock: Clock;

  async execute(input: QueryInterpretationStageResult) {
    const embeddingStartedAt = Date.now();
    const retrievalNow = this.clock();
    const sourceFilter = input.request.sourceFilter;
    const metadataFilter = normalizeVectorMetadataFilter(input.request.metadataFilter);
    const semanticQueries = input.activeRetrievalSubqueries.map((subquery) => subquery.semanticQuery);
    // Lexical fan-out stays per-branch (cheap); distinct semantic searches are
    // capped because each costs an embedding + a concurrent pgvector search.
    // Branches whose semantic query falls outside the cap resolve to empty
    // semantic contexts below and contribute lexical-only.
    const uniqueSemanticQueries = [...new Set(semanticQueries)].slice(0, RETRIEVAL_BEHAVIOR.maxSemanticBranches);
    const searchedSemanticQueries = new Set(uniqueSemanticQueries);
    // A failing channel degrades the answer; it must never abort the turn. Semantic
    // search is already guarded below, so an unguarded lexical or temporal query was
    // the one path where a backend outage produced no reply at all.
    const degradedChannels = new Set<DegradableRetrievalChannel>();
    const lexicalTiming = startBranchTiming();
    const lexicalSearchBySubquery = new Map(
      input.activeRetrievalSubqueries.map((subquery) => [
        subquery.id,
        lexicalTiming.track(this.lexicalSearch.search({
          workspaceId: input.request.workspaceId,
          query: subquery.lexicalQuery,
          topK: RETRIEVAL_BEHAVIOR.hybrid.lexicalTopK,
          matchMode: "all_or_some_terms",
          metadataFilter,
          sourceFilter,
          lexicalPlan: subquery.lexicalPlan,
        }).catch((): LexicalSearchResult => {
          degradedChannels.add("lexical");
          return { matches: [], someTermsPass: skippedSomeTermsPass() };
        })),
      ] as const),
    );
    const embeddingResult = await this.queryEmbeddings.embedQueries({
        workspaceId: input.request.workspaceId,
        texts: uniqueSemanticQueries,
        usageContext: {
          ...(input.request.usageContext ?? {
            workspaceId: input.request.workspaceId,
            surface: "retrieval",
            attemptKey: "query_embedding",
          }),
          operation: "query_embedding",
          attemptKey: "query_embedding",
        },
      })
      .catch(() => null);
    const embeddingBySemanticQuery = new Map(
      uniqueSemanticQueries.map((query, index) => [
        query,
        embeddingResult?.vectors[index] ?? [],
      ] as const),
    );
    const activeEmbeddingDurationMs = Math.max(0, Date.now() - embeddingStartedAt);
    const semanticTiming = startBranchTiming();
    const semanticSearchByQuery = new Map(
      uniqueSemanticQueries.map((query) => [
        query,
        embeddingResult
          ? semanticTiming.track(this.searchWithFallback({
              workspaceId: input.request.workspaceId,
              space: embeddingResult.space,
              queryVector: embeddingBySemanticQuery.get(query) ?? [],
              topK: input.settings.vectorTopK,
              minimumScore: input.settings.similarityThreshold,
              metadataFilter,
              sourceFilter,
              notExpiredAt: retrievalNow.toISOString(),
            }).catch(() => ({ contexts: [], fallbackApplied: true })))
          : undefined,
      ] as const),
    );
    // The temporal lookup runs alongside the semantic and lexical searches. A requested date
    // range runs it whatever the rewrite labelled the question: the range is only returned for
    // a question that names a date or period, so it is the signal, and ranking by the question's
    // embedding keeps a topic question's events ahead within the range.
    const activeEmbedding = embeddingBySemanticQuery.get(input.activeRetrievalSubqueries[0]?.semanticQuery ?? "") ?? [];
    const temporalQueryMode = resolveTemporalQueryMode(input);
    const temporalDateRange = input.rewrittenQuery.structuredResult?.requestedDateRange;
    const temporalStructuredLookupEnabled = input.settings.temporalStructuredLookupEnabled ?? true;
    const temporalLookup = temporalStructuredLookupEnabled && this.temporalCandidateRetrieval
      ? planTemporalLookup({
          mode: temporalQueryMode,
          dateRange: temporalDateRange,
          today: formatIsoDateUtc(retrievalNow),
          settings: input.settings,
          similarTo: embeddingResult && activeEmbedding.length === embeddingResult.space.dimensions
            ? { space: embeddingResult.space, queryVector: activeEmbedding }
            : undefined,
        })
      : null;
    const temporalLookupRanking = temporalLookup?.window.kind === "requested_range"
      ? (temporalLookup.window.similarTo ? "similarity" as const : "date" as const)
      : undefined;
    const temporalSearch = temporalLookup && this.temporalCandidateRetrieval
      ? this.temporalCandidateRetrieval.findInWindow({
          workspaceId: input.request.workspaceId,
          ...temporalLookup,
          metadataFilter,
          sourceFilter,
          ...(input.request.documentScope?.length ? { documentIds: input.request.documentScope } : {}),
        }).catch((): RetrievedChunk[] => {
          degradedChannels.add("temporal");
          return [];
        })
      : Promise.resolve<RetrievedChunk[]>([]);
    const retrievalBranches = await Promise.all(
      input.activeRetrievalSubqueries.map(async (subquery) => {
        // A branch outside the semantic cap (searchedSemanticQueries) is lexical-only
        // by design — its empty semantic result is not a vector fallback, so it must
        // not raise vectorFallbackApplied for the turn.
        const semanticSearched =
          embeddingResult !== null
          && searchedSemanticQueries.has(subquery.semanticQuery);
        const semanticEntry = semanticSearched
          ? semanticSearchByQuery.get(subquery.semanticQuery)
          : undefined;
        const semanticSearchForBranch = semanticEntry
          ? semanticEntry.promise
          : embeddingResult
            ? Promise.resolve({ contexts: [], fallbackApplied: false })
            : Promise.resolve({ contexts: [], fallbackApplied: true });
        const lexicalEntry = lexicalSearchBySubquery.get(subquery.id);
        const [semanticSearch, lexicalResult] = await Promise.all([
          semanticSearchForBranch,
          lexicalEntry?.promise ?? Promise.resolve<LexicalSearchResult>({ matches: [], someTermsPass: skippedSomeTermsPass() }),
        ]);
        // Read after the searches above have settled, so each timing is final.
        const semanticSearchTiming = semanticEntry?.timing();
        const lexicalSearchTiming = lexicalEntry?.timing();

        return {
          subqueryId: subquery.id,
          label: subquery.label,
          semanticQuery: subquery.semanticQuery,
          lexicalQuery: subquery.lexicalQuery,
          reason: subquery.reason,
          responseLanguagePolicy: subquery.responseLanguagePolicy,
          source: input.rewrittenQuery.retrievalEligible ? ("rewritten" as const) : ("original" as const),
          semanticSearched,
          semanticContexts: semanticSearch.contexts,
          lexicalContexts: lexicalResult.matches,
          lexicalSomeTermsPass: lexicalResult.someTermsPass,
          fallbackApplied: semanticSearch.fallbackApplied,
          semanticSearchStartedAtMs: semanticSearchTiming?.startedAtMs,
          semanticSearchDurationMs: semanticSearchTiming?.durationMs,
          lexicalSearchStartedAtMs: lexicalSearchTiming?.startedAtMs,
          lexicalSearchDurationMs: lexicalSearchTiming?.durationMs,
        };
      }),
    );

    // Branches that share a semantic query share one search; count its hits once.
    const semanticContexts = retrievalBranches
      .filter((branch, index) => retrievalBranches.findIndex((other) => other.semanticQuery === branch.semanticQuery) === index)
      .flatMap((branch) => branch.semanticContexts);
    const originalContexts = input.rewrittenQuery.retrievalEligible ? [] : semanticContexts;
    const rewrittenContexts = input.rewrittenQuery.retrievalEligible ? semanticContexts : [];
    const lexicalContexts = retrievalBranches.flatMap((branch) => branch.lexicalContexts);
    const semanticRetrievalAvailability = resolveSemanticAvailability({
      embeddingAvailable: embeddingResult !== null,
      searchedBranchCount: retrievalBranches.filter((branch) => branch.semanticSearched).length,
      failedBranchCount: retrievalBranches.filter((branch) => branch.fallbackApplied).length,
    });
    const semanticRetrievalFailureReason = semanticRetrievalAvailability === "available"
      ? null
      : embeddingResult
        ? "vector_search_unavailable" as const
        : "query_embedding_unavailable" as const;
    const temporalContexts = await temporalSearch;

    return {
      ...input,
      activeEmbedding,
      activeEmbeddingDurationMs,
      semanticRetrievalStartedAtMs: semanticTiming.startedAtMs,
      semanticRetrievalDurationMs: semanticTiming.durationMs(),
      lexicalRetrievalStartedAtMs: lexicalTiming.startedAtMs,
      lexicalRetrievalDurationMs: lexicalTiming.durationMs(),
      originalContexts,
      rewrittenContexts,
      lexicalContexts,
      temporalContexts,
      temporalQueryMode,
      ...(temporalDateRange ? { temporalDateRange } : {}),
      ...(temporalLookupRanking ? { temporalLookupRanking } : {}),
      temporalStructuredLookupEnabled,
      retrievalBranches: retrievalBranches.map(({ fallbackApplied: _fallbackApplied, ...branch }) => branch),
      vectorFallbackApplied: retrievalBranches.some((branch) => branch.fallbackApplied),
      semanticRetrievalAvailability,
      semanticRetrievalFailureReason,
      degradedRetrievalChannels: DEGRADABLE_RETRIEVAL_CHANNELS
        .filter((channel) => degradedChannels.has(channel)),
    };
  }

  private async searchWithFallback(input: {
    workspaceId: string;
    space: Parameters<VectorCandidateSearchPort["search"]>[0]["space"];
    queryVector: number[];
    topK: number;
    minimumScore: number;
    metadataFilter?: VectorMetadataFilter;
    sourceFilter?: RetrievalSourceFilter;
    notExpiredAt: string;
  }): Promise<{ contexts: RetrievedChunk[]; fallbackApplied: boolean }> {
    const candidates = await this.vectorSearch.search({
      workspaceId: input.workspaceId,
      space: input.space,
      queryVector: input.queryVector,
      topK: input.topK,
      minimumScore: input.minimumScore,
      filter: {
        metadataContains: input.metadataFilter,
        source: input.sourceFilter,
        retrievalEnabled: true,
        notExpiredAt: input.notExpiredAt,
      },
    });
    const rows = await this.chunkHydrator.hydrate({
      workspaceId: input.workspaceId,
      candidates,
      metadataFilter: input.metadataFilter,
      sourceFilter: input.sourceFilter,
    });

    return {
      contexts: rows,
      fallbackApplied: false,
    };
  }
}

interface MeasuredSearch<T> {
  readonly promise: Promise<T>;
  // Final once `promise` has settled; callers read it after awaiting.
  timing(): { startedAtMs: number; durationMs: number };
}

interface BranchTiming {
  readonly startedAtMs: number;
  track<T>(promise: Promise<T>): MeasuredSearch<T>;
  durationMs(): number;
}

// Semantic and lexical retrieval run concurrently, so each is measured around its
// own promises instead of being carved out of the enclosing stage span. Two
// consequences are intended: the two can start at different times, and their
// durations can sum to more than the span that contains both. Each tracked search
// also keeps its own start and duration, so a sub-question's search is reported as
// what it took rather than the slowest search's window.
const startBranchTiming = (): BranchTiming => {
  const startedAtMs = Date.now();
  let completedAtMs = startedAtMs;

  return {
    startedAtMs,
    track: <T>(promise: Promise<T>): MeasuredSearch<T> => {
      const searchStartedAtMs = Date.now();
      let searchDurationMs = 0;
      const tracked = promise.finally(() => {
        const settledAtMs = Date.now();
        searchDurationMs = Math.max(0, settledAtMs - searchStartedAtMs);
        completedAtMs = Math.max(completedAtMs, settledAtMs);
      });
      return {
        promise: tracked,
        timing: () => ({ startedAtMs: searchStartedAtMs, durationMs: searchDurationMs }),
      };
    },
    // A channel that issued no work reports zero rather than a share of the stage.
    durationMs: () => Math.max(0, completedAtMs - startedAtMs),
  };
};

const resolveSemanticAvailability = (input: {
  embeddingAvailable: boolean;
  searchedBranchCount: number;
  failedBranchCount: number;
}): "available" | "degraded" | "unavailable" => {
  if (!input.embeddingAvailable) {
    return "unavailable";
  }
  if (input.failedBranchCount === 0) {
    return "available";
  }
  return input.failedBranchCount < input.searchedBranchCount
    ? "degraded"
    : "unavailable";
};

// A requested range is looked up as deep as a busy week, ranked by similarity to the question
// when it has an embedding. Without one, a listing question looks up upcoming events at the
// fetch depth it always had, `vectorTopK`; any other question runs no lookup.
const planTemporalLookup = (input: {
  mode: TemporalQueryMode;
  dateRange: RequestedDateRange | undefined;
  today: string;
  settings: QueryInterpretationStageResult["settings"];
  similarTo: TemporalSimilarityQuery | undefined;
}): Pick<TemporalCandidateRetrievalInput, "window" | "topK"> | null => {
  if (input.dateRange) {
    return {
      window: {
        kind: "requested_range",
        range: input.dateRange,
        ...(input.similarTo ? { similarTo: input.similarTo } : {}),
      },
      topK: dateRangeLookupDepth(input.settings.rerankTopK),
    };
  }
  if (input.mode === "listing") {
    return { window: { kind: "upcoming", today: input.today }, topK: input.settings.vectorTopK };
  }
  return null;
};

// A question whose named period the rewrite could not turn into a usable range gets no
// temporal mode: the upcoming lookup, boost, and soonest-first order all assume a question about
// what is coming up, which a question naming a past or a multi-year period is not.
const resolveTemporalQueryMode = (input: QueryInterpretationStageResult): TemporalQueryMode => {
  const structured = input.rewrittenQuery.structuredResult;
  if (structured?.queryShape !== "event_date_lookup" || structured.requestedDateRangeDropReason) {
    return "none";
  }
  return structured.temporalQueryMode ?? "none";
};
