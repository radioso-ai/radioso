import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import type { ResponseIdentity } from "../../shared/domain/responseIdentity.js";
import type {
  FinalPromptContext,
  ResponseIntent,
  ResponseLanguagePolicy,
  RetrievalExecutionDiagnostics,
  RetrievalTrace,
} from "./domain/retrievalPipelineTypes.js";

export {
  chunkingStrategyIds,
  normalizeMarkdown,
  type ChunkingRequest,
  type ChunkingStrategy,
  type ChunkingStrategyId,
  type ChunkOutput,
} from "./domain/chunking/chunkingStrategy.js";
export type { ChunkingSimilarityPort } from "./domain/chunking/structuredSemanticChunkingStrategy.js";
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
  RetrievalTrace,
  RetrievalTraceLink,
  RetrievalTraceStage,
  RetrievalTraceStageStatus,
  RetrievalTraceSummary,
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
export type {
  RetrievedChunk,
  VectorSearchPort,
} from "./infra/vectorSearch.js";
export { ConversationModeInstructionBuilder } from "./services/conversationModeInstructionBuilder.js";
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
export type { RerankGateway } from "./services/rerankService.js";
export {
  RetrievalInfoPresenter,
  type RetrievalInfo,
  type RetrievalInfoPresenterOptions,
} from "./services/retrievalInfoPresenter.js";
export {
  RetrievalTracePresenter,
  type AnswerOutcomeInput,
} from "./services/retrievalTracePresenter.js";
export {
  renderMetadataSearchText,
  renderSearchText,
} from "./services/searchTextRenderer.js";
export {
  deriveChunkSection,
  deriveDocumentSubject,
} from "./services/subjectIdentityService.js";

type RetrievalConversationMode = "factual" | "exploratory" | "guided";

export interface RetrievalPipelineRequest {
  workspaceId: string;
  query: string;
  history: MessageRecord[];
  responseIdentity?: ResponseIdentity | null;
  responseBehaviorEnabled?: boolean;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  metadataFilter?: Record<string, unknown>;
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
    answerSupportValidationEnabled?: boolean;
    conversationMode: RetrievalConversationMode;
    suggestedQuestionsEnabled: boolean;
    suggestedQuestionsCount: number;
    customInstruction?: string;
    responseLanguagePolicy?: ResponseLanguagePolicy;
  };
  diagnostics: RetrievalExecutionDiagnostics;
  trace: RetrievalTrace;
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
