import type {
  ResponseLanguagePolicy,
  RetrievalExecutionDiagnostics,
  RetrievalExecutionMetadata,
  RetrievalAnswerShapeSelection,
  RetrievalSubquery,
  TriggerAnalysisResult,
  TriggerBackoffDecision,
  RewriteStatus,
  RerankStatus,
  TemporalQueryMode,
} from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import { buildRetrievalAnswerSkillDiagnostic } from "./retrievalShapeResolver.js";
import type { SkillCallerSurface } from "../../skills/public.js";
import {
  RETRIEVAL_TRACE_SPAN_NAMES,
  formatDegradedChannels,
  type DegradableRetrievalChannel,
  type TraceAttributes,
} from "./retrievalPipelineStages.js";

const traceActiveSpan = async <T>(
  name: string,
  attributes: TraceAttributes,
  run: () => Promise<T> | T,
): Promise<T> => traceOperation({ name, attributes, run });

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
    shapeSelection?: RetrievalAnswerShapeSelection;
    rewriteStatus: RewriteStatus;
    rerankStatus: RerankStatus;
    originalCandidateCount: number;
    rewrittenCandidateCount: number;
    lexicalCandidateCount?: number;
    temporalCandidateCount?: number;
    temporalQueryMode?: TemporalQueryMode;
    temporalStructuredLookupEnabled?: boolean;
    temporalDeterministicSortEnabled?: boolean;
    temporalDeterministicSortApplied?: boolean;
    temporalDeterministicSortToday?: string;
    temporalDeterministicSortDatedContextCount?: number;
    normalizedCandidateCount: number;
    finalContextCount: number;
    queryEmbeddingDurationMs?: number;
    semanticRetrievalDurationMs?: number;
    lexicalRetrievalDurationMs?: number;
    semanticRetrievalAvailability?: "available" | "degraded" | "unavailable";
    semanticRetrievalFailureReason?:
      | "query_embedding_unavailable"
      | "vector_search_unavailable"
      | null;
    degradedRetrievalChannels?: DegradableRetrievalChannel[];
    retrievalSkipped?: boolean;
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
      temporal: input.temporalCandidateCount ?? 0,
      merged: input.normalizedCandidateCount,
      final: input.finalContextCount,
    };
    const skillDiagnostic = input.shapeSelection
      ? buildRetrievalAnswerSkillDiagnostic(input.shapeSelection, {
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

    await traceActiveSpan(
      RETRIEVAL_TRACE_SPAN_NAMES.telemetry,
      buildRetrievalTelemetryTraceAttributes(input, diagnostics.fallbackApplied),
      () => this.telemetryService?.emit({
        eventType: "retrieval.pipeline.completed",
        correlation: {
          workspaceId: input.workspaceId,
        },
        metrics: {
          originalCandidateCount: input.originalCandidateCount,
          rewrittenCandidateCount: input.rewrittenCandidateCount,
          lexicalCandidateCount: input.lexicalCandidateCount ?? 0,
          temporalCandidateCount: input.temporalCandidateCount ?? 0,
          normalizedCandidateCount: input.normalizedCandidateCount,
          finalContextCount: input.finalContextCount,
          queryEmbeddingDurationMs: input.queryEmbeddingDurationMs ?? 0,
          semanticRetrievalDurationMs: input.semanticRetrievalDurationMs ?? 0,
          lexicalRetrievalDurationMs: input.lexicalRetrievalDurationMs ?? 0,
        },
        metadata: {
          appliedConstraintCount: input.appliedConstraints?.length ?? 0,
          retrievalSubqueryCount: input.retrievalSubqueries?.length ?? 0,
          rewriteEligible: input.rewriteEligible ?? false,
          rewriteRan: input.rewriteRan ?? false,
          retrievalSkipped: input.retrievalSkipped ?? false,
          rejectionReason: input.rejectionReason,
          fallbackReason: input.fallbackReason,
          triggerMatchCount: input.triggerAnalysis?.matchCount ?? 0,
          triggerBackoffApplied: input.triggerBackoff?.applied ?? false,
          temporalQueryMode: input.temporalQueryMode,
          temporalStructuredLookupEnabled: input.temporalStructuredLookupEnabled ?? false,
          temporalDeterministicSortEnabled: input.temporalDeterministicSortEnabled ?? false,
          temporalDeterministicSortApplied: input.temporalDeterministicSortApplied ?? false,
          temporalDeterministicSortDatedContextCount: input.temporalDeterministicSortDatedContextCount ?? 0,
          executionSurface: input.execution?.surface,
          executionPath: input.execution?.path,
          retrievalInvoked: input.execution?.retrievalInvoked ?? input.retrievalSkipped !== true,
          semanticRetrievalAvailability: input.semanticRetrievalAvailability,
          semanticRetrievalFailureReason: input.semanticRetrievalFailureReason,
          degradedRetrievalChannels: input.degradedRetrievalChannels,
          skillName: skillDiagnostic?.skillName,
          shapeName: input.shapeSelection?.shapeName,
          queryShape: input.shapeSelection?.queryShape,
          selectionMode: input.shapeSelection?.selectionMode,
          selectionReason: input.shapeSelection?.selectionReason,
        },
        tags: {
          rewrite_status: input.rewriteStatus,
          rerank_status: input.rerankStatus,
          fallback_applied: diagnostics.fallbackApplied ? "true" : "false",
          semantic_availability: input.semanticRetrievalAvailability ?? "unknown",
          semantic_failure_reason: input.semanticRetrievalFailureReason ?? "none",
          degraded_channels: formatDegradedChannels(input.degradedRetrievalChannels) ?? "unknown",
          execution_surface: input.execution?.surface ?? "unknown",
          execution_path: input.execution?.path ?? "unknown",
          skill_name: skillDiagnostic?.skillName ?? "unknown",
          shape_name: input.shapeSelection?.shapeName ?? "unknown",
          query_shape: input.shapeSelection?.queryShape ?? "unknown",
          selection_mode: input.shapeSelection?.selectionMode ?? "unknown",
        },
      }),
    );

    return diagnostics;
  }
}

const boundedTraceCount = (value: number | undefined): number =>
  Math.min(1_000, Math.max(0, value ?? 0));

const buildRetrievalTelemetryTraceAttributes = (
  input: Parameters<RetrievalExecutionTelemetryService["create"]>[0],
  fallbackApplied: boolean,
): TraceAttributes => ({
  "radioso.workspace_id": input.workspaceId,
  "retrieval.execution.surface": input.execution?.surface,
  "retrieval.execution.path": input.execution?.path,
  "retrieval.execution.invoked": input.execution?.retrievalInvoked ?? input.retrievalSkipped !== true,
  "retrieval.rewrite.status": input.rewriteStatus,
  "retrieval.rerank.status": input.rerankStatus,
  "retrieval.fallback.applied": fallbackApplied,
  "retrieval.semantic.availability": input.semanticRetrievalAvailability,
  "retrieval.semantic.failure_reason": input.semanticRetrievalFailureReason,
  "retrieval.degraded_channels": formatDegradedChannels(input.degradedRetrievalChannels),
  "retrieval.skipped": input.retrievalSkipped ?? false,
  "retrieval.candidates.semantic_original.count": boundedTraceCount(input.originalCandidateCount),
  "retrieval.candidates.semantic_rewritten.count": boundedTraceCount(input.rewrittenCandidateCount),
  "retrieval.candidates.lexical.count": boundedTraceCount(input.lexicalCandidateCount),
  "retrieval.candidates.temporal.count": boundedTraceCount(input.temporalCandidateCount),
  "retrieval.temporal.mode": input.temporalQueryMode,
  "retrieval.temporal.structured_lookup.enabled": input.temporalStructuredLookupEnabled,
  "retrieval.temporal.deterministic_sort.enabled": input.temporalDeterministicSortEnabled,
  "retrieval.temporal.deterministic_sort.applied": input.temporalDeterministicSortApplied,
  "retrieval.temporal.deterministic_sort.dated_context.count": boundedTraceCount(input.temporalDeterministicSortDatedContextCount),
  "retrieval.candidates.normalized.count": boundedTraceCount(input.normalizedCandidateCount),
  "retrieval.context.final.count": boundedTraceCount(input.finalContextCount),
  "retrieval.constraint.count": boundedTraceCount(input.appliedConstraints?.length),
  "retrieval.subquery.count": boundedTraceCount(input.retrievalSubqueries?.length),
});
