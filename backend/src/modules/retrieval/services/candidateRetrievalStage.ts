import type { EmbeddingService } from "./embeddingService.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { deriveLexicalQueryPlan } from "../domain/lexicalQueryPlan.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import type { RetrievedChunk, VectorSearchPort } from "../infra/vectorSearch.js";
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
    const uniqueSemanticQueries = [...new Set(semanticQueries)];
    const embeddings = await this.embeddingService.embedChunks(uniqueSemanticQueries);
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
          metadataFilter: input.request.metadataFilter,
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
            lexicalPlan: subquery.reason === "lexical_alternative" ? deriveLexicalQueryPlan(subquery.lexicalQuery) : undefined,
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
    metadataFilter?: Record<string, unknown>;
  }): Promise<{ contexts: RetrievedChunk[]; fallbackApplied: boolean }> {
    const rows = await this.vectorSearch.search(input);

    return {
      contexts: rows,
      fallbackApplied: false,
    };
  }
}
