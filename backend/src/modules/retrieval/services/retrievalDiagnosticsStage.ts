import { RetrievalExecutionTelemetryService } from "./retrievalExecutionTelemetryService.js";
import type { PromptAssemblyStageResult, RetrievalDiagnosticsStage as RetrievalDiagnosticsStageContract } from "./retrievalPipelineStages.js";

export class RetrievalDiagnosticsStageService implements RetrievalDiagnosticsStageContract {
  constructor(private readonly retrievalExecutionTelemetryService: RetrievalExecutionTelemetryService) {}

  execute(input: PromptAssemblyStageResult) {
    return this.retrievalExecutionTelemetryService.create({
      rewriteStatus: input.rewrittenQuery.status,
      rerankStatus: input.rerankStatus,
      originalCandidateCount: input.originalContexts.length,
      rewrittenCandidateCount: input.rewrittenContexts.length,
      lexicalCandidateCount: input.lexicalContexts.length,
      normalizedCandidateCount: input.scoredCandidates.length,
      finalContextCount: input.contexts.length,
      queryEmbeddingDurationMs: input.activeEmbeddingDurationMs,
      parsedQuery: input.activeParsedQuery,
      appliedConstraints: input.appliedConstraints,
      candidateFallbackApplied: input.candidateFallbackApplied,
      rewriteEligible: input.rewrittenQuery.retrievalEligible,
      rewriteRan: input.rewrittenQuery.retrievalEligible && input.rewrittenQuery.effectiveQuery !== input.request.query,
      materialDisagreement: false,
      continuityDecision: input.continuityDecision,
      rewriteProposal: input.rewrittenQuery.structuredResult,
      rejectionReason: input.rewrittenQuery.rejectionReason,
    });
  }
}
