import type { AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
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
import type { SubjectReference, SubjectReuseState } from "../domain/retrievalPipelineTypes.js";
import { SubjectConvergenceService } from "./subjectConvergenceService.js";
import { SubjectContinuityService } from "./subjectContinuityService.js";
import { extractSubjectLabel, normalizeIdentityPhrase } from "./subjectIdentityService.js";

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
    private readonly auditEventRepository?: AuditEventRepositoryPort,
    private readonly subjectConvergenceService: SubjectConvergenceService = new SubjectConvergenceService(),
    private readonly subjectContinuityService: SubjectContinuityService = new SubjectContinuityService(),
  ) {}

  async run(input: {
    accountId: string;
    query: string;
    history: MessageRecord[];
    conversationId?: string;
  }): Promise<RetrievalPipelineResult> {
    const settings = await this.retrievalSettingsService.getForAccount(input.accountId);
    const contextWindow = this.conversationContextService.select({
      history: input.history,
      query: input.query,
    });
    const previousState = await this.loadPreviousSubjectState(input.accountId, input.conversationId);
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
      carriedSubject: previousState?.resolvedSubject,
      selfContained: this.isSelfContained(input.query, previousState?.resolvedSubject),
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
    const rawConvergence = this.subjectConvergenceService.evaluate({
      candidates: this.toConvergenceCandidates(originalContexts),
      comparative: this.isComparativeQuery(input.query),
    });
    const biasedConvergence = this.subjectConvergenceService.evaluate({
      candidates: this.toConvergenceCandidates(rewrittenContexts),
      comparative: this.isComparativeQuery(input.query),
    });
    const continuity = this.subjectContinuityService.decide({
      previous: previousState,
      raw: {
        ...rawConvergence,
        agreementAcrossPaths:
          Boolean(rawConvergence.winningSubject && biasedConvergence.winningSubject) &&
          rawConvergence.winningSubject?.normalizedKey === biasedConvergence.winningSubject?.normalizedKey,
      },
      biased: {
        ...biasedConvergence,
        agreementAcrossPaths:
          Boolean(rawConvergence.winningSubject && biasedConvergence.winningSubject) &&
          rawConvergence.winningSubject?.normalizedKey === biasedConvergence.winningSubject?.normalizedKey,
      },
      explicitCurrentSubject: this.detectExplicitCurrentSubject(input.query, rawConvergence, biasedConvergence),
      selfContained: this.isSelfContained(input.query, previousState?.resolvedSubject),
      turnId: `${Date.now()}`,
    });
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
    const continuityFilteredContexts =
      continuity.resolvedSubject && ["reused", "newly_established", "replaced"].includes(continuity.resolutionOutcome)
        ? reranked.contexts.filter((context) => {
            const subjectLabel =
              context.subjectLabel ??
              extractSubjectLabel(context.retrievalText) ??
              extractSubjectLabel(context.content);
            return subjectLabel
              ? normalizeIdentityPhrase(subjectLabel) === continuity.resolvedSubject?.normalizedKey
              : false;
          })
        : reranked.contexts;
    const contexts = this.promptContextSelectorService.select({
      contexts: continuityFilteredContexts.length > 0 ? continuityFilteredContexts : reranked.contexts,
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
      continuity: {
        subjectReuseOutcome: continuity.resolutionOutcome,
        winningSubject: continuity.resolvedSubject,
        runnerUpSubject: continuity.resolutionEvidence.runnerUpSubject,
        rawPathWinningSubject: rawConvergence.winningSubject,
        biasedPathWinningSubject: biasedConvergence.winningSubject,
        supportCount: continuity.resolutionEvidence.supportCount,
        scoreMass: continuity.resolutionEvidence.scoreMass,
        winnerMargin: continuity.resolutionEvidence.winnerMargin,
        agreementAcrossPaths:
          Boolean(rawConvergence.winningSubject && biasedConvergence.winningSubject) &&
          rawConvergence.winningSubject?.normalizedKey === biasedConvergence.winningSubject?.normalizedKey,
        disagreementDetected:
          Boolean(rawConvergence.winningSubject && biasedConvergence.winningSubject) &&
          rawConvergence.winningSubject?.normalizedKey !== biasedConvergence.winningSubject?.normalizedKey,
      },
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

  private async loadPreviousSubjectState(
    accountId: string,
    conversationId?: string,
  ): Promise<SubjectReuseState | null> {
    if (!conversationId || !this.auditEventRepository) {
      return null;
    }

    const events = await this.auditEventRepository.listChatAnswerEventsByConversationId(accountId, conversationId);
    const latest = [...events]
      .reverse()
      .find((event) => event.eventStatus === "success" && event.metadata.retrieval && typeof event.metadata.retrieval === "object");

    const continuity = latest?.metadata.retrieval &&
      typeof latest.metadata.retrieval === "object" &&
      "continuity" in latest.metadata.retrieval
      ? (latest.metadata.retrieval.continuity as { winningSubject?: SubjectReference | null; subjectReuseOutcome?: SubjectReuseState["resolutionOutcome"] } | undefined)
      : undefined;

    if (!continuity?.winningSubject || !continuity.subjectReuseOutcome) {
      return null;
    }

    return {
      resolvedSubject: continuity.winningSubject,
      resolutionOutcome: continuity.subjectReuseOutcome,
      resolutionConfidence: 1,
      resolutionSourceTurnId: latest?.id ?? "previous-turn",
      resolutionEvidence: {
        winningSubject: continuity.winningSubject,
        runnerUpSubject: null,
        supportCount: 1,
        scoreMass: 1,
        runnerUpScoreMass: 0,
        winnerMargin: 1,
        agreementAcrossPaths: true,
        isComparative: false,
        isAmbiguous: false,
      },
      stateVersion: 1,
    };
  }

  private toConvergenceCandidates(
    contexts: RetrievedChunk[],
  ): Array<Pick<import("../domain/retrievalPipelineTypes.js").RetrievedCandidate, "subjectLabel" | "similarity">> {
    return contexts.map((context) => ({
      subjectLabel: extractSubjectLabel(context.searchText) ?? extractSubjectLabel(context.content),
      similarity: context.similarity,
    }));
  }

  private detectExplicitCurrentSubject(
    query: string,
    raw: { winningSubject: SubjectReference | null; runnerUpSubject: SubjectReference | null },
    biased: { winningSubject: SubjectReference | null; runnerUpSubject: SubjectReference | null },
  ): SubjectReference | null {
    const normalizedQuery = normalizeIdentityPhrase(query);
    const subjects = [raw.winningSubject, raw.runnerUpSubject, biased.winningSubject, biased.runnerUpSubject].filter(
      (value): value is SubjectReference => Boolean(value),
    );
    return subjects.find((subject) => normalizedQuery.includes(subject.normalizedKey)) ?? null;
  }

  private isComparativeQuery(query: string): boolean {
    return /\b(compare|versus|vs\b|and\b)\b/i.test(query);
  }

  private isSelfContained(query: string, carriedSubject?: SubjectReference | null): boolean {
    if (!carriedSubject) {
      return true;
    }

    const normalizedQuery = normalizeIdentityPhrase(query);
    if (normalizedQuery.includes(carriedSubject.normalizedKey)) {
      return true;
    }

    return normalizedQuery.split(" ").length >= 7;
  }
}
