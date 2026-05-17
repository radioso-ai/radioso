import type { RetrievalSettingsService } from "../settings/composition.js";
import type { Database } from "../../shared/infra/database.js";
import type { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import { CandidatePreparationService } from "./services/candidatePreparationService.js";
import { ConversationContextService } from "./services/conversationContextService.js";
import { EmbeddingService } from "./services/embeddingService.js";
import { PgLexicalSearch } from "./infra/lexicalSearch.js";
import { PgVectorSearch } from "./infra/vectorSearch.js";
import { PromptBuilder } from "./services/promptBuilder.js";
import { PromptContextSelectorService } from "./services/promptContextSelectorService.js";
import { QueryRewriteService } from "./services/queryRewriteService.js";
import { RerankService } from "./services/rerankService.js";
import { RetrievalExecutionTelemetryService } from "./services/retrievalExecutionTelemetryService.js";
import { RetrievalPipelineService } from "./services/retrievalPipelineService.js";
import { RetrievalSearchService } from "./services/retrievalSearchService.js";

export { ChunkingStrategyRegistry } from "./domain/chunking/chunkingStrategyRegistry.js";
export {
  FixedWindowChunkingStrategy,
} from "./domain/chunking/fixedWindowChunkingStrategy.js";
export {
  RecursiveTextChunkingStrategy,
} from "./domain/chunking/recursiveTextChunkingStrategy.js";
export type {
  TextChunkingEmbeddingPort,
  TextChunkingMethod,
  TextChunkingProviderChunk,
  TextChunkingProviderPort,
  TextChunkingProviderRequest,
} from "./domain/chunking/chunkingProvider.js";
export {
  StructuredSemanticChunkingStrategy,
} from "./domain/chunking/structuredSemanticChunkingStrategy.js";
export { ChonkieChunkingProvider } from "./infra/chonkieChunkingProvider.js";
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
  RetrievalPipelineService,
  type RetrievalPipelineInterpretationResult,
  type RetrievalPipelineResult,
} from "./services/retrievalPipelineService.js";
export { RetrievalSearchService } from "./services/retrievalSearchService.js";

export const createDefaultRetrievalServices = (input: {
  database: Database;
  embeddingService: EmbeddingService;
  llmRegistry: LlmProviderRegistry;
  logger: AppLogger;
  retrievalSettingsService: RetrievalSettingsService;
  telemetryService: TelemetryService;
}) => {
  const retrievalPipeline = new RetrievalPipelineService(
    input.retrievalSettingsService,
    input.embeddingService,
    new PgVectorSearch(input.database),
    new PgLexicalSearch(input.database),
    new ConversationContextService(),
    new QueryRewriteService(input.llmRegistry.createRewriteGateway(), input.llmRegistry.createTriggerAnalysisGateway()),
    new CandidatePreparationService(),
    undefined,
    new RerankService(input.llmRegistry.createRerankGateway(), input.logger),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(input.telemetryService),
  );
  const retrievalSearchService = new RetrievalSearchService(retrievalPipeline);

  return {
    retrievalPipeline,
    retrievalSearchService,
  };
};
