import type {
  ResponseIntent,
  ResponseLanguagePolicy,
  RetrievalExecutionDiagnostics,
  RetrievalExecutionMetadata,
  RetrievalAnswerStrategySelection,
  RetrievalSubquery,
  TriggerAnalysisResult,
  TriggerBackoffDecision,
  RewriteStatus,
  RerankStatus,
} from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import { buildRetrievalAnswerSkillDiagnostic } from "./retrievalStrategySelector.js";
import type { SkillCallerSurface } from "../../skills/public.js";

const toCallerSurface = (execution?: RetrievalExecutionMetadata): SkillCallerSurface => {
  if (execution?.surface === "assistant") {
    return "assistant";
  }
  if (execution?.surface === "mcp_capability") {
    return "mcp";
  }
  return "retrieval_api";
};

export class RetrievalExecutionTelemetryService {
  constructor(private readonly telemetryService?: TelemetryService) {}

  async create(input: {
    workspaceId: string;
    execution?: RetrievalExecutionMetadata;
    strategySelection?: RetrievalAnswerStrategySelection;
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
    const fallbackApplied =
      input.candidateFallbackApplied || input.rewriteStatus === "fallback" || input.rerankStatus === "fallback";
    const candidateCounts = {
      semantic: input.originalCandidateCount + input.rewrittenCandidateCount,
      lexical: input.lexicalCandidateCount ?? 0,
      merged: input.normalizedCandidateCount,
      final: input.finalContextCount,
    };
    const skillDiagnostic = input.strategySelection
      ? buildRetrievalAnswerSkillDiagnostic(input.strategySelection, {
          callerSurface: toCallerSurface(input.execution),
          rerankStatus: input.rerankStatus,
          candidateCounts,
          fallbackApplied,
          supportStatus: "not_checked",
        })
      : undefined;
    const diagnostics = {
      ...input,
      skillDiagnostic,
      fallbackApplied,
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
        skillName: skillDiagnostic?.skillName,
        strategy: input.strategySelection?.strategy,
        queryShape: input.strategySelection?.queryShape,
        selectionMode: input.strategySelection?.selectionMode,
        selectionReason: input.strategySelection?.selectionReason,
      },
      tags: {
        rewrite_status: input.rewriteStatus,
        rerank_status: input.rerankStatus,
        response_intent: input.responseIntent ?? "unknown",
        fallback_applied: diagnostics.fallbackApplied ? "true" : "false",
        execution_surface: input.execution?.surface ?? "unknown",
        execution_path: input.execution?.path ?? "unknown",
        skill_name: skillDiagnostic?.skillName ?? "unknown",
        strategy: input.strategySelection?.strategy ?? "unknown",
        query_shape: input.strategySelection?.queryShape ?? "unknown",
        selection_mode: input.strategySelection?.selectionMode ?? "unknown",
      },
    });

    return diagnostics;
  }
}
