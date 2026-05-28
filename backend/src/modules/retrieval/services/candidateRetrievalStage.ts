import type { EmbeddingService } from "./embeddingService.js";
import type { IngestionSettingsRecord } from "../../settings/contracts/ingestion.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { RetrievedChunk, VectorSearchPort } from "../domain/vectorSearch.js";
import type { CandidateRetrievalStage as CandidateRetrievalStageContract, QueryInterpretationStageResult } from "./retrievalPipelineStages.js";

export interface IngestionSettingsReaderPort {
  getForWorkspace(workspaceId: string): Promise<IngestionSettingsRecord>;
}

export class CandidateRetrievalStageService implements CandidateRetrievalStageContract {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorSearch: VectorSearchPort,
    private readonly lexicalSearch: LexicalSearchPort,
    private readonly ingestionSettingsService?: IngestionSettingsReaderPort,
  ) {}

  async execute(input: QueryInterpretationStageResult) {
    const embeddingStartedAt = Date.now();
    const sourceFilter = input.request.sourceFilter;
    const semanticQueries = input.activeRetrievalSubqueries.map((subquery) => subquery.semanticQuery);
    const uniqueSemanticQueries = [...new Set(semanticQueries)];
    const ingestionSettings = await this.ingestionSettingsService?.getForWorkspace(input.request.workspaceId);
    const embeddingModel = ingestionSettings?.embeddingModel;
    const embeddings = await this.embeddingService.embedChunks(uniqueSemanticQueries, {
      model: embeddingModel,
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
          topK: input.settings.vectorTopK,
          similarityThreshold: input.settings.similarityThreshold,
          embeddingModel,
          metadataFilter: input.request.metadataFilter,
          sourceFilter,
        }),
      ] as const),
    );
    const retrievalBranches = await Promise.all(
      input.activeRetrievalSubqueries.map(async (subquery) => {
        const [semanticSearch, lexicalContexts] = await Promise.all([
          semanticSearchByQuery.get(subquery.semanticQuery) ?? Promise.resolve({ contexts: [], fallbackApplied: true }),
          this.lexicalSearch.search({
            workspaceId: input.request.workspaceId,
            query: subquery.lexicalQuery,
            topK: RETRIEVAL_BEHAVIOR.hybrid.lexicalTopK,
            metadataFilter: input.request.metadataFilter,
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

    return {
      ...input,
      activeEmbedding: embeddingBySemanticQuery.get(input.activeRetrievalSubqueries[0]?.semanticQuery ?? "") ?? [],
      activeEmbeddingDurationMs,
      originalContexts,
      rewrittenContexts,
      lexicalContexts,
      retrievalBranches: retrievalBranches.map(({ fallbackApplied: _fallbackApplied, ...branch }) => branch),
      vectorFallbackApplied: retrievalBranches.some((branch) => branch.fallbackApplied),
    };
  }

  private async searchWithFallback(input: {
    workspaceId: string;
    queryEmbedding: number[];
    topK: number;
    similarityThreshold: number;
    embeddingModel?: string;
    metadataFilter?: Record<string, unknown>;
    sourceFilter?: RetrievalSourceFilter;
  }): Promise<{ contexts: RetrievedChunk[]; fallbackApplied: boolean }> {
    const rows = await this.vectorSearch.search(input);

    return {
      contexts: rows,
      fallbackApplied: false,
    };
  }
}
