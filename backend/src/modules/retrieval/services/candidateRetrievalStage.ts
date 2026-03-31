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
    const [activeEmbedding] = await this.embeddingService.embedChunks([input.activeSemanticQuery]);
    const activeEmbeddingDurationMs = Math.max(0, Date.now() - embeddingStartedAt);
    const [activeSearch, lexicalContexts] = await Promise.all([
      this.searchWithFallback({
        workspaceId: input.request.workspaceId,
        queryEmbedding: activeEmbedding ?? [],
        topK: input.settings.vectorTopK,
        similarityThreshold: input.settings.similarityThreshold,
        metadataFilter: input.request.metadataFilter,
      }),
      this.lexicalSearch.search({
        workspaceId: input.request.workspaceId,
        query: input.activeParsedQuery.lexicalQuery || input.activeQuery,
        topK: HYBRID_RETRIEVAL_DEFAULTS.lexicalTopK,
        metadataFilter: input.request.metadataFilter,
      }),
    ]);

    const originalContexts = input.rewrittenQuery.retrievalEligible ? [] : activeSearch.contexts;
    const rewrittenContexts = input.rewrittenQuery.retrievalEligible ? activeSearch.contexts : [];

    return {
      ...input,
      activeEmbedding: activeEmbedding ?? [],
      activeEmbeddingDurationMs,
      originalContexts,
      rewrittenContexts,
      lexicalContexts,
      vectorFallbackApplied: activeSearch.fallbackApplied,
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
