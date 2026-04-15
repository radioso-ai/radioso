import { getEnv, type Env } from "../config/env.js";
import { ChatService } from "../../modules/chat/services/chatService.js";
import { ChatBootstrapService } from "../../modules/chat/services/chatBootstrapService.js";
import { ChatHistoryService } from "../../modules/chat/services/chatHistoryService.js";
import { AccountMembershipRepository } from "../../db/repositories/accountMembershipRepository.js";
import { AccountInvitationRepository } from "../../db/repositories/accountInvitationRepository.js";
import { AccountRepository } from "../../db/repositories/accountRepository.js";
import { UserRepository } from "../../db/repositories/userRepository.js";
import { WorkspaceTokenRepository } from "../../db/repositories/workspaceTokenRepository.js";
import { WorkspaceRepository } from "../../db/repositories/workspaceRepository.js";
import { BootstrapGreetingCacheRepository } from "../../db/repositories/bootstrapGreetingCacheRepository.js";
import { AuditEventRepository } from "../../db/repositories/auditEventRepository.js";
import { ChunkRepository } from "../../db/repositories/chunkRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { DocumentRepository } from "../../db/repositories/documentRepository.js";
import { DocumentProcessingJobRepository } from "../../db/repositories/documentProcessingJobRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import { IngestionSettingsRepository } from "../../db/repositories/ingestionSettingsRepository.js";
import { RetrievalSettingsRepository } from "../../db/repositories/retrievalSettingsRepository.js";
import { SessionRepository } from "../../db/repositories/sessionRepository.js";
import { AuthService } from "../../modules/auth/services/authService.js";
import { AccountAccessService } from "../../modules/account/services/accountAccessService.js";
import { AccountInvitationService } from "../../modules/account/services/accountInvitationService.js";
import { AuditService } from "../../modules/audit/services/auditService.js";
import { WorkspaceService } from "../../modules/workspace/services/workspaceService.js";
import { WorkspaceSessionService } from "../../modules/auth/services/workspaceSessionService.js";
import { DocumentDeletionService } from "../../modules/documents/services/documentDeletionService.js";
import { DocumentIngestionService } from "../../modules/documents/services/documentIngestionService.js";
import { DocumentImportService } from "../../modules/documents/services/documentImportService.js";
import { DocumentSearchHistoryService } from "../../modules/documents/services/documentSearchHistoryService.js";
import { DocumentSearchService } from "../../modules/documents/services/documentSearchService.js";
import { DocumentProcessingService } from "../../modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../modules/documents/services/documentProcessingWorker.js";
import { DocumentSourceContentService } from "../../modules/documents/services/documentSourceContentService.js";
import { GcsDocumentStorage, type DocumentStoragePort } from "../../modules/documents/infra/gcsDocumentStorage.js";
import { WorkspaceIngestionReprocessService } from "../../modules/documents/services/workspaceIngestionReprocessService.js";
import { PgLexicalSearch } from "../../modules/retrieval/infra/lexicalSearch.js";
import { PgVectorSearch } from "../../modules/retrieval/infra/vectorSearch.js";
import { CandidatePreparationService } from "../../modules/retrieval/services/candidatePreparationService.js";
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
import { IngestionSettingsService } from "../../modules/settings/services/ingestionSettingsService.js";
import { RetrievalSettingsService } from "../../modules/settings/services/retrievalSettingsService.js";
import { ConnectorRegistry } from "../../modules/connectors/services/connectorRegistry.js";
import { AbuseControlRepository } from "../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import { EvalRepository } from "../../db/repositories/evalRepository.js";
import { EvalReplayService } from "../../modules/evals/services/evalReplayService.js";
import { EvalLabService } from "../../modules/evals/services/evalLabService.js";
import { registerBuiltInConnectors } from "../../modules/connectors/plugins/index.js";
import { Database } from "../../shared/infra/database.js";
import { AppError } from "../../shared/domain/errors.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import { createLogger } from "../../shared/observability/logger.js";
import type { AppDependencies } from "./types.js";

export const buildDependencies = (env: Env = getEnv()): AppDependencies => {
  const logger = createLogger();
  const database = new Database(env.DATABASE_URL, {
    poolMax: env.DB_POOL_MAX,
    idleTimeoutMs: env.DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMs: env.DB_POOL_CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS,
    applicationName: `radioso-${env.NODE_ENV}`,
  });
  const auditEventRepository = new AuditEventRepository(database);
  const auditService = new AuditService(logger, auditEventRepository);
  const accountMembershipRepository = new AccountMembershipRepository(database);
  const userRepository = new UserRepository(database);
  const accountAccessService = new AccountAccessService(accountMembershipRepository, auditService);
  const accountInvitationService = new AccountInvitationService(
    new AccountInvitationRepository(database),
    userRepository,
    accountAccessService,
    auditService,
  );
  const llmRegistry = new LlmProviderRegistry(resolveLlmConfig(env), logger);
  logger.info({ llmProviders: llmRegistry.describe() }, "Resolved LLM providers");
  const ingestionSettingsService = new IngestionSettingsService(new IngestionSettingsRepository(database), auditService);
  const embeddingService = new EmbeddingService(llmRegistry.createEmbeddingGateway());
  const documentRepository = new DocumentRepository(database);
  const retrievalSettingsService = new RetrievalSettingsService(
    new RetrievalSettingsRepository(database),
    auditService,
    documentRepository,
  );
  const documentStorage: DocumentStoragePort = env.DOCUMENT_STORAGE_BUCKET
    ? new GcsDocumentStorage(env.DOCUMENT_STORAGE_BUCKET)
    : {
        async upload() {
          throw new AppError(503, "service_unavailable", "Document import storage is not configured");
        },
        async read() {
          throw new AppError(503, "service_unavailable", "Document import storage is not configured");
        },
        async delete() {
          throw new AppError(503, "service_unavailable", "Document import storage is not configured");
        },
      };
  const documentSourceContentService = new DocumentSourceContentService(documentStorage);
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
    ingestionSettingsService,
    chunkingStrategyRegistry,
    documentSourceContentService,
    logger,
  );
  const documentIngestionService = new DocumentIngestionService(
    documentRepository,
    auditService,
    () => documentProcessingJobRepository.getQueueSnapshot(),
  );
  const documentImportService = new DocumentImportService(
    documentRepository,
    auditService,
    documentStorage,
    () => documentProcessingJobRepository.getQueueSnapshot(),
  );
  const documentProcessingWorker = new DocumentProcessingWorker(
    documentRepository,
    documentProcessingJobRepository,
    documentProcessingService,
    auditService,
    logger,
  );
  const documentDeletionService = new DocumentDeletionService(documentRepository, documentStorage, auditService);
  const workspaceIngestionReprocessService = new WorkspaceIngestionReprocessService(documentRepository, auditService);
  const conversationRepository = new ConversationRepository(database);
  const messageRepository = new MessageRepository(database);
  const workspaceRepository = new WorkspaceRepository(database);
  const bootstrapGreetingCacheRepository = new BootstrapGreetingCacheRepository(database);
  const retrievalPipeline = new RetrievalPipelineService(
    retrievalSettingsService,
    embeddingService,
    new PgVectorSearch(database),
    new PgLexicalSearch(database),
    new ConversationContextService(),
    new QueryRewriteService(llmRegistry.createRewriteGateway()),
    new CandidatePreparationService(),
    undefined,
    new RerankService(llmRegistry.createRerankGateway(), logger),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(),
    workspaceRepository,
  );
  const documentSearchService = new DocumentSearchService(
    documentRepository,
    retrievalPipeline,
    auditService,
  );
  const documentSearchHistoryService = new DocumentSearchHistoryService(
    auditEventRepository,
    documentRepository,
  );
  const chatService = new ChatService(
    conversationRepository,
    messageRepository,
    retrievalPipeline,
    llmRegistry.createChatGateway(),
    auditService,
    llmRegistry.createUnsupportedNoticeGenerator(),
    llmRegistry.createGroundedMissResponseComposer(),
  );
  const chatBootstrapService = new ChatBootstrapService(
    workspaceRepository,
    bootstrapGreetingCacheRepository,
    conversationRepository,
    llmRegistry.createChatGateway(),
    auditService,
  );
  const chatHistoryService = new ChatHistoryService(
    conversationRepository,
    messageRepository,
    auditEventRepository,
  );
  const evalLabService = new EvalLabService(
    new EvalRepository(database),
    chatHistoryService,
    new EvalReplayService(
      retrievalPipeline,
      llmRegistry.createChatGateway(),
      llmRegistry.createUnsupportedNoticeGenerator(),
      llmRegistry.createGroundedMissResponseComposer(),
    ),
  );
  const workspaceService = new WorkspaceService(workspaceRepository, auditService);
  const workspaceSessionService = new WorkspaceSessionService(workspaceService);
  const abuseControlService = new AbuseControlService(new AbuseControlRepository(database));
  const connectorRegistry = new ConnectorRegistry();
  registerBuiltInConnectors(connectorRegistry);
  if (env.CONNECTOR_ENCRYPTION_KEY) {
    connectorRegistry.setEncryptionKey(env.CONNECTOR_ENCRYPTION_KEY);
  } else {
    logger.warn(
      {
        remediation: "Set CONNECTOR_ENCRYPTION_KEY before saving or rotating connector secrets.",
      },
      "Connector secret encryption is not configured; secret-field writes will be rejected until this is fixed",
    );
  }
  const authService = new AuthService({
    env,
    accountRepository: new AccountRepository(database),
    userRepository,
    sessionRepository: new SessionRepository(database),
    workspaceTokenRepository: new WorkspaceTokenRepository(database),
    workspaceService,
    accountAccessService,
    accountInvitationService,
    auditService,
  });

  return {
    env,
    logger,
    authService,
    accountAccessService,
    accountInvitationService,
    workspaceSessionService,
    abuseControlService,
    auditService,
    workspaceService,
    ingestionSettingsService,
    retrievalSettingsService,
    documentIngestionService,
    documentImportService,
    documentSearchService,
    documentSearchHistoryService,
    workspaceIngestionReprocessService,
    documentProcessingWorker,
    documentDeletionService,
    chatService,
    chatBootstrapService,
    chatHistoryService,
    evalLabService,
    workspaceRepository,
    bootstrapGreetingCacheRepository,
    conversationRepository,
    messageRepository,
    connectorRegistry,
    connectorDb: database,
  };
};
