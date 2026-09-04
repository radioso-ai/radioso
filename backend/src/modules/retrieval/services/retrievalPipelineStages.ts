import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { AgenticRetrievalToolFactory } from "./agenticRetrievalRunner.js";
import type { RetrievalResponseBehavior } from "../public.js";
import type {
  ConversationContextWindow,
  RetrievalSubquery,
  ResponseLanguagePolicy,
  RewrittenRetrievalQuery,
  RetrievalAnswerShapeSelection,
  RetrievalExecutionMetadata,
  StructuredRewriteResult,
  TemporalQueryMode,
  TriggerAnalysisResult,
  TriggerBackoffDecision,
} from "../domain/retrievalPipelineTypes.js";
import type { AppliedConstraint, ParsedQueryInterpretation } from "../domain/queryConstraintTypes.js";
import type { RetrievalSourceFilter, RetrievalSourceScope } from "../domain/retrievalSourceFilter.js";
import type { RetrievedChunk } from "../domain/vectorSearch.js";
import type { PromptBuildResult } from "./promptBuilder.js";

export interface RetrievalPipelineRequest {
  workspaceId: string;
  query: string;
  history: MessageRecord[];
  responseIdentity?: ResponseIdentity | null;
  responseBehaviorEnabled?: boolean;
  responseBehavior?: RetrievalResponseBehavior;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  responseLanguage?: string;
  metadataFilter?: Record<string, unknown>;
  documentScope?: string[];
  sourceScope?: RetrievalSourceScope;
  sourceFilter?: RetrievalSourceFilter;
  execution?: RetrievalExecutionMetadata;
  usageContext?: Omit<ModelCallUsageContext, "operation">;
  agentSkillSettings?: Record<string, unknown>;
  agenticToolFactories?: ReadonlyArray<AgenticRetrievalToolFactory>;
  retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  precomputedRewriteProposal?: StructuredRewriteResult;
}

export interface RetrievalContextStageResult {
  request: RetrievalPipelineRequest;
  settings: RetrievalSettingsRecord;
  contextWindow: ConversationContextWindow;
}

export interface QueryInterpretationStageResult extends RetrievalContextStageResult {
  interpretationSource?: "query_interpretation" | "turn_interpretation";
  originalParsedQuery: ParsedQueryInterpretation;
  originalPreparedQuery: ParsedQueryInterpretation;
  rewrittenQuery: RewrittenRetrievalQuery;
  activeQuery: string;
  activeParsedQuery: ParsedQueryInterpretation;
  activeSemanticQuery: string;
  activeRetrievalSubqueries: RetrievalSubquery[];
  triggerAnalysis: TriggerAnalysisResult;
  promptHistory: MessageRecord[];
  promptHistoryReset: boolean;
  continuityDecision: "unchanged" | "updated" | "unresolved" | "rejected";
  shapeSelection?: RetrievalAnswerShapeSelection;
}

export interface RetrievalBranchResult {
  subqueryId: string;
  label: string;
  semanticQuery: string;
  lexicalQuery: string;
  reason?: string;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  source: "original" | "rewritten";
  // Whether a semantic search ran for this branch's semantic query this turn.
  // False only for branches dropped by the per-turn distinct-semantic cap, which
  // are lexical-only. Branches that share an already-searched semantic query are
  // true and reuse that search's contexts (the trace deduplicates by query). The
  // trace uses this to avoid reporting a semantic search that did not happen.
  semanticSearched: boolean;
  semanticContexts: RetrievedChunk[];
  lexicalContexts: RetrievedChunk[];
}

export type SemanticRetrievalAvailability =
  | "available"
  | "degraded"
  | "unavailable";

export type SemanticRetrievalFailureReason =
  | "query_embedding_unavailable"
  | "vector_search_unavailable";

// Retrieval channels that degrade to empty instead of failing the turn. Semantic
// degradation is reported separately because it carries a failure reason and a
// three-valued availability; these channels are simply present or absent.
export type DegradableRetrievalChannel = "lexical" | "temporal";

export const DEGRADABLE_RETRIEVAL_CHANNELS: readonly DegradableRetrievalChannel[] = [
  "lexical",
  "temporal",
];

export interface CandidateRetrievalStageResult extends QueryInterpretationStageResult {
  activeEmbedding: number[];
  activeEmbeddingDurationMs: number;
  // Measured per branch, not derived from the enclosing stage: the branches overlap,
  // so these spans can start at different times and can sum past the stage duration.
  semanticRetrievalStartedAtMs?: number;
  semanticRetrievalDurationMs?: number;
  lexicalRetrievalStartedAtMs?: number;
  lexicalRetrievalDurationMs?: number;
  originalContexts: RetrievedChunk[];
  rewrittenContexts: RetrievedChunk[];
  lexicalContexts: RetrievedChunk[];
  temporalContexts?: RetrievedChunk[];
  temporalQueryMode?: TemporalQueryMode;
  temporalStructuredLookupEnabled?: boolean;
  retrievalBranches: RetrievalBranchResult[];
  vectorFallbackApplied: boolean;
  semanticRetrievalAvailability?: SemanticRetrievalAvailability;
  semanticRetrievalFailureReason?: SemanticRetrievalFailureReason | null;
  degradedRetrievalChannels?: DegradableRetrievalChannel[];
}

export interface CandidatePreparationStageResult extends CandidateRetrievalStageResult {
  normalizedCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  mergedCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  scoredCandidates: import("../domain/retrievalPipelineTypes.js").RetrievedCandidate[];
  appliedConstraints: AppliedConstraint[];
  candidateFallbackApplied: boolean;
  triggerBackoff: TriggerBackoffDecision;
}

export interface ContextSelectionStageResult extends CandidatePreparationStageResult {
  rerankedContexts: import("../domain/retrievalPipelineTypes.js").RerankedCandidate[];
  rerankStatus: import("../domain/retrievalPipelineTypes.js").RerankStatus;
  temporalDeterministicSortEnabled?: boolean;
  temporalDeterministicSortApplied?: boolean;
  temporalDeterministicSortToday?: string;
  temporalDeterministicSortDatedContextCount?: number;
  contexts: import("../domain/retrievalPipelineTypes.js").FinalPromptContext[];
}

export interface PromptAssemblyStageResult extends ContextSelectionStageResult {
  systemPrompt: string;
  prompt: string;
  citations: PromptBuildResult["citations"];
  responseSettings: {
    citationDisplayEnabled: boolean;
    suggestedQuestionsEnabled: RetrievalSettingsRecord["suggestedQuestionsEnabled"];
    suggestedQuestionsCount: RetrievalSettingsRecord["suggestedQuestionsCount"];
    customInstruction?: RetrievalSettingsRecord["customInstruction"];
    responseLanguagePolicy?: ResponseLanguagePolicy;
    responseLanguage?: string;
  };
}

export interface QueryInterpretationStage {
  execute(input: RetrievalContextStageResult): Promise<QueryInterpretationStageResult>;
  analyzeTriggers?(input: QueryInterpretationStageResult): Promise<TriggerAnalysisResult>;
}

export interface RetrievalContextStage {
  execute(input: RetrievalPipelineRequest): Promise<RetrievalContextStageResult>;
}

export interface CandidateRetrievalStage {
  execute(input: QueryInterpretationStageResult): Promise<CandidateRetrievalStageResult>;
}

export interface CandidatePreparationStage {
  execute(input: CandidateRetrievalStageResult): Promise<CandidatePreparationStageResult>;
}

export interface ContextSelectionStage {
  execute(input: CandidatePreparationStageResult): Promise<ContextSelectionStageResult>;
}

export interface PromptAssemblyStage {
  execute(input: ContextSelectionStageResult): PromptAssemblyStageResult;
}

export interface RetrievalDiagnosticsStage {
  execute(input: PromptAssemblyStageResult): Promise<import("../domain/retrievalPipelineTypes.js").RetrievalExecutionDiagnostics>;
}

export type TraceAttributes = Record<string, unknown>;

type TraceRetrievalPipelineRequest = {
  workspaceId?: unknown;
  history?: Array<unknown>;
  usageContext?: {
    requestId?: unknown;
    surface?: unknown;
    attemptKey?: unknown;
  };
  execution?: {
    surface?: unknown;
    path?: unknown;
    retrievalInvoked?: unknown;
  };
};

type TraceRetrievalContextInput = {
  request?: TraceRetrievalPipelineRequest;
  contextWindow?: {
    selectedMessages?: Array<unknown>;
    truncated?: boolean;
  };
};

type TraceQueryInterpretationInput = TraceRetrievalContextInput & {
  interpretationSource?: unknown;
  rewrittenQuery?: {
    status?: unknown;
    retrievalEligible?: unknown;
  };
  promptHistory?: Array<unknown>;
  promptHistoryReset?: unknown;
  triggerAnalysis?: {
    status?: unknown;
    matchCount?: number;
    consideredRules?: Array<unknown>;
  };
};

type TraceCandidateRetrievalInput = TraceQueryInterpretationInput & {
  originalContexts?: Array<unknown>;
  rewrittenContexts?: Array<unknown>;
  lexicalContexts?: Array<unknown>;
  temporalContexts?: Array<unknown>;
  temporalQueryMode?: TemporalQueryMode;
  temporalStructuredLookupEnabled?: boolean;
  retrievalBranches?: Array<unknown>;
  activeRetrievalSubqueries?: Array<unknown>;
  vectorFallbackApplied?: unknown;
  semanticRetrievalAvailability?: unknown;
  semanticRetrievalFailureReason?: unknown;
  degradedRetrievalChannels?: unknown;
};

type TraceCandidatePreparationInput = TraceCandidateRetrievalInput & {
  normalizedCandidates?: Array<unknown>;
  mergedCandidates?: Array<unknown>;
  scoredCandidates?: Array<unknown>;
  appliedConstraints?: Array<unknown>;
  candidateFallbackApplied?: unknown;
};

type TraceContextSelectionInput = TraceCandidatePreparationInput & {
  rerankStatus?: unknown;
  rerankedContexts?: Array<unknown>;
  temporalDeterministicSortEnabled?: boolean;
  temporalDeterministicSortApplied?: boolean;
  temporalDeterministicSortDatedContextCount?: number;
  contexts?: Array<unknown>;
};

type TracePromptAssemblyInput = TraceContextSelectionInput & {
  citations?: Array<unknown>;
  responseSettings?: {
    citationDisplayEnabled?: unknown;
    suggestedQuestionsEnabled?: unknown;
    suggestedQuestionsCount?: number;
    responseLanguagePolicy?: unknown;
    responseLanguage?: unknown;
  };
};

export const RETRIEVAL_TRACE_SPAN_NAMES = {
  pipelineRun: "retrieval.pipeline.run",
  pipelineInterpret: "retrieval.pipeline.interpret",
  pipelineRunInterpreted: "retrieval.pipeline.run_interpreted",
  pipelineNoRetrieval: "retrieval.pipeline.no_retrieval",
  context: "retrieval.stage.context",
  queryInterpretation: "retrieval.stage.query_interpretation",
  triggerAnalysis: "retrieval.stage.trigger_analysis",
  answerShapeSelection: "retrieval.stage.answer_shape_selection",
  candidateRetrieval: "retrieval.stage.candidate_retrieval",
  candidatePreparation: "retrieval.stage.candidate_preparation",
  contextSelection: "retrieval.stage.context_selection",
  promptAssembly: "retrieval.stage.prompt_assembly",
  diagnostics: "retrieval.stage.diagnostics",
  telemetry: "retrieval.telemetry.completed",
} as const;

const MAX_TRACE_COUNT = 1_000;

const boundedTraceCount = (value: number | undefined): number =>
  Math.min(MAX_TRACE_COUNT, Math.max(0, value ?? 0));

const compactTraceAttributes = (attributes: TraceAttributes): TraceAttributes =>
  Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null),
  ) as TraceAttributes;

export const buildRetrievalPipelineTraceAttributes = (request?: TraceRetrievalPipelineRequest): TraceAttributes => {
  if (!request) {
    return {};
  }

  return compactTraceAttributes({
    "radioso.workspace_id": request.workspaceId,
    "radioso.request_id": request.usageContext?.requestId,
    "retrieval.execution.surface": request.execution?.surface ?? request.usageContext?.surface ?? "retrieval",
    "retrieval.execution.path": request.execution?.path ?? request.usageContext?.attemptKey ?? "pipeline",
    "retrieval.execution.invoked": request.execution?.retrievalInvoked,
    "retrieval.history.count": boundedTraceCount(request.history?.length),
  });
};

export const buildRetrievalContextTraceAttributes = (result: TraceRetrievalContextInput): TraceAttributes =>
  compactTraceAttributes({
    ...buildRetrievalPipelineTraceAttributes(result.request),
    "retrieval.context.selected_message.count": boundedTraceCount(result.contextWindow?.selectedMessages?.length),
    "retrieval.context.truncated": result.contextWindow?.truncated,
  });

export const buildQueryInterpretationTraceAttributes = (result: TraceQueryInterpretationInput): TraceAttributes =>
  compactTraceAttributes({
    ...buildRetrievalPipelineTraceAttributes(result.request),
    "retrieval.interpretation.source": result.interpretationSource,
    "retrieval.rewrite.status": result.rewrittenQuery?.status,
    "retrieval.rewrite.eligible": result.rewrittenQuery?.retrievalEligible,
    "retrieval.query_history.count": boundedTraceCount(result.promptHistory?.length),
    "retrieval.query_history.reset": result.promptHistoryReset,
    "retrieval.trigger.status": result.triggerAnalysis?.status,
    "retrieval.trigger.match_count": boundedTraceCount(result.triggerAnalysis?.matchCount),
    "retrieval.trigger.considered_rule.count": boundedTraceCount(result.triggerAnalysis?.consideredRules?.length),
  });

// Bounded, low-cardinality: the channel set is closed, so this yields at most four
// distinct values. "none" is emitted explicitly so a healthy turn is distinguishable
// from a turn that predates the attribute.
export const formatDegradedChannels = (channels: unknown): string | undefined => {
  if (!Array.isArray(channels)) {
    return undefined;
  }
  const known = DEGRADABLE_RETRIEVAL_CHANNELS.filter((channel) => channels.includes(channel));
  return known.length === 0 ? "none" : known.join(",");
};

export const buildCandidateRetrievalTraceAttributes = (result: TraceCandidateRetrievalInput): TraceAttributes =>
  compactTraceAttributes({
    ...buildQueryInterpretationTraceAttributes(result),
    "retrieval.candidates.semantic_original.count": boundedTraceCount(result.originalContexts?.length),
    "retrieval.candidates.semantic_rewritten.count": boundedTraceCount(result.rewrittenContexts?.length),
    "retrieval.candidates.lexical.count": boundedTraceCount(result.lexicalContexts?.length),
    "retrieval.candidates.temporal.count": boundedTraceCount(result.temporalContexts?.length),
    "retrieval.temporal.mode": result.temporalQueryMode,
    "retrieval.temporal.structured_lookup.enabled": result.temporalStructuredLookupEnabled,
    "retrieval.branch.count": boundedTraceCount(result.retrievalBranches?.length),
    "retrieval.subquery.count": boundedTraceCount(result.activeRetrievalSubqueries?.length),
    "retrieval.vector_fallback.applied": result.vectorFallbackApplied,
    "retrieval.semantic.availability": result.semanticRetrievalAvailability,
    "retrieval.semantic.failure_reason": result.semanticRetrievalFailureReason,
    "retrieval.degraded_channels": formatDegradedChannels(result.degradedRetrievalChannels),
  });

export const buildCandidatePreparationTraceAttributes = (result: TraceCandidatePreparationInput): TraceAttributes =>
  compactTraceAttributes({
    ...buildCandidateRetrievalTraceAttributes(result),
    "retrieval.candidates.normalized.count": boundedTraceCount(result.normalizedCandidates?.length),
    "retrieval.candidates.merged.count": boundedTraceCount(result.mergedCandidates?.length),
    "retrieval.candidates.scored.count": boundedTraceCount(result.scoredCandidates?.length),
    "retrieval.constraint.count": boundedTraceCount(result.appliedConstraints?.length),
    "retrieval.candidate_fallback.applied": result.candidateFallbackApplied,
  });

export const buildContextSelectionTraceAttributes = (result: TraceContextSelectionInput): TraceAttributes =>
  compactTraceAttributes({
    ...buildCandidatePreparationTraceAttributes(result),
    "retrieval.rerank.status": result.rerankStatus,
    "retrieval.candidates.reranked.count": boundedTraceCount(result.rerankedContexts?.length),
    "retrieval.temporal.deterministic_sort.enabled": result.temporalDeterministicSortEnabled,
    "retrieval.temporal.deterministic_sort.applied": result.temporalDeterministicSortApplied,
    "retrieval.temporal.deterministic_sort.dated_context.count": boundedTraceCount(result.temporalDeterministicSortDatedContextCount),
    "retrieval.context.final.count": boundedTraceCount(result.contexts?.length),
  });

export const buildPromptAssemblyTraceAttributes = (result: TracePromptAssemblyInput): TraceAttributes =>
  compactTraceAttributes({
    ...buildContextSelectionTraceAttributes(result),
    "retrieval.assembly.citation.count": boundedTraceCount(result.citations?.length),
    "retrieval.response.citation_display.enabled": result.responseSettings?.citationDisplayEnabled,
    "retrieval.response.suggested_questions.enabled": result.responseSettings?.suggestedQuestionsEnabled,
    "retrieval.response.suggested_questions.count": boundedTraceCount(result.responseSettings?.suggestedQuestionsCount),
    "retrieval.response.language_policy": result.responseSettings?.responseLanguagePolicy,
    "retrieval.response.language": result.responseSettings?.responseLanguage,
  });
