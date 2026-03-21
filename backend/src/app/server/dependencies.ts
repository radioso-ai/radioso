import { getEnv, type Env } from "../config/env.js";
import { ChatService } from "../../modules/chat/services/chatService.js";
import { ChatHistoryService } from "../../modules/chat/services/chatHistoryService.js";
import { AccountRepository } from "../../db/repositories/accountRepository.js";
import { WorkspaceTokenRepository } from "../../db/repositories/workspaceTokenRepository.js";
import { WorkspaceRepository } from "../../db/repositories/workspaceRepository.js";
import { AuditEventRepository } from "../../db/repositories/auditEventRepository.js";
import { ChunkRepository } from "../../db/repositories/chunkRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { DocumentRepository } from "../../db/repositories/documentRepository.js";
import { DocumentProcessingJobRepository } from "../../db/repositories/documentProcessingJobRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import { RetrievalSettingsRepository } from "../../db/repositories/retrievalSettingsRepository.js";
import { SessionRepository } from "../../db/repositories/sessionRepository.js";
import { AuthService } from "../../modules/auth/services/authService.js";
import { AuditService } from "../../modules/audit/services/auditService.js";
import { WorkspaceService } from "../../modules/workspace/services/workspaceService.js";
import { DocumentDeletionService } from "../../modules/documents/services/documentDeletionService.js";
import { DocumentIngestionService } from "../../modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../modules/documents/services/documentProcessingWorker.js";
import { PgLexicalSearch } from "../../modules/retrieval/infra/lexicalSearch.js";
import { PgVectorSearch } from "../../modules/retrieval/infra/vectorSearch.js";
import { CandidatePreparationService } from "../../modules/retrieval/services/candidatePreparationService.js";
import { AttributeMatchScoringService } from "../../modules/retrieval/services/attributeMatchScoringService.js";
import { ConversationContextService } from "../../modules/retrieval/services/conversationContextService.js";
import { PromptBuilder } from "../../modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../modules/retrieval/services/promptContextSelectorService.js";
import { ChunkingStrategyRegistry } from "../../modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { FixedWindowChunkingStrategy } from "../../modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { StructuredSemanticChunkingStrategy } from "../../modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.js";
import { QueryRewriteService } from "../../modules/retrieval/services/queryRewriteService.js";
import { RerankService } from "../../modules/retrieval/services/rerankService.js";
import { RetrievalPipelineService } from "../../modules/retrieval/services/retrievalPipelineService.js";
import { RetrievalExecutionTelemetryService } from "../../modules/retrieval/services/retrievalExecutionTelemetryService.js";
import { EmbeddingService } from "../../modules/retrieval/services/embeddingService.js";
import { RetrievalSettingsService } from "../../modules/settings/services/retrievalSettingsService.js";
import { ConnectorRegistry } from "../../modules/connectors/services/connectorRegistry.js";
import { registerBuiltInConnectors } from "../../modules/connectors/plugins/index.js";
import { Database } from "../../shared/infra/database.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import { createLogger } from "../../shared/observability/logger.js";
import type { AppDependencies } from "./types.js";

export const buildDependencies = (env: Env = getEnv()): AppDependencies => {
  const logger = createLogger();
  const database = new Database(env.DATABASE_URL);
  const auditEventRepository = new AuditEventRepository(database);
  const auditService = new AuditService(logger, auditEventRepository);
  const llmRegistry = new LlmProviderRegistry(resolveLlmConfig(env));
  logger.info({ llmProviders: llmRegistry.describe() }, "Resolved LLM providers");
  const retrievalSettingsService = new RetrievalSettingsService(new RetrievalSettingsRepository(database), auditService);
  const embeddingService = new EmbeddingService(llmRegistry.createEmbeddingGateway());
  const documentRepository = new DocumentRepository(database);
  const documentProcessingJobRepository = new DocumentProcessingJobRepository(database);
  const chunkRepository = new ChunkRepository(database);
  const chunkingStrategyRegistry = new ChunkingStrategyRegistry([
    new FixedWindowChunkingStrategy(),
    new StructuredSemanticChunkingStrategy(embeddingService),
  ]);
  const documentProcessingService = new DocumentProcessingService(
    documentRepository,
    chunkRepository,
    embeddingService,
    auditService,
    retrievalSettingsService,
    chunkingStrategyRegistry,
  );
  const documentIngestionService = new DocumentIngestionService(
    documentRepository,
    auditService,
  );
  const documentProcessingWorker = new DocumentProcessingWorker(
    documentRepository,
    documentProcessingJobRepository,
    documentProcessingService,
    auditService,
    logger,
  );
  const documentDeletionService = new DocumentDeletionService(documentRepository, auditService);
  const retrievalPipeline = new RetrievalPipelineService(
    retrievalSettingsService,
    embeddingService,
    new PgVectorSearch(database),
    new PgLexicalSearch(database),
    new ConversationContextService(),
    new QueryRewriteService(llmRegistry.createRewriteGateway()),
    new CandidatePreparationService(),
    new AttributeMatchScoringService(),
    new RerankService(llmRegistry.createRerankGateway()),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(),
  );
  const conversationRepository = new ConversationRepository(database);
  const messageRepository = new MessageRepository(database);
  const chatService = new ChatService(
    conversationRepository,
    messageRepository,
    retrievalPipeline,
    llmRegistry.createChatGateway(),
    auditService,
  );
  const chatHistoryService = new ChatHistoryService(
    conversationRepository,
    messageRepository,
    auditEventRepository,
  );
  const workspaceRepository = new WorkspaceRepository(database);
  const workspaceService = new WorkspaceService(workspaceRepository, auditService);
  const connectorRegistry = new ConnectorRegistry();
  registerBuiltInConnectors(connectorRegistry);
  if (env.CONNECTOR_ENCRYPTION_KEY) {
    connectorRegistry.setEncryptionKey(env.CONNECTOR_ENCRYPTION_KEY);
  }
  const authService = new AuthService({
    env,
    accountRepository: new AccountRepository(database),
    sessionRepository: new SessionRepository(database),
    workspaceTokenRepository: new WorkspaceTokenRepository(database),
    workspaceService,
    auditService,
  });

  return {
    env,
    logger,
    authService,
    auditService,
    workspaceService,
    retrievalSettingsService,
    documentIngestionService,
    documentProcessingWorker,
    documentDeletionService,
    chatService,
    chatHistoryService,
    workspaceRepository,
    conversationRepository,
    messageRepository,
    connectorRegistry,
    connectorDb: database,
  };
};
