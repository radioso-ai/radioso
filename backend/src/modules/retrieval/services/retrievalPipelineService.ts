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
import { parseQueryConstraints } from "./queryConstraintParser.js";
import { AttributeMatchScoringService } from "./attributeMatchScoringService.js";
import type { RetrievedChunk, VectorSearchPort } from "../infra/vectorSearch.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import { HYBRID_RETRIEVAL_DEFAULTS } from "../domain/hybridRetrievalConfig.js";

export interface RetrievalPipelineResult {
  rewrittenQuery: string;
  contexts: import("../domain/retrievalPipelineTypes.js").FinalPromptContext[];
  prompt: string;
  citations: PromptBuildResult["citations"];
  responseSettings: {
    warmthLevel: number;
    citationDisplayEnabled: boolean;
  };
  diagnostics: RetrievalExecutionDiagnostics;
}

export class RetrievalPipelineService {
  constructor(
    private readonly retrievalSettingsService: RetrievalSettingsService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorSearch: VectorSearchPort,
    private readonly lexicalSearch: LexicalSearchPort,
    private readonly conversationContextService: ConversationContextService,
    private readonly queryRewriteService: QueryRewriteService,
    private readonly candidatePreparationService: CandidatePreparationService,
    private readonly attributeMatchScoringService: AttributeMatchScoringService,
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
    const originalParsedQuery = parseQueryConstraints(input.query);
    const originalSemanticQuery = originalParsedQuery.semanticQuery || input.query;
    const rewrittenQuery = await this.queryRewriteService.rewrite({
      query: input.query,
      contextWindow,
      enabled: settings.queryRewriteEnabled,
    });
    const parsedQuery = rewrittenQuery.rewriteApplied
      ? parseQueryConstraints(rewrittenQuery.effectiveQuery)
      : originalParsedQuery;
    const rewrittenSemanticQuery = parsedQuery.semanticQuery || rewrittenQuery.effectiveQuery;
    const lexicalQuery = parsedQuery.lexicalQuery || rewrittenQuery.effectiveQuery;
    const [originalEmbedding] = await this.embeddingService.embedChunks([originalSemanticQuery]);
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
      const [rewrittenEmbedding] = await this.embeddingService.embedChunks([rewrittenSemanticQuery]);
      rewrittenSearch = await this.searchWithFallback({
        accountId: input.accountId,
        queryEmbedding: rewrittenEmbedding ?? [],
        topK: settings.vectorTopK,
        similarityThreshold: settings.similarityThreshold,
      });
    }
    const rewrittenContexts = rewrittenSearch.contexts;
    const lexicalContexts = await this.lexicalSearch.search({
      accountId: input.accountId,
      query: lexicalQuery,
      topK: HYBRID_RETRIEVAL_DEFAULTS.lexicalTopK,
    });

    const normalizedCandidates = this.candidatePreparationService.prepare({
      original: originalContexts,
      rewritten: rewrittenContexts,
      lexical: lexicalContexts,
    });
    const mergedCandidates = normalizedCandidates.slice(0, HYBRID_RETRIEVAL_DEFAULTS.mergedCandidateCap);
    const scoredCandidates = this.attributeMatchScoringService.apply({
      candidates: mergedCandidates,
      parsedQuery,
      attributeControls: settings.attributeControls,
    });
    const reranked = await this.rerankService.rerank({
      query: rewrittenSemanticQuery,
      contexts: scoredCandidates.candidates,
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
      settings: {
        warmthLevel: settings.warmthLevel,
      },
      contexts,
    });
    const diagnostics = this.retrievalExecutionTelemetryService.create({
      rewriteStatus: rewrittenQuery.status,
      rerankStatus: reranked.status,
      originalCandidateCount: originalContexts.length,
      rewrittenCandidateCount: rewrittenContexts.length,
      lexicalCandidateCount: lexicalContexts.length,
      normalizedCandidateCount: scoredCandidates.candidates.length,
      finalContextCount: contexts.length,
      parsedQuery,
      appliedConstraints: scoredCandidates.appliedConstraints,
      candidateFallbackApplied: originalSearch.fallbackApplied || rewrittenSearch.fallbackApplied || scoredCandidates.fallbackApplied,
    });

    return {
      rewrittenQuery: rewrittenQuery.effectiveQuery,
      contexts,
      prompt: prompt.prompt,
      citations: prompt.citations,
      responseSettings: {
        warmthLevel: settings.warmthLevel,
        citationDisplayEnabled: settings.citationDisplayEnabled,
      },
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
