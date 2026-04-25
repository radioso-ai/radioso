import { RetrievalExecutionTelemetryService } from "./retrievalExecutionTelemetryService.js";
import type { PromptAssemblyStageResult, RetrievalDiagnosticsStage as RetrievalDiagnosticsStageContract } from "./retrievalPipelineStages.js";

export class RetrievalDiagnosticsStageService implements RetrievalDiagnosticsStageContract {
  constructor(private readonly retrievalExecutionTelemetryService: RetrievalExecutionTelemetryService) {}

  async execute(input: PromptAssemblyStageResult) {
    return this.retrievalExecutionTelemetryService.create({
      workspaceId: input.request.workspaceId,
      rewriteStatus: input.rewrittenQuery.status,
      rerankStatus: input.rerankStatus,
      originalCandidateCount: input.originalContexts.length,
      rewrittenCandidateCount: input.rewrittenContexts.length,
      lexicalCandidateCount: input.lexicalContexts.length,
      normalizedCandidateCount: input.scoredCandidates.length,
      finalContextCount: input.contexts.length,
      queryEmbeddingDurationMs: input.activeEmbeddingDurationMs,
      responseIntent: input.responseIntent,
      retrievalSkipped: false,
      intentConfidence: input.rewrittenQuery.confidence,
      intentFallbackApplied: input.rewrittenQuery.status === "fallback",
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
