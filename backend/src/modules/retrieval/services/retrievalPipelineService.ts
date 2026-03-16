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
import type { ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import type { AttributeFamilyControl } from "../../settings/domain/retrievalSettings.js";
import { EntityQueryIntentService } from "./entityQueryIntentService.js";
import { EntityIntegrityService } from "./entityIntegrityService.js";

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
  entityIntegrity: {
    mode: "generic" | "comparison" | "correction";
    ambiguityDetected: boolean;
    selectedSubjects: string[];
  };
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
    private readonly entityQueryIntentService: EntityQueryIntentService = new EntityQueryIntentService(),
    private readonly entityIntegrityService: EntityIntegrityService = new EntityIntegrityService(),
  ) {}

  async run(input: {
    accountId: string;
    query: string;
    history: MessageRecord[];
  }): Promise<RetrievalPipelineResult> {
    const settings = await this.retrievalSettingsService.getForAccount(input.accountId);
    const entityIntent = this.entityQueryIntentService.interpret({
      query: input.query,
      history: input.history,
    });
    const contextWindow = this.conversationContextService.select({
      history: input.history,
      query: input.query,
    });
    const originalParsedQuery = parseQueryConstraints(input.query);
    const originalPreparedQuery = this.applyAttributeControlsToQuery(
      originalParsedQuery,
      settings.attributeControls,
    );
    const originalSemanticQuery = originalPreparedQuery.semanticQuery || input.query;
    const rewrittenQuery = await this.queryRewriteService.rewrite({
      query: input.query,
      contextWindow,
      enabled: settings.queryRewriteEnabled,
    });
    const rewrittenParsedQuery = rewrittenQuery.rewriteApplied
      ? parseQueryConstraints(rewrittenQuery.effectiveQuery)
      : originalParsedQuery;
    const parsedQuery = this.applyAttributeControlsToQuery(
      rewrittenQuery.rewriteApplied
        ? this.mergeParsedQueries(originalParsedQuery, rewrittenParsedQuery)
        : rewrittenParsedQuery,
      settings.attributeControls,
    );
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
    const guardedCandidates = this.entityIntegrityService.applyCandidateGuards({
      candidates: normalizedCandidates,
      query: input.query,
      history: input.history,
      intent: entityIntent,
    });
    const mergedCandidates = guardedCandidates.slice(0, HYBRID_RETRIEVAL_DEFAULTS.mergedCandidateCap);
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
    const resolvedContexts = this.entityIntegrityService.resolveContexts({
      contexts: reranked.contexts,
      query: input.query,
      history: input.history,
      intent: entityIntent,
      topK: settings.rerankTopK,
    });
    const contexts = this.promptContextSelectorService.select({
      contexts: resolvedContexts.contexts,
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
      entityAmbiguityDetected: resolvedContexts.ambiguityDetected,
      selectedSubjects: resolvedContexts.selectedSubjects,
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
      entityIntegrity: {
        mode: entityIntent.mode,
        ambiguityDetected: resolvedContexts.ambiguityDetected,
        selectedSubjects: resolvedContexts.selectedSubjects,
      },
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

  private applyAttributeControlsToQuery(
    parsedQuery: ParsedQueryInterpretation,
    attributeControls: AttributeFamilyControl[],
  ): ParsedQueryInterpretation {
    const hardFilterFamilies = new Set(
      attributeControls
        .filter((control) => control.enabled && control.mode === "hard_filter")
        .map((control) => control.family),
    );

    return {
      ...parsedQuery,
      semanticQuery: this.stripEnabledConstraintLiterals(parsedQuery.semanticQuery, parsedQuery, hardFilterFamilies),
      lexicalQuery: this.stripEnabledConstraintLiterals(parsedQuery.lexicalQuery, parsedQuery, hardFilterFamilies),
    };
  }

  private mergeParsedQueries(
    originalParsedQuery: ParsedQueryInterpretation,
    rewrittenParsedQuery: ParsedQueryInterpretation,
  ): ParsedQueryInterpretation {
    const seenConstraintKeys = new Set<string>();
    const constraints = [...originalParsedQuery.constraints, ...rewrittenParsedQuery.constraints].filter((constraint) => {
      const key = JSON.stringify({
        family: constraint.family,
        operator: constraint.operator,
        summary: constraint.summary,
        value: constraint.value,
      });
      if (seenConstraintKeys.has(key)) {
        return false;
      }
      seenConstraintKeys.add(key);
      return true;
    });

    return {
      semanticQuery: rewrittenParsedQuery.semanticQuery,
      lexicalQuery: rewrittenParsedQuery.lexicalQuery,
      constraints,
    };
  }

  private stripEnabledConstraintLiterals(
    query: string,
    parsedQuery: ParsedQueryInterpretation,
    enabledFamilies: Set<AttributeFamilyControl["family"]>,
  ): string {
    const stripped = parsedQuery.constraints
      .filter((constraint) => enabledFamilies.has(constraint.family))
      .reduce((value, constraint) => {
        if (!constraint.sourceText) {
          return value;
        }

        const escaped = constraint.sourceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return value.replace(new RegExp(`\\b${escaped}\\b`, "i"), " ");
      }, query)
      .replace(/\s+/g, " ")
      .trim();

    return stripped || query;
  }
}
