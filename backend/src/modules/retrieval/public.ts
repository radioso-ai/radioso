import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import type { ResponseIdentity } from "../../shared/domain/responseIdentity.js";
import type { RetrievalSettingsRecord } from "../settings/contracts/retrieval.js";
import type {
  FinalPromptContext,
  ResponseIntent,
  ResponseLanguagePolicy,
  RetrievalExecutionDiagnostics,
  RetrievalSourceScope,
  ActivityTrace,
} from "./domain/retrievalPipelineTypes.js";

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
  RetrievalSourceFilter,
  RetrievalSourceScope,
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
  ResponseIntent,
  StructuredRewriteResult,
  TriggerAnalysisResult,
  TriggerAnalysisStatus,
  TriggerBackoffDecision,
  TriggerRuleDecision,
} from "./domain/retrievalPipelineTypes.js";
export {
  RESPONSE_INTENT,
  REWRITE_STATUS,
  REWRITE_TURN_KIND,
} from "./domain/retrievalPipelineTypes.js";
export type {
  RetrievalAnswerRequest,
  RetrievalAnswerResult,
  RetrievalAnswerSuccess,
  RetrievalAnswerUnsupported,
  RetrievalConversationContext,
  RetrievalSearchRequest,
  RetrievalSearchResult,
} from "./domain/retrievalCapabilityTypes.js";
export type { LexicalSearchPort } from "./infra/lexicalSearch.js";
export type { ChunkVectorStoragePort } from "./infra/chunkVectorStorage.js";
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
export type { EmbeddingGateway, EmbeddingService } from "./services/embeddingService.js";
export type { PromptBuildResult } from "./services/promptBuilder.js";
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
export type { RerankGateway, RerankGatewayInput } from "./services/rerankService.js";
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

export interface RetrievalResponseBehavior {
  customInstruction?: string;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
}

export interface RetrievalPipelineRequest {
  workspaceId: string;
  query: string;
  history: MessageRecord[];
  responseIdentity?: ResponseIdentity | null;
  responseBehaviorEnabled?: boolean;
  responseBehavior?: RetrievalResponseBehavior;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  metadataFilter?: Record<string, unknown>;
  sourceScope?: RetrievalSourceScope;
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
  };
  diagnostics: RetrievalExecutionDiagnostics;
  trace: ActivityTrace;
}

export interface RetrievalPipelineInterpretationResult {
  request: RetrievalPipelineRequest;
  interpretation: {
    result: {
      responseIntent?: ResponseIntent;
    };
  };
}

export interface RetrievalPipelineService {
  run(input: RetrievalPipelineRequest): Promise<RetrievalPipelineResult>;
  interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult>;
  runInterpreted(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult>;
  runWithoutRetrieval(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult>;
}
