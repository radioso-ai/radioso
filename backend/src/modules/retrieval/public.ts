import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import type { AgenticRetrievalToolFactory } from "./services/agenticRetrievalRunner.js";
import type { ResponseIdentity } from "../../shared/domain/responseIdentity.js";
import type { RetrievalSettingsRecord } from "../settings/contracts/retrieval.js";
import type {
  FinalPromptContext,
  ResponseLanguagePolicy,
  RetrievalExecutionDiagnostics,
  ActivityTrace,
  StructuredRewriteResult,
} from "./domain/retrievalPipelineTypes.js";
import type { RetrievalSourceScope } from "./domain/retrievalSourceFilter.js";

export {
  chunkingStrategyIds,
  normalizeMarkdown,
  type ChunkingStrategy,
  type ChunkingStrategyId,
} from "./domain/chunking/chunkingStrategy.js";
export type { TextChunkingProviderPort } from "./domain/chunking/chunkingProvider.js";
export type {
  FinalPromptContext,
  ResponseLanguagePolicy,
  RetrievalExecutionDiagnostics,
  RetrievalExecutionSurface,
  ActivityTrace,
  ActivityStage,
  ActivitySummary,
  RetrievedCandidate,
  RewriteContinuityState,
  StructuredRewriteResult,
  TriggerAnalysisResult,
} from "./domain/retrievalPipelineTypes.js";
export type {
  RetrievalSourceScope,
} from "./domain/retrievalSourceFilter.js";
export * from "./copilotPrimitiveRegistry.js";
export { resolveAgentRetrievalScope } from "./domain/agentRetrievalScope.js";
export type { AgentRetrievalScopePort } from "./domain/agentRetrievalScope.js";
export { normalizeVectorMetadataFilter } from "./domain/vectorFilter.js";
export {
  normalizeRetrievalSkillSettingsOverride,
  parseRetrieveSkillConfig,
  parsePersistedRetrievalSkillSettingsOverride,
  retrieveSkillConfigSchema,
  retrieveSkillConfigToSettingsOverride,
  type RetrieveSkillConfig,
} from "./domain/retrievalSkillSettings.js";
// Exported early (before the service re-exports below that value-import skills/public.js): the
// skills capability registry reads RETRIEVAL_ANSWER_ADAPTER at module-load via capabilities/retrieve,
// so it must be initialized before any cyclic service export to avoid a TDZ on that const.
export {
  RETRIEVAL_ANSWER_ADAPTER,
  RetrievalAnswerSkillExecutor,
  readRetrievalResult,
} from "./services/retrievalAnswerSkillExecutor.js";
export type { ChunkCandidateHydratorPort } from "./infra/chunkCandidateHydrator.js";
export type {
  VectorAdapter,
  VectorCandidateSearchPort,
} from "./domain/vectorAdapter.js";
export type {
  RetrievedChunk,
  VectorSearchPort,
} from "./domain/vectorSearch.js";
export {
  MetadataRuleFieldReferenceService,
  type MetadataRuleFieldReferencePort,
} from "./services/metadataRuleFieldReferenceService.js";
export { resolveContextSourceUrl } from "./services/contextSourceUrl.js";
export { SharedAnswerInstructionBuilder } from "./services/sharedAnswerInstructionBuilder.js";
export type { RetrievalDefaultsProvider } from "./domain/retrievalDefaultsProvider.js";
export type { SkillSettingsResolver } from "./services/retrievalContextStage.js";
export type {
  QueryRewriteGateway,
  QueryRewriteGatewayResult,
  TriggerAnalysisGateway,
  TriggerAnalysisGatewayInput,
} from "./services/queryRewriteService.js";
export type { QueryRewriteGatewayInput } from "./services/queryRewriteGateways.js";
export {
  ModelQueryRewriteGateway,
  ModelTriggerAnalysisGateway,
} from "./services/queryRewriteService.js";
export { parseStructuredRewrite } from "./services/queryRewriteParser.js";
export type { RerankGateway, RerankGatewayInput } from "./services/rerankService.js";
export {
  ModelRerankGateway,
  OpenAISemanticRerankGateway,
} from "./services/rerankService.js";
export { ActivitySummaryPresenter } from "./services/activitySummaryPresenter.js";
export { ActivityTracePresenter } from "./services/activityTracePresenter.js";
export {
  renderMetadataSearchText,
  renderSearchText,
} from "./services/searchTextRenderer.js";
export {
  deriveChunkSection,
  deriveDocumentSubject,
} from "./services/subjectIdentityService.js";
export { documentScopeFromClarificationCandidate } from "./services/senseGroupingService.js";
export {
  evaluateRetrievalSenseClarification,
  phraseRetrievalSenseAsk,
  presentableSenseCandidates,
  type RetrievalSenseDetectorPort,
} from "./services/retrievalSenseClarification.js";

export interface RetrievalResponseBehavior {
  customInstruction?: string;
  citationDisplayEnabled: boolean;
}

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
  usageContext?: Omit<ModelCallUsageContext, "operation">;
  agentSkillSettings?: Record<string, unknown>;
  agenticToolFactories?: ReadonlyArray<AgenticRetrievalToolFactory>;
  precomputedRewriteProposal?: StructuredRewriteResult;
  // When set, the retrieval pipeline runs against these settings instead of
  // reading the workspace's persisted retrieval settings. The override is
  // applied as a shallow merge over the workspace record and MUST NOT cause
  // any write to settings storage. Intended for eval replay and never for
  // production assistant traffic.
  retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
}

export interface RetrievalPipelineResult {
  rewrittenQuery: string;
  contexts: FinalPromptContext[];
  systemPrompt: string;
  prompt: string;
  citations: unknown[];
  responseIdentity: ResponseIdentity | null;
  responseSettings: {
    citationDisplayEnabled: boolean;
    suggestedQuestionsEnabled: boolean;
    suggestedQuestionsCount: number;
    customInstruction?: string;
    responseLanguagePolicy?: ResponseLanguagePolicy;
    responseLanguage?: string;
  };
  diagnostics: RetrievalExecutionDiagnostics;
  trace: ActivityTrace;
}

export interface RetrievalPipelineInterpretationResult {
  request: RetrievalPipelineRequest;
  interpretation: unknown;
}

export interface RetrievalPipelineService {
  run(input: RetrievalPipelineRequest): Promise<RetrievalPipelineResult>;
  interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult>;
  runInterpreted(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult>;
  runWithoutRetrieval(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult>;
}

// `RetrievalPipelinePort` is the internal name for the structural surface
// `RetrievalPipelineService` describes here; re-exported so consumers wiring the
// retrieval.answer executor have one import for the controller type.
export type { RetrievalPipelinePort } from "./services/retrievalPipelineService.js";
export type { AgenticRetrievalToolFactory } from "./services/agenticRetrievalRunner.js";
export {
  RetrieveRoutineSkillResolver,
  type RetrieveRoutineSkillRecord,
} from "./services/retrieveRoutineSkillResolver.js";
// Snippet building for chunk previews in skill-provider wiring; exposed here so
// composition never reaches into retrieval service internals.
export { buildSnippet, type RegisteredChunk } from "./services/agenticTools/index.js";

export type { VectorIndexReconciler } from "./services/vectorIndexReconciler.js";
export type {
  CanonicalVectorRebuildRecord,
  CanonicalVectorRebuildSourcePort,
  VectorIndexRebuildScope,
} from "./services/vectorIndexRebuildService.js";
