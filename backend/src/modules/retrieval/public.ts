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
  type ChunkingRequest,
  type ChunkingStrategy,
  type ChunkingStrategyId,
  type ChunkOutput,
} from "./domain/chunking/chunkingStrategy.js";
export type {
  TextChunkingEmbeddingPort,
  TextChunkingMethod,
  TextChunkingProviderChunk,
  TextChunkingProviderPort,
  TextChunkingProviderRequest,
} from "./domain/chunking/chunkingProvider.js";
export type {
  ConversationContextWindow,
  ContinuityDecision,
  FinalPromptContext,
  LexicalQueryPlan,
  LexicalSearchOption,
  RerankedCandidate,
  RerankStatus,
  ResponseLanguagePolicy,
  RetrievalExecutionDiagnostics,
  RetrievalExecutionMetadata,
  RetrievalExecutionPath,
  RetrievalExecutionSurface,
  RetrievalSource,
  RetrievalSubquery,
  ActivityTrace,
  ActivityLink,
  ActivityStage,
  ActivityStageStatus,
  ActivitySummary,
  RetrievedCandidate,
  RewriteContinuityState,
  RewriteStatus,
  RewriteTurnKind,
  RewrittenRetrievalQuery,
  StructuredRewriteResult,
  TriggerAnalysisResult,
  TriggerAnalysisStatus,
  TriggerBackoffDecision,
  TriggerRuleDecision,
} from "./domain/retrievalPipelineTypes.js";
export type {
  RetrievalSourceFilter,
  RetrievalSourceScope,
} from "./domain/retrievalSourceFilter.js";
export type {
  VectorChunkFilter,
  VectorMetadataFilter,
  VectorMetadataFilterValue,
} from "./domain/vectorFilter.js";
export {
  mergeVectorMetadataFilters,
  normalizeVectorMetadataFilter,
} from "./domain/vectorFilter.js";
export {
  normalizeRetrievalSkillSettingsOverride,
  parseRetrieveSkillConfig,
  parsePersistedRetrievalSkillSettingsOverride,
  retrieveSkillConfigSchema,
  retrieveSkillConfigToSettingsOverride,
  type RetrieveSkillConfig,
  type EffectiveRetrievalSkillSettings,
  type RetrievalSkillSettingsOverride,
} from "./domain/retrievalSkillSettings.js";
// Exported early (before the service re-exports below that value-import skills/public.js): the
// skills capability registry reads RETRIEVAL_ANSWER_ADAPTER at module-load via capabilities/retrieve,
// so it must be initialized before any cyclic service export to avoid a TDZ on that const.
export {
  RETRIEVAL_ANSWER_ADAPTER,
  RETRIEVAL_CONTEXT_SKILL_NAME,
  RetrievalAnswerSkillExecutor,
  readRetrievalResult,
} from "./services/retrievalAnswerSkillExecutor.js";
export {
  REWRITE_STATUS,
  REWRITE_TURN_KIND,
} from "./domain/retrievalPipelineTypes.js";
export type {
  RetrievalAnswerRequest,
  RetrievalAnswerResult,
  RetrievalAnswerSuccess,
  RetrievalConversationContext,
  RetrievalSearchRequest,
  RetrievalSearchResult,
} from "./domain/retrievalCapabilityTypes.js";
export type { LexicalSearchPort } from "./infra/lexicalSearch.js";
export type { ChunkVectorStoragePort } from "./infra/chunkVectorStorage.js";
export type { ChunkCandidateHydratorPort } from "./infra/chunkCandidateHydrator.js";
export type {
  VectorIndexCandidate,
  VectorIndexChunk,
  VectorIndexFilter,
  VectorIndexHealth,
  VectorIndexPort,
  VectorIndexSearchInput,
} from "./domain/vectorIndex.js";
export type {
  RetrievedChunk,
  VectorSearchInput,
  VectorSearchPort,
} from "./domain/vectorSearch.js";
export {
  ModelEmbeddingGateway,
  OpenAIEmbeddingGateway,
} from "./services/embeddingService.js";
export { resolveContextSourceUrl } from "./services/contextSourceUrl.js";
export { SharedAnswerInstructionBuilder } from "./services/sharedAnswerInstructionBuilder.js";
export type { EmbeddingGateway, EmbeddingService } from "./services/embeddingService.js";
export type { PromptBuildResult } from "./services/promptBuilder.js";
export type { RetrievalDefaultsProvider } from "./domain/retrievalDefaultsProvider.js";
export type { SkillSettingsResolver } from "./services/retrievalContextStage.js";
export type {
  QueryRewriteGateway,
  QueryRewriteGatewayFallbackResult,
  QueryRewriteGatewayResult,
  TriggerAnalysisGateway,
  TriggerAnalysisGatewayInput,
} from "./services/queryRewriteService.js";
export type { QueryRewriteGatewayInput } from "./services/queryRewriteGateways.js";
export {
  ModelQueryRewriteGateway,
  ModelTriggerAnalysisGateway,
  OpenAIQueryRewriteGateway,
} from "./services/queryRewriteService.js";
export { parseStructuredRewrite } from "./services/queryRewriteParser.js";
export type { RerankGateway, RerankGatewayInput } from "./services/rerankService.js";
export type {
  QueryRewritePort,
  QueryRewritePortRequest,
  QueryRewritePortResult,
} from "./domain/queryRewritePort.js";
export { GatewayQueryRewritePortAdapter } from "./services/gatewayQueryRewritePortAdapter.js";
export {
  ModelRerankGateway,
  OpenAISemanticRerankGateway,
} from "./services/rerankService.js";
export {
  ActivitySummaryPresenter,
  type ActivitySummaryPresenterOptions,
} from "./services/activitySummaryPresenter.js";
export {
  ActivityTracePresenter,
  type AnswerOutcomeInput,
} from "./services/activityTracePresenter.js";
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
  type PhrasedSenseClarification,
  type RetrievalSenseClarificationEffect,
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
export type { AgenticRetrievalToolFactory, AgenticRetrievalToolFactoryContext } from "./services/agenticRetrievalRunner.js";
export { RetrieveRoutineSkillResolver } from "./services/retrieveRoutineSkillResolver.js";
export { buildSnippet, type RegisteredChunk } from "./services/agenticTools/index.js";
