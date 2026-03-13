import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsService } from "../../settings/services/retrievalSettingsService.js";
import type { EmbeddingService } from "./embeddingService.js";
import type { PromptBuildResult } from "./promptBuilder.js";
import { PromptBuilder } from "./promptBuilder.js";
import { CandidatePreparationService } from "./candidatePreparationService.js";
import { ConversationContextService } from "./conversationContextService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import { RerankService } from "./rerankService.js";
import { RetrievalExecutionTelemetryService } from "./retrievalExecutionTelemetryService.js";
import type { RetrievalExecutionDiagnostics } from "../domain/retrievalPipelineTypes.js";
import type { RetrievedChunk, VectorSearchPort } from "../infra/vectorSearch.js";

export interface RetrievalPipelineResult {
  rewrittenQuery: string;
  contexts: import("../domain/retrievalPipelineTypes.js").FinalPromptContext[];
  prompt: string;
  citations: PromptBuildResult["citations"];
  diagnostics: RetrievalExecutionDiagnostics;
}

export class RetrievalPipelineService {
  constructor(
    private readonly retrievalSettingsService: RetrievalSettingsService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorSearch: VectorSearchPort,
    private readonly conversationContextService: ConversationContextService,
    private readonly queryRewriteService: QueryRewriteService,
    private readonly candidatePreparationService: CandidatePreparationService,
    private readonly rerankService: RerankService,
    private readonly promptContextSelectorService: PromptContextSelectorService,
    private readonly promptBuilder: PromptBuilder,
    private readonly retrievalExecutionTelemetryService: RetrievalExecutionTelemetryService,
  ) {}

  async run(input: {
    accountId: string;
    query: string;
    history: MessageRecord[];
  }): Promise<RetrievalPipelineResult> {
    const settings = await this.retrievalSettingsService.getForAccount(input.accountId);
    const contextWindow = this.conversationContextService.select({
      history: input.history,
      query: input.query,
    });
    const rewrittenQuery = await this.queryRewriteService.rewrite({
      query: input.query,
      contextWindow,
      enabled: settings.queryRewriteEnabled,
    });
    const [originalEmbedding] = await this.embeddingService.embedChunks([input.query]);
    const originalSearch = await this.searchWithFallback({
      accountId: input.accountId,
      queryEmbedding: originalEmbedding ?? [],
      topK: settings.vectorTopK,
      similarityThreshold: settings.similarityThreshold,
    });
    const originalContexts = originalSearch.contexts;

    let rewrittenSearch: { contexts: RetrievedChunk[]; fallbackApplied: boolean } = {
      contexts: [],
      fallbackApplied: false,
    };
    if (rewrittenQuery.rewriteApplied && rewrittenQuery.effectiveQuery !== input.query) {
      const [rewrittenEmbedding] = await this.embeddingService.embedChunks([rewrittenQuery.effectiveQuery]);
      rewrittenSearch = await this.searchWithFallback({
        accountId: input.accountId,
        queryEmbedding: rewrittenEmbedding ?? [],
        topK: settings.vectorTopK,
        similarityThreshold: settings.similarityThreshold,
      });
    }
    const rewrittenContexts = rewrittenSearch.contexts;

    const normalizedCandidates = this.candidatePreparationService.prepare({
      original: originalContexts,
      rewritten: rewrittenContexts,
    });
    const reranked = await this.rerankService.rerank({
      query: rewrittenQuery.effectiveQuery,
      contexts: normalizedCandidates,
      enabled: settings.rerankEnabled,
      topK: settings.rerankTopK,
    });
    const contexts = this.promptContextSelectorService.select({
      contexts: reranked.contexts,
      topK: settings.rerankTopK,
    });
    const prompt = this.promptBuilder.build({
      query: input.query,
      history: input.history,
      contexts,
    });
    const diagnostics = this.retrievalExecutionTelemetryService.create({
      rewriteStatus: rewrittenQuery.status,
      rerankStatus: reranked.status,
      originalCandidateCount: originalContexts.length,
      rewrittenCandidateCount: rewrittenContexts.length,
      normalizedCandidateCount: normalizedCandidates.length,
      finalContextCount: contexts.length,
      candidateFallbackApplied: originalSearch.fallbackApplied || rewrittenSearch.fallbackApplied,
    });

    return {
      rewrittenQuery: rewrittenQuery.effectiveQuery,
      contexts,
      prompt: prompt.prompt,
      citations: prompt.citations,
      diagnostics,
    };
  }

  private async searchWithFallback(input: {
    accountId: string;
    queryEmbedding: number[];
    topK: number;
    similarityThreshold: number;
  }): Promise<{ contexts: RetrievedChunk[]; fallbackApplied: boolean }> {
    const rows = await this.vectorSearch.search({
      accountId: input.accountId,
      queryEmbedding: input.queryEmbedding,
      topK: input.topK,
      similarityThreshold: input.similarityThreshold,
    });

    return {
      contexts: rows,
      fallbackApplied: false,
    };
  }
}
