import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import type { EmbeddingService } from "./embeddingService.js";
import { EMBEDDING_MODEL_DEFAULT, type IngestionSettingsRecord } from "../../settings/contracts/ingestion.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import type { ChunkCandidateHydratorPort } from "../infra/chunkCandidateHydrator.js";
import type { VectorIndexPort } from "../domain/vectorIndex.js";
import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { RetrievedChunk, VectorSearchPort } from "../domain/vectorSearch.js";
import type { TemporalCandidateRetrievalPort } from "../domain/temporal/temporalCandidateRetrieval.js";
import type { TemporalQueryMode } from "../domain/retrievalPipelineTypes.js";
import { normalizeVectorMetadataFilter, type VectorMetadataFilter } from "../domain/vectorFilter.js";
import type { CandidateRetrievalStage as CandidateRetrievalStageContract, QueryInterpretationStageResult } from "./retrievalPipelineStages.js";

export interface IngestionSettingsReaderPort {
  getForWorkspace(workspaceId: string): Promise<IngestionSettingsRecord>;
}

export class CandidateRetrievalStageService implements CandidateRetrievalStageContract {
  constructor(
    embeddingService: EmbeddingService,
    vectorSearch: VectorSearchPort,
    lexicalSearch: LexicalSearchPort,
    ingestionSettingsService?: IngestionSettingsReaderPort,
    temporalCandidateRetrieval?: TemporalCandidateRetrievalPort,
    clock?: Clock,
  );
  constructor(
    embeddingService: EmbeddingService,
    vectorSearch: VectorIndexPort,
    lexicalSearch: LexicalSearchPort,
    ingestionSettingsService: IngestionSettingsReaderPort | undefined,
    chunkHydrator: ChunkCandidateHydratorPort,
    temporalCandidateRetrieval?: TemporalCandidateRetrievalPort,
    clock?: Clock,
  );
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorSearch: VectorSearchPort | VectorIndexPort,
    private readonly lexicalSearch: LexicalSearchPort,
    private readonly ingestionSettingsService?: IngestionSettingsReaderPort,
    chunkHydratorOrTemporal?: ChunkCandidateHydratorPort | TemporalCandidateRetrievalPort,
    temporalOrClock?: TemporalCandidateRetrievalPort | Clock,
    clock?: Clock,
  ) {
    // The overloads put the optional clock last in both call shapes, so at the
    // shared implementation position it can be either the temporal port (long
    // form) or the clock (short form). A Clock is a bare function; ports are
    // objects — disambiguate on that.
    const temporalCandidateRetrieval = typeof temporalOrClock === "function" ? undefined : temporalOrClock;
    this.clock = (typeof temporalOrClock === "function" ? temporalOrClock : clock) ?? systemClock;
    if (chunkHydratorOrTemporal && "hydrate" in chunkHydratorOrTemporal) {
      this.chunkHydrator = chunkHydratorOrTemporal;
      this.temporalCandidateRetrieval = temporalCandidateRetrieval;
    } else {
      this.temporalCandidateRetrieval = chunkHydratorOrTemporal ?? temporalCandidateRetrieval;
    }
  }

  private readonly chunkHydrator?: ChunkCandidateHydratorPort;
  private readonly temporalCandidateRetrieval?: TemporalCandidateRetrievalPort;
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
    const ingestionSettings = await this.ingestionSettingsService?.getForWorkspace(input.request.workspaceId);
    const embeddingModel = ingestionSettings?.embeddingModel;
    const embeddings = await this.embeddingService.embedChunks(uniqueSemanticQueries, {
      model: embeddingModel,
      usageContext: {
        ...(input.request.usageContext ?? {
          workspaceId: input.request.workspaceId,
          surface: "retrieval",
          attemptKey: "query_embedding",
        }),
        operation: "query_embedding",
        attemptKey: "query_embedding",
      },
    });
    const embeddingBySemanticQuery = new Map(
      uniqueSemanticQueries.map((query, index) => [query, embeddings[index] ?? []] as const),
    );
    const activeEmbeddingDurationMs = Math.max(0, Date.now() - embeddingStartedAt);
    const semanticSearchByQuery = new Map(
      uniqueSemanticQueries.map((query) => [
        query,
        this.searchWithFallback({
          workspaceId: input.request.workspaceId,
          queryEmbedding: embeddingBySemanticQuery.get(query) ?? [],
          queryEmbeddingDimensions: (embeddingBySemanticQuery.get(query) ?? []).length,
          topK: input.settings.vectorTopK,
          similarityThreshold: input.settings.similarityThreshold,
          embeddingModel,
          metadataFilter,
          sourceFilter,
        }),
      ] as const),
    );
    const retrievalBranches = await Promise.all(
      input.activeRetrievalSubqueries.map(async (subquery) => {
        // A branch outside the semantic cap (searchedSemanticQueries) is lexical-only
        // by design — its empty semantic result is not a vector fallback, so it must
        // not raise vectorFallbackApplied for the turn.
        const semanticSearched = searchedSemanticQueries.has(subquery.semanticQuery);
        const semanticSearchForBranch = semanticSearched
          ? semanticSearchByQuery.get(subquery.semanticQuery)
          : Promise.resolve({ contexts: [], fallbackApplied: false });
        const [semanticSearch, lexicalContexts] = await Promise.all([
          semanticSearchForBranch ?? Promise.resolve({ contexts: [], fallbackApplied: false }),
          this.lexicalSearch.search({
            workspaceId: input.request.workspaceId,
            query: subquery.lexicalQuery,
            topK: RETRIEVAL_BEHAVIOR.hybrid.lexicalTopK,
            metadataFilter,
            sourceFilter,
            lexicalPlan: subquery.lexicalPlan,
          }),
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
    };
  }

  private async searchWithFallback(input: {
    workspaceId: string;
    queryEmbedding: number[];
    queryEmbeddingDimensions: number;
    topK: number;
    similarityThreshold: number;
    embeddingModel?: string;
    metadataFilter?: VectorMetadataFilter;
    sourceFilter?: RetrievalSourceFilter;
  }): Promise<{ contexts: RetrievedChunk[]; fallbackApplied: boolean }> {
    if (!this.chunkHydrator) {
      const rows = await (this.vectorSearch as VectorSearchPort).search(input);

      return {
        contexts: rows,
        fallbackApplied: false,
      };
    }

    const embeddingModel = input.embeddingModel ?? EMBEDDING_MODEL_DEFAULT;
    const candidates = await (this.vectorSearch as VectorIndexPort).search({
      workspaceId: input.workspaceId,
      queryEmbedding: input.queryEmbedding,
      queryEmbeddingDimensions: input.queryEmbeddingDimensions,
      topK: input.topK,
      similarityThreshold: input.similarityThreshold,
      embeddingModel,
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
      embeddingModel,
    });

    return {
      contexts: rows,
      fallbackApplied: false,
    };
  }
}

const resolveTemporalQueryMode = (input: QueryInterpretationStageResult): TemporalQueryMode => {
  const structured = input.rewrittenQuery.structuredResult;
  if (structured?.queryShape !== "event_date_lookup") {
    return "none";
  }
  return structured.temporalQueryMode ?? "none";
};

