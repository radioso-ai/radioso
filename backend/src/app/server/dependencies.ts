import { getEnv, type Env } from "../config/env.js";
import { ChatService } from "../../modules/chat/services/chatService.js";
import { ChatBootstrapService } from "../../modules/chat/services/chatBootstrapService.js";
import { ChatHistoryService } from "../../modules/chat/services/chatHistoryService.js";
import { AssistantChatService } from "../../modules/chat/services/assistantChatService.js";
import { AssistantHistoryService } from "../../modules/chat/services/assistantHistoryService.js";
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
import { PasswordResetTokenRepository } from "../../db/repositories/passwordResetTokenRepository.js";
import { EmailVerificationTokenRepository } from "../../db/repositories/emailVerificationTokenRepository.js";
import { AuthService } from "../../modules/auth/services/authService.js";
import { EmailVerificationService } from "../../modules/auth/services/emailVerificationService.js";
import { PasswordResetService } from "../../modules/auth/services/passwordResetService.js";
import { AccountAccessService } from "../../modules/account/services/accountAccessService.js";
import { AccountInvitationService } from "../../modules/account/services/accountInvitationService.js";
import { AuditService } from "../../modules/audit/services/auditService.js";
import { createEmailService } from "../../modules/email/services/emailService.js";
import { WorkspaceService } from "../../modules/workspace/services/workspaceService.js";
import { WorkspaceSessionService } from "../../modules/auth/services/workspaceSessionService.js";
import { DocumentDeletionService } from "../../modules/documents/services/documentDeletionService.js";
import { DocumentIngestionService } from "../../modules/documents/services/documentIngestionService.js";
import { DocumentImportService } from "../../modules/documents/services/documentImportService.js";
import { DocumentSearchHistoryService } from "../../modules/documents/services/documentSearchHistoryService.js";
import { DocumentSearchService } from "../../modules/documents/services/documentSearchService.js";
import { DocumentProcessingService } from "../../modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../modules/documents/services/documentProcessingWorker.js";
import { CloudTasksDocumentJobDispatcher } from "../../modules/documents/infra/cloudTasksDocumentJobDispatcher.js";
import { DocumentSourceContentService } from "../../modules/documents/services/documentSourceContentService.js";
import { GcsDocumentStorage, type DocumentStoragePort } from "../../modules/documents/infra/gcsDocumentStorage.js";
import { LocalDocumentStorage } from "../../modules/documents/infra/localDocumentStorage.js";
import { WorkspaceIngestionReprocessService } from "../../modules/documents/services/workspaceIngestionReprocessService.js";
import { NoopDocumentJobDispatcher } from "../../modules/documents/services/documentJobDispatcher.js";
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
import { RetrievalAnswerService } from "../../modules/retrieval/services/retrievalAnswerService.js";
import { RetrievalSearchService } from "../../modules/retrieval/services/retrievalSearchService.js";
import { EmbeddingService } from "../../modules/retrieval/services/embeddingService.js";
import { IngestionSettingsService } from "../../modules/settings/services/ingestionSettingsService.js";
import { PlatformSettingsService } from "../../modules/settings/services/platformSettingsService.js";
import { RetrievalSettingsService } from "../../modules/settings/services/retrievalSettingsService.js";
import { ConnectorRegistry } from "../../modules/connectors/services/connectorRegistry.js";
import { AbuseControlRepository } from "../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import { registerBuiltInConnectors } from "../../modules/connectors/plugins/index.js";
import { Database } from "../../shared/infra/database.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import { buildAnalyticsSinks } from "../../shared/analytics/buildAnalyticsSinks.js";
import { ProductAnalyticsService } from "../../shared/analytics/productAnalyticsService.js";
import { buildIncidentSinks } from "../../shared/incidents/buildIncidentSinks.js";
import { createLogger } from "../../shared/observability/logger.js";
import { buildTelemetrySinks } from "../../shared/observability/telemetry/buildTelemetrySinks.js";
import { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import { IncidentReportingService } from "../../shared/incidents/incidentReportingService.js";
import type { AppDependencies } from "./types.js";

export const buildDependencies = (env: Env = getEnv()): AppDependencies => {
  const logger = createLogger();
  const { metricsRegistry, sinks: telemetrySinks } = buildTelemetrySinks(env);
  const telemetryService = new TelemetryService({
    enabled: env.OBSERVABILITY_ENABLED,
    environment: env.OBSERVABILITY_ENVIRONMENT,
    logger,
    service: env.OBSERVABILITY_SERVICE_NAME,
    sinks: telemetrySinks,
    version: env.OBSERVABILITY_VERSION,
  });
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
  const productAnalyticsService = new ProductAnalyticsService({
    enabled: env.OBSERVABILITY_ENABLED,
    logger,
    sinks: buildAnalyticsSinks({
      auditService,
      env,
      metricsRegistry,
    }),
  });
  const persistentIncidentReportingService = new IncidentReportingService({
    enabled: env.OBSERVABILITY_ENABLED,
    environment: env.OBSERVABILITY_ENVIRONMENT,
    logger,
    service: env.OBSERVABILITY_SERVICE_NAME,
    version: env.OBSERVABILITY_VERSION,
    sinks: buildIncidentSinks({
      auditService,
      env,
      metricsRegistry,
    }),
  });
  const accountMembershipRepository = new AccountMembershipRepository(database);
  const accountRepository = new AccountRepository(database);
  const userRepository = new UserRepository(database);
  const sessionRepository = new SessionRepository(database);
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
    productAnalyticsService,
  );
  const documentStorage: DocumentStoragePort = env.DOCUMENT_STORAGE_DRIVER === "gcs"
    ? new GcsDocumentStorage(env.DOCUMENT_STORAGE_BUCKET!)
    : new LocalDocumentStorage(env.DOCUMENT_STORAGE_LOCAL_PATH);
  const documentSourceContentService = new DocumentSourceContentService(documentStorage);
  const documentProcessingJobRepository = new DocumentProcessingJobRepository(database);
  const documentJobDispatcher = env.WORKER_DISPATCH_DRIVER === "cloud-tasks"
    ? new CloudTasksDocumentJobDispatcher({
        projectId: env.GOOGLE_CLOUD_PROJECT!,
        location: env.WORKER_TASKS_QUEUE_LOCATION!,
        queueName: env.WORKER_TASKS_QUEUE_NAME!,
        workerServiceUrl: env.WORKER_TASKS_SERVICE_URL!,
        invokerServiceAccountEmail: env.WORKER_TASKS_INVOKER_SERVICE_ACCOUNT!,
        logger,
      })
    : new NoopDocumentJobDispatcher();
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
    documentProcessingJobRepository,
    documentJobDispatcher,
    productAnalyticsService,
  );
  const documentImportService = new DocumentImportService(
    documentRepository,
    auditService,
    documentStorage,
    () => documentProcessingJobRepository.getQueueSnapshot(),
    documentProcessingJobRepository,
    documentJobDispatcher,
  );
  const documentProcessingWorker = new DocumentProcessingWorker(
    documentRepository,
    documentProcessingJobRepository,
    documentProcessingService,
    auditService,
    logger,
    undefined,
    documentJobDispatcher,
    env.DOCUMENT_PROCESSING_JOB_LEASE_MS,
    telemetryService,
  );
  const documentDeletionService = new DocumentDeletionService(documentRepository, documentStorage, auditService);
  const workspaceIngestionReprocessService = new WorkspaceIngestionReprocessService(
    documentRepository,
    auditService,
    documentProcessingJobRepository,
    documentJobDispatcher,
  );
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
    new QueryRewriteService(llmRegistry.createRewriteGateway(), llmRegistry.createTriggerAnalysisGateway()),
    new CandidatePreparationService(),
    undefined,
    new RerankService(llmRegistry.createRerankGateway(), logger),
    new PromptContextSelectorService(),
    new PromptBuilder(),
    new RetrievalExecutionTelemetryService(telemetryService),
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
  const chatGateway = llmRegistry.createChatGateway();
  const groundedMissResponseComposer = llmRegistry.createGroundedMissResponseComposer();
  const chatService = new ChatService(
    conversationRepository,
    messageRepository,
    retrievalPipeline,
    chatGateway,
    auditService,
    groundedMissResponseComposer,
    productAnalyticsService,
    workspaceRepository,
  );
  const chatBootstrapService = new ChatBootstrapService(
    workspaceRepository,
    bootstrapGreetingCacheRepository,
    conversationRepository,
    chatGateway,
    auditService,
  );
  const chatHistoryService = new ChatHistoryService(
    conversationRepository,
    messageRepository,
    auditEventRepository,
  );
  const assistantChatService = new AssistantChatService(chatService, chatBootstrapService);
  const assistantHistoryService = new AssistantHistoryService(chatHistoryService);
  const retrievalSearchService = new RetrievalSearchService(retrievalPipeline);
  const retrievalAnswerService = new RetrievalAnswerService({
    retrievalPipeline,
    chatGateway,
  });
  const platformSettingsService = new PlatformSettingsService({
    workspaceRepository,
    retrievalSettingsService,
    auditService,
    publicChatBaseUrl: env.PUBLIC_CHAT_BASE_URL,
  });
  const workspaceService = new WorkspaceService(workspaceRepository, auditService, accountMembershipRepository);
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
  const emailService = createEmailService(env);
  const emailVerificationService = new EmailVerificationService({
    env,
    auditService,
    emailService,
    tokenRepository: new EmailVerificationTokenRepository(database),
    userRepository,
  });
  const verificationAwareAuthService = new AuthService({
    env,
    accountRepository,
    userRepository,
    sessionRepository,
    workspaceTokenRepository: new WorkspaceTokenRepository(database),
    workspaceService,
    accountAccessService,
    accountInvitationService,
    emailVerificationService,
    auditService,
  });
  const passwordResetService = new PasswordResetService({
    env,
    auditService,
    accountRepository,
    accountAccessService,
    emailService,
    passwordResetTokenRepository: new PasswordResetTokenRepository(database),
    sessionRepository,
    userRepository,
    workspaceService,
  });

  return {
    env,
    logger,
    metricsRegistry,
    telemetryService,
    incidentReportingService: persistentIncidentReportingService,
    productAnalyticsService,
    authService: verificationAwareAuthService,
    passwordResetService,
    emailVerificationService,
    emailService,
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
    assistantChatService,
    assistantHistoryService,
    retrievalSearchService,
    retrievalAnswerService,
    platformSettingsService,
    accountRepository,
    workspaceRepository,
    bootstrapGreetingCacheRepository,
    conversationRepository,
    messageRepository,
    connectorRegistry,
    connectorDb: database,
  };
};
