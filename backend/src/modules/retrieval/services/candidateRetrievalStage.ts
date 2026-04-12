import type { EmbeddingService } from "./embeddingService.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import type { RetrievedChunk, VectorSearchPort } from "../infra/vectorSearch.js";
import { HYBRID_RETRIEVAL_DEFAULTS } from "../domain/hybridRetrievalConfig.js";
import type { CandidateRetrievalStage as CandidateRetrievalStageContract, QueryInterpretationStageResult } from "./retrievalPipelineStages.js";

export class CandidateRetrievalStageService implements CandidateRetrievalStageContract {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorSearch: VectorSearchPort,
    private readonly lexicalSearch: LexicalSearchPort,
  ) {}

  async execute(input: QueryInterpretationStageResult) {
    const embeddingStartedAt = Date.now();
    const semanticQueries = input.activeRetrievalSubqueries.map((subquery) => subquery.semanticQuery);
    const embeddings = await this.embeddingService.embedChunks(semanticQueries);
    const activeEmbeddingDurationMs = Math.max(0, Date.now() - embeddingStartedAt);
    const retrievalBranches = await Promise.all(
      input.activeRetrievalSubqueries.map(async (subquery, index) => {
        const [semanticSearch, lexicalContexts] = await Promise.all([
          this.searchWithFallback({
            workspaceId: input.request.workspaceId,
            queryEmbedding: embeddings[index] ?? [],
            topK: input.settings.vectorTopK,
            similarityThreshold: input.settings.similarityThreshold,
            metadataFilter: input.request.metadataFilter,
          }),
          this.lexicalSearch.search({
            workspaceId: input.request.workspaceId,
            query: subquery.lexicalQuery,
            topK: HYBRID_RETRIEVAL_DEFAULTS.lexicalTopK,
            metadataFilter: input.request.metadataFilter,
          }),
        ]);

        return {
          subqueryId: subquery.id,
          label: subquery.label,
          semanticQuery: subquery.semanticQuery,
          lexicalQuery: subquery.lexicalQuery,
          reason: subquery.reason,
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
      activeEmbedding: embeddings[0] ?? [],
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
    metadataFilter?: Record<string, unknown>;
  }): Promise<{ contexts: RetrievedChunk[]; fallbackApplied: boolean }> {
    const rows = await this.vectorSearch.search(input);

    return {
      contexts: rows,
      fallbackApplied: false,
    };
  }
}
