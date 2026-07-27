import { RetrievalExecutionTelemetryService } from "./retrievalExecutionTelemetryService.js";
import type { PromptAssemblyStageResult, RetrievalDiagnosticsStage as RetrievalDiagnosticsStageContract } from "./retrievalPipelineStages.js";

export class RetrievalDiagnosticsStageService implements RetrievalDiagnosticsStageContract {
  constructor(private readonly retrievalExecutionTelemetryService: RetrievalExecutionTelemetryService) {}

  async execute(input: PromptAssemblyStageResult) {
    return this.retrievalExecutionTelemetryService.create({
      workspaceId: input.request.workspaceId,
      execution: input.request.execution,
      shapeSelection: input.shapeSelection,
      rewriteStatus: input.rewrittenQuery.status,
      rerankStatus: input.rerankStatus,
      originalCandidateCount: input.originalContexts.length,
      rewrittenCandidateCount: input.rewrittenContexts.length,
      lexicalCandidateCount: input.lexicalContexts.length,
      temporalCandidateCount: input.temporalContexts?.length ?? 0,
      temporalQueryMode: input.temporalQueryMode ?? "none",
      temporalStructuredLookupEnabled: input.temporalStructuredLookupEnabled ?? true,
      temporalDeterministicSortEnabled: input.temporalDeterministicSortEnabled ?? true,
      temporalDeterministicSortApplied: input.temporalDeterministicSortApplied ?? false,
      temporalDeterministicSortToday: input.temporalDeterministicSortToday,
      temporalDeterministicSortDatedContextCount: input.temporalDeterministicSortDatedContextCount ?? 0,
      normalizedCandidateCount: input.scoredCandidates.length,
      finalContextCount: input.contexts.length,
      queryEmbeddingDurationMs: input.activeEmbeddingDurationMs,
      semanticRetrievalAvailability: input.semanticRetrievalAvailability,
      semanticRetrievalFailureReason: input.semanticRetrievalFailureReason,
      retrievalSkipped: false,
      parsedQuery: input.activeParsedQuery,
      appliedConstraints: input.appliedConstraints,
      candidateFallbackApplied: input.candidateFallbackApplied,
      rewriteEligible: input.rewrittenQuery.retrievalEligible,
      rewriteRan: input.rewrittenQuery.status !== "skipped",
      materialDisagreement: false,
      continuityDecision: input.continuityDecision,
      rewriteProposal: input.rewrittenQuery.structuredResult,
      retrievalSubqueries: input.activeRetrievalSubqueries,
      responseLanguagePolicy: input.rewrittenQuery.responseLanguagePolicy,
      rejectionReason: input.rewrittenQuery.rejectionReason,
      fallbackReason: input.rewrittenQuery.fallbackReason,
      triggerAnalysis: input.triggerAnalysis,
      triggerBackoff: input.triggerBackoff,
    });
  }
}
