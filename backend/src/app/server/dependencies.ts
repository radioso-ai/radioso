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
import { HistoryItemsRepository } from "../../db/repositories/historyItemsRepository.js";
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
import { WorkspaceSummaryService } from "../../modules/workspace/services/workspaceSummaryService.js";
import { WorkspaceSessionService } from "../../modules/auth/services/workspaceSessionService.js";
import { DocumentDeletionService } from "../../modules/documents/services/documentDeletionService.js";
import { DocumentIngestionService } from "../../modules/documents/services/documentIngestionService.js";
import { DocumentImportService } from "../../modules/documents/services/documentImportService.js";
import { DocumentSearchHistoryService } from "../../modules/documents/services/documentSearchHistoryService.js";
import { DocumentSearchService } from "../../modules/documents/services/documentSearchService.js";
import { DocumentProcessingService } from "../../modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../modules/documents/services/documentProcessingWorker.js";
import { DocumentSourceContentService } from "../../modules/documents/services/documentSourceContentService.js";
import { WorkspaceIngestionReprocessService } from "../../modules/documents/services/workspaceIngestionReprocessService.js";
import { PgLexicalSearch } from "../../modules/retrieval/infra/lexicalSearch.js";
import { PgVectorSearch } from "../../modules/retrieval/infra/vectorSearch.js";
import { CandidatePreparationService } from "../../modules/retrieval/services/candidatePreparationService.js";
import { ConversationContextService } from "../../modules/retrieval/services/conversationContextService.js";
import { PromptBuilder } from "../../modules/retrieval/services/promptBuilder.js";
import { PromptContextSelectorService } from "../../modules/retrieval/services/promptContextSelectorService.js";
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
import { AbuseControlRepository } from "../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import { Database } from "../../shared/infra/database.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import { ProductAnalyticsService } from "../../shared/analytics/productAnalyticsService.js";
import { createLogger } from "../../shared/observability/logger.js";
import { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import { IncidentReportingService } from "../../shared/incidents/incidentReportingService.js";
import {
  createDefaultAnalyticsSinks,
  createDefaultApplicationComposition,
  createDefaultChunkingStrategyRegistry,
  createDefaultConnectorRegistry,
  createDefaultDocumentJobDispatcher,
  createDefaultDocumentStorage,
  createDefaultIncidentSinks,
  createDefaultTelemetrySinks,
  type ApplicationModule,
} from "../composition/index.js";
import type { AppDependencies } from "./types.js";

export interface BuildDependenciesOptions {
  modules?: ApplicationModule[];
}

export const buildDependencies = (env: Env = getEnv(), options: BuildDependenciesOptions = {}): AppDependencies => {
  const logger = createLogger();
  const composition = createDefaultApplicationComposition({
    logger,
    modules: options.modules,
  });
  const { metricsRegistry, sinks: defaultTelemetrySinks } = createDefaultTelemetrySinks(env);
  const telemetryService = new TelemetryService({
    enabled: env.OBSERVABILITY_ENABLED,
    environment: env.OBSERVABILITY_ENVIRONMENT,
    logger,
    service: env.OBSERVABILITY_SERVICE_NAME,
    sinks: [...defaultTelemetrySinks, ...composition.telemetrySinks],
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
    sinks: [
      ...createDefaultAnalyticsSinks({
        auditService,
        env,
        metricsRegistry,
      }),
      ...composition.productAnalyticsSinks,
    ],
  });
  const persistentIncidentReportingService = new IncidentReportingService({
    enabled: env.OBSERVABILITY_ENABLED,
    environment: env.OBSERVABILITY_ENVIRONMENT,
    logger,
    service: env.OBSERVABILITY_SERVICE_NAME,
    version: env.OBSERVABILITY_VERSION,
    sinks: [
      ...createDefaultIncidentSinks({
        auditService,
        env,
        metricsRegistry,
      }),
      ...composition.incidentSinks,
    ],
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
  const documentStorage = composition.documentStorage ?? createDefaultDocumentStorage(env);
  const documentSourceContentService = new DocumentSourceContentService(documentStorage);
  const documentProcessingJobRepository = new DocumentProcessingJobRepository(database);
  const documentJobDispatcher = composition.documentJobDispatcher ?? createDefaultDocumentJobDispatcher(env, logger);
  const chunkRepository = new ChunkRepository(database);
  const chunkingStrategyRegistry = createDefaultChunkingStrategyRegistry(embeddingService);
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
  const documentDeletionService = new DocumentDeletionService(
    documentRepository,
    documentStorage,
    auditService,
    composition.capabilityPolicy,
  );
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
    retrievalSettingsService,
  );
  const chatHistoryService = new ChatHistoryService(
    conversationRepository,
    messageRepository,
    auditEventRepository,
    new HistoryItemsRepository(database),
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
  const workspaceSummaryService = new WorkspaceSummaryService(documentRepository, conversationRepository);
  const workspaceSessionService = new WorkspaceSessionService(workspaceService);
  const abuseControlService = new AbuseControlService(new AbuseControlRepository(database));
  const connectorRegistry = createDefaultConnectorRegistry(composition.connectors);
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
    capabilityPolicy: composition.capabilityPolicy,
    applicationModules: composition.lifecycle,
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
    workspaceSummaryService,
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
