import type {
  QueryEmbeddingPort,
} from "../embeddingProfiles/contracts/embeddingConsumers.js";
import type { Database } from "../../shared/infra/database.js";
import type { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import type { UsageEventRecorder } from "../../shared/domain/usageEventRecorder.js";
import type { RetrievalDefaultsProvider } from "./domain/retrievalDefaultsProvider.js";
import type { VectorCandidateSearchPort } from "./domain/vectorAdapter.js";
import { CandidatePreparationService } from "./services/candidatePreparationService.js";
import { ConversationContextService } from "./services/conversationContextService.js";
import { PgLexicalSearch } from "./infra/lexicalSearch.js";
import { PgTemporalCandidateRepository } from "./infra/temporalCandidateRepository.js";
import {
  PostgresChunkCandidateHydrator,
  type ChunkCandidateHydratorPort,
} from "./infra/chunkCandidateHydrator.js";
import { PromptBuilder } from "./services/promptBuilder.js";
import { PromptContextSelectorService } from "./services/promptContextSelectorService.js";
import { QueryRewriteService } from "./services/queryRewriteService.js";
import { RerankService } from "./services/rerankService.js";
import { RetrievalExecutionTelemetryService } from "./services/retrievalExecutionTelemetryService.js";
import { RetrievalPipelineService } from "./services/retrievalPipelineService.js";
import { RetrievalSearchService } from "./services/retrievalSearchService.js";
import type { SkillSettingsResolver } from "./services/retrievalContextStage.js";
import type { AgentRetrievalScopePort } from "./domain/agentRetrievalScope.js";

export { ChunkingStrategyRegistry } from "./domain/chunking/chunkingStrategyRegistry.js";
export {
  FixedWindowChunkingStrategy,
} from "./domain/chunking/fixedWindowChunkingStrategy.js";
export {
  RecursiveTextChunkingStrategy,
} from "./domain/chunking/recursiveTextChunkingStrategy.js";
export type {
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
  PostgresChunkCandidateHydrator,
  type ChunkCandidateHydratorPort,
} from "./infra/chunkCandidateHydrator.js";
export {
  PgLexicalSearch,
  type LexicalSearchPort,
} from "./infra/lexicalSearch.js";
export { PgTemporalCandidateRepository } from "./infra/temporalCandidateRepository.js";
export { PgVectorAdapter } from "./infra/pgVectorAdapter.js";
export { VectorIndexReconciler } from "./services/vectorIndexReconciler.js";
export { CandidatePreparationService } from "./services/candidatePreparationService.js";
export { ConversationContextService } from "./services/conversationContextService.js";
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
  type RetrievalPipelinePort,
  type RetrievalPipelineResult,
} from "./services/retrievalPipelineService.js";
export { RetrievalSearchService } from "./services/retrievalSearchService.js";
export {
  ModelSenseLabelGateway,
  PostgresSenseEmbeddingReader,
  SenseGroupingService,
  type RetrievalSensePolicy,
} from "./services/senseGroupingService.js";
export { AgenticRetrievalRunner } from "./services/agenticRetrievalRunner.js";
export {
  AgenticRetrievalPipelineService,
  type AgenticRetrievalPipelineServiceDeps,
} from "./services/agenticRetrievalPipelineService.js";
export {
  RetrievalAnswerExecutor,
  type RetrievalAnswerExecutorDeps,
  type RetrievalStrategyPipeline,
} from "./services/retrievalAnswerExecutor.js";
export { GatewayQueryRewritePortAdapter } from "./services/gatewayQueryRewritePortAdapter.js";
export const createDefaultRetrievalServices = (input: {
  database: Database;
  queryEmbeddings: QueryEmbeddingPort;
  vectorSearch: VectorCandidateSearchPort;
  chunkHydrator: ChunkCandidateHydratorPort;
  llmRegistry: LlmProviderRegistry;
  logger: AppLogger;
  retrievalDefaultsProvider: RetrievalDefaultsProvider;
  telemetryService: TelemetryService;
  usageEventRecorder?: UsageEventRecorder;
  skillSettingsResolver?: SkillSettingsResolver;
  agentRetrievalScope?: AgentRetrievalScopePort;
}) => {
  const retrievalPipeline = new RetrievalPipelineService(
    input.retrievalDefaultsProvider,
    input.queryEmbeddings,
    input.vectorSearch,
    new PgLexicalSearch(input.database),
    new ConversationContextService(),
    new QueryRewriteService(
      input.llmRegistry.createRewriteGateway(input.usageEventRecorder),
      input.llmRegistry.createTriggerAnalysisGateway(input.usageEventRecorder),
    ),
    new CandidatePreparationService(),
    undefined,
    new RerankService(input.llmRegistry.createRerankGateway(input.usageEventRecorder), input.logger),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(input.telemetryService),
    undefined,
    input.skillSettingsResolver,
    input.chunkHydrator,
    new PgTemporalCandidateRepository(input.database),
  );
  const retrievalSearchService = new RetrievalSearchService(retrievalPipeline, input.agentRetrievalScope);

  return {
    retrievalPipeline,
    retrievalSearchService,
  };
};
