import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import type {
  QueryEmbeddingPort,
} from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import type { ChunkCandidateHydratorPort } from "../infra/chunkCandidateHydrator.js";
import type { VectorCandidateSearchPort } from "../domain/vectorAdapter.js";
import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";
import type { TemporalCandidateRetrievalPort } from "../domain/temporal/temporalCandidateRetrieval.js";
import type { TemporalQueryMode } from "../domain/retrievalPipelineTypes.js";
import { normalizeVectorMetadataFilter, type VectorMetadataFilter } from "../domain/vectorFilter.js";
import type { CandidateRetrievalStage as CandidateRetrievalStageContract, QueryInterpretationStageResult } from "./retrievalPipelineStages.js";

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
    const sourceFilter = input.request.sourceFilter;
    const metadataFilter = normalizeVectorMetadataFilter(input.request.metadataFilter);
    const semanticQueries = input.activeRetrievalSubqueries.map((subquery) => subquery.semanticQuery);
    // Lexical fan-out stays per-branch (cheap); distinct semantic searches are
    // capped because each costs an embedding + a concurrent pgvector search.
    // Branches whose semantic query falls outside the cap resolve to empty
    // semantic contexts below and contribute lexical-only.
    const uniqueSemanticQueries = [...new Set(semanticQueries)].slice(0, RETRIEVAL_BEHAVIOR.maxSemanticBranches);
    const searchedSemanticQueries = new Set(uniqueSemanticQueries);
    const lexicalSearchBySubquery = new Map(
      input.activeRetrievalSubqueries.map((subquery) => [
        subquery.id,
        this.lexicalSearch.search({
          workspaceId: input.request.workspaceId,
          query: subquery.lexicalQuery,
          topK: RETRIEVAL_BEHAVIOR.hybrid.lexicalTopK,
          metadataFilter,
          sourceFilter,
          lexicalPlan: subquery.lexicalPlan,
        }),
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
    const semanticSearchByQuery = new Map(
      uniqueSemanticQueries.map((query) => [
        query,
        embeddingResult
          ? this.searchWithFallback({
              workspaceId: input.request.workspaceId,
              space: embeddingResult.space,
              queryVector: embeddingBySemanticQuery.get(query) ?? [],
              topK: input.settings.vectorTopK,
              minimumScore: input.settings.similarityThreshold,
              metadataFilter,
              sourceFilter,
            }).catch(() => ({ contexts: [], fallbackApplied: true }))
          : Promise.resolve({ contexts: [], fallbackApplied: true }),
      ] as const),
    );
    const retrievalBranches = await Promise.all(
      input.activeRetrievalSubqueries.map(async (subquery) => {
        // A branch outside the semantic cap (searchedSemanticQueries) is lexical-only
        // by design — its empty semantic result is not a vector fallback, so it must
        // not raise vectorFallbackApplied for the turn.
        const semanticSearched =
          embeddingResult !== null
          && searchedSemanticQueries.has(subquery.semanticQuery);
        const semanticSearchForBranch = semanticSearched
          ? semanticSearchByQuery.get(subquery.semanticQuery)
          : embeddingResult
            ? Promise.resolve({ contexts: [], fallbackApplied: false })
            : Promise.resolve({ contexts: [], fallbackApplied: true });
        const [semanticSearch, lexicalContexts] = await Promise.all([
          semanticSearchForBranch ?? Promise.resolve({ contexts: [], fallbackApplied: false }),
          lexicalSearchBySubquery.get(subquery.id) ?? Promise.resolve([]),
        ]);

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
          lexicalContexts,
          fallbackApplied: semanticSearch.fallbackApplied,
        };
      }),
    );

    const originalContexts = input.rewrittenQuery.retrievalEligible
      ? []
      : retrievalBranches.flatMap((branch) => branch.semanticContexts);
    const rewrittenContexts = input.rewrittenQuery.retrievalEligible
      ? retrievalBranches.flatMap((branch) => branch.semanticContexts)
      : [];
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
    const temporalQueryMode = resolveTemporalQueryMode(input);
    const temporalStructuredLookupEnabled = input.settings.temporalStructuredLookupEnabled ?? true;
    const temporalContexts = temporalStructuredLookupEnabled && temporalQueryMode === "listing" && this.temporalCandidateRetrieval
      ? await this.temporalCandidateRetrieval.findUpcoming({
          workspaceId: input.request.workspaceId,
          today: formatIsoDateUtc(this.clock()),
          topK: input.settings.vectorTopK,
          metadataFilter,
          sourceFilter,
        })
      : [];

    return {
      ...input,
      activeEmbedding: embeddingBySemanticQuery.get(input.activeRetrievalSubqueries[0]?.semanticQuery ?? "") ?? [],
      activeEmbeddingDurationMs,
      originalContexts,
      rewrittenContexts,
      lexicalContexts,
      temporalContexts,
      temporalQueryMode,
      temporalStructuredLookupEnabled,
      retrievalBranches: retrievalBranches.map(({ fallbackApplied: _fallbackApplied, ...branch }) => branch),
      vectorFallbackApplied: retrievalBranches.some((branch) => branch.fallbackApplied),
      semanticRetrievalAvailability,
      semanticRetrievalFailureReason,
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

const resolveTemporalQueryMode = (input: QueryInterpretationStageResult): TemporalQueryMode => {
  const structured = input.rewrittenQuery.structuredResult;
  if (structured?.queryShape !== "event_date_lookup") {
    return "none";
  }
  return structured.temporalQueryMode ?? "none";
};
