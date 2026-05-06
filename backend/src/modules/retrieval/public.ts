export {
  chunkingStrategyIds,
  normalizeMarkdown,
  type ChunkingRequest,
  type ChunkingStrategy,
  type ChunkingStrategyId,
  type ChunkOutput,
} from "./domain/chunking/chunkingStrategy.js";
export { ChunkingStrategyRegistry } from "./domain/chunking/chunkingStrategyRegistry.js";
export {
  chunkFixedWindowMarkdown,
  FixedWindowChunkingStrategy,
} from "./domain/chunking/fixedWindowChunkingStrategy.js";
export {
  StructuredSemanticChunkingStrategy,
  type ChunkingSimilarityPort,
} from "./domain/chunking/structuredSemanticChunkingStrategy.js";
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
export {
  PgLexicalSearch,
  type LexicalSearchPort,
} from "./infra/lexicalSearch.js";
export {
  hasNonEmptyFilter,
  PgVectorSearch,
  type RetrievedChunk,
  type VectorSearchPort,
} from "./infra/vectorSearch.js";
export { CandidatePreparationService } from "./services/candidatePreparationService.js";
export { ConversationContextService } from "./services/conversationContextService.js";
export { ConversationModeInstructionBuilder } from "./services/conversationModeInstructionBuilder.js";
export { resolveContextSourceUrl } from "./services/contextSourceUrl.js";
export {
  buildRetrievalText,
  EmbeddingService,
  ModelEmbeddingGateway,
  OpenAIEmbeddingGateway,
  type EmbeddingGateway,
} from "./services/embeddingService.js";
export {
  PromptBuilder,
  type PromptBuildResult,
} from "./services/promptBuilder.js";
export { PromptContextSelectorService } from "./services/promptContextSelectorService.js";
export {
  ModelQueryRewriteGateway,
  ModelTriggerAnalysisGateway,
  OpenAIQueryRewriteGateway,
  QueryRewriteService,
  type QueryRewriteGateway,
  type QueryRewriteGatewayFallbackResult,
  type QueryRewriteGatewayResult,
  type TriggerAnalysisGateway,
  type TriggerAnalysisGatewayInput,
} from "./services/queryRewriteService.js";
export {
  ModelRerankGateway,
  OpenAISemanticRerankGateway,
  RerankService,
  type RerankGateway,
} from "./services/rerankService.js";
export {
  RetrievalAnswerService,
  type RetrievalAnswerServiceDependencies,
} from "./services/retrievalAnswerService.js";
export { RetrievalExecutionTelemetryService } from "./services/retrievalExecutionTelemetryService.js";
export {
  RetrievalInfoPresenter,
  type RetrievalInfo,
  type RetrievalInfoPresenterOptions,
} from "./services/retrievalInfoPresenter.js";
export {
  RetrievalPipelineService,
  type RetrievalPipelineInterpretationResult,
  type RetrievalPipelineResult,
} from "./services/retrievalPipelineService.js";
export { RetrievalSearchService } from "./services/retrievalSearchService.js";
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
