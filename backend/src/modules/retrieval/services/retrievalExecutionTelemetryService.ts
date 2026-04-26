import type {
  ResponseIntent,
  ResponseLanguagePolicy,
  RetrievalExecutionDiagnostics,
  RetrievalExecutionMetadata,
  RetrievalSubquery,
  TriggerAnalysisResult,
  TriggerBackoffDecision,
  RewriteStatus,
  RerankStatus,
} from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";

export class RetrievalExecutionTelemetryService {
  constructor(private readonly telemetryService?: TelemetryService) {}

  async create(input: {
    workspaceId: string;
    execution?: RetrievalExecutionMetadata;
    rewriteStatus: RewriteStatus;
    rerankStatus: RerankStatus;
    originalCandidateCount: number;
    rewrittenCandidateCount: number;
    lexicalCandidateCount?: number;
    normalizedCandidateCount: number;
    finalContextCount: number;
    queryEmbeddingDurationMs?: number;
    responseIntent?: ResponseIntent;
    retrievalSkipped?: boolean;
    intentConfidence?: number;
    intentFallbackApplied?: boolean;
    parsedQuery?: ParsedQueryInterpretation;
    appliedConstraints?: AppliedConstraint[];
    candidateFallbackApplied: boolean;
    rewriteEligible?: boolean;
    rewriteRan?: boolean;
    materialDisagreement?: boolean;
    continuityDecision?: import("../domain/retrievalPipelineTypes.js").ContinuityDecision;
    rewriteProposal?: import("../domain/retrievalPipelineTypes.js").StructuredRewriteResult;
    retrievalSubqueries?: RetrievalSubquery[];
    responseLanguagePolicy?: ResponseLanguagePolicy;
    rejectionReason?: string;
    fallbackReason?: string;
    triggerAnalysis?: TriggerAnalysisResult;
    triggerBackoff?: TriggerBackoffDecision;
  }): Promise<RetrievalExecutionDiagnostics> {
    const diagnostics = {
      ...input,
      fallbackApplied:
        input.candidateFallbackApplied || input.rewriteStatus === "fallback" || input.rerankStatus === "fallback",
    };

    await this.telemetryService?.emit({
      eventType: "retrieval.pipeline.completed",
      correlation: {
        workspaceId: input.workspaceId,
      },
      metrics: {
        originalCandidateCount: input.originalCandidateCount,
        rewrittenCandidateCount: input.rewrittenCandidateCount,
        lexicalCandidateCount: input.lexicalCandidateCount ?? 0,
        normalizedCandidateCount: input.normalizedCandidateCount,
        finalContextCount: input.finalContextCount,
        queryEmbeddingDurationMs: input.queryEmbeddingDurationMs ?? 0,
      },
      metadata: {
        appliedConstraintCount: input.appliedConstraints?.length ?? 0,
        retrievalSubqueryCount: input.retrievalSubqueries?.length ?? 0,
        rewriteEligible: input.rewriteEligible ?? false,
        rewriteRan: input.rewriteRan ?? false,
        responseIntent: input.responseIntent,
        retrievalSkipped: input.retrievalSkipped ?? false,
        rejectionReason: input.rejectionReason,
        fallbackReason: input.fallbackReason,
        triggerMatchCount: input.triggerAnalysis?.matchCount ?? 0,
        triggerBackoffApplied: input.triggerBackoff?.applied ?? false,
        executionSurface: input.execution?.surface,
        executionPath: input.execution?.path,
        retrievalInvoked: input.execution?.retrievalInvoked ?? input.retrievalSkipped !== true,
      },
      tags: {
        rewrite_status: input.rewriteStatus,
        rerank_status: input.rerankStatus,
        response_intent: input.responseIntent ?? "unknown",
        fallback_applied: diagnostics.fallbackApplied ? "true" : "false",
        execution_surface: input.execution?.surface ?? "unknown",
        execution_path: input.execution?.path ?? "unknown",
      },
    });

    return diagnostics;
  }
}
