import { AccountInvitationRepository } from "../../db/repositories/accountInvitationRepository.js";
import { AccountMembershipRepository } from "../../db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../db/repositories/accountRepository.js";
import { AgentRepository } from "../../db/repositories/agentRepository.js";
import type { AgentSurfaceExtensionRegistry } from "../../modules/agents/public.js";
import { AuditEventRepository } from "../../db/repositories/auditEventRepository.js";
import { BootstrapGreetingCacheRepository } from "../../db/repositories/bootstrapGreetingCacheRepository.js";
import { ChunkRepository } from "../../db/repositories/chunkRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { DocumentProcessingJobRepository } from "../../db/repositories/documentProcessingJobRepository.js";
import { DocumentRepository } from "../../db/repositories/documentRepository.js";
import { DocumentSourceRepository } from "../../db/repositories/documentSourceRepository.js";
import { HistoryItemsRepository } from "../../db/repositories/historyItemsRepository.js";
import { IngestionSettingsRepository } from "../../db/repositories/ingestionSettingsRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import { RetrievalSettingsRepository } from "../../db/repositories/retrievalSettingsRepository.js";
import { SessionRepository } from "../../db/repositories/sessionRepository.js";
import { SupportImpersonationRepository } from "../../db/repositories/supportImpersonationRepository.js";
import { UserRepository } from "../../db/repositories/userRepository.js";
import { WebsiteCrawlJobRepository } from "../../db/repositories/websiteCrawlJobRepository.js";
import { WorkspaceGrantRepository } from "../../db/repositories/workspaceGrantRepository.js";
import { WorkspaceRepository } from "../../db/repositories/workspaceRepository.js";
import { WorkspaceTokenRepository } from "../../db/repositories/workspaceTokenRepository.js";
import { AccountAccessService, AccountInvitationService } from "../../modules/account/public.js";
import { AgentService } from "../../modules/agents/public.js";
import { AuditService } from "../../modules/audit/composition.js";
import { AuthService } from "../../modules/auth/services/authService.js";
import { WorkspaceSessionService } from "../../modules/auth/services/workspaceSessionService.js";
import {
  AssistantChatService,
  AssistantHistoryService,
  ChatBootstrapService,
  ChatHistoryService,
  ChatService,
  ChainedChatIntakeProvider,
  NoopAnswerFeedbackHistoryProvider,
  NoopChatIntakeProvider,
  NoopContactHistoryProvider,
} from "../../modules/chat/composition.js";
import {
  createDefaultConnectorRegistry,
  createDefaultChunkingStrategyRegistry,
  createDefaultDocumentJobConsumer,
  createDefaultDocumentJobDispatcher,
  createDefaultDocumentStorage,
  createDefaultWebsiteCrawlJobConsumer,
  createDefaultWebsiteCrawlJobDispatcher,
  type ApplicationComposition,
} from "../composition/index.js";
import {
  DocumentDeletionService,
  DocumentImportService,
  DocumentIngestionService,
  DocumentProcessingService,
  DocumentProcessingWorker,
  DocumentSearchHistoryService,
  DocumentSearchService,
  DocumentSourceContentService,
  WorkspaceIngestionReprocessService,
} from "../../modules/documents/composition.js";
import {
  CandidatePreparationService,
  ConversationContextService,
  EmbeddingService,
  PgLexicalSearch,
  PgVectorSearch,
  PromptBuilder,
  PromptContextSelectorService,
  QueryRewriteService,
  RerankService,
  RetrievalAnswerService,
  RetrievalExecutionTelemetryService,
  RetrievalPipelineService,
  RetrievalSearchService,
} from "../../modules/retrieval/composition.js";
import { AbuseControlRepository } from "../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import {
  IngestionSettingsService,
  PlatformSettingsService,
  RetrievalSettingsService,
} from "../../modules/settings/composition.js";
import { SkillCatalogService } from "../../modules/skills/public.js";
import { SupportImpersonationService } from "../../modules/support/services/supportImpersonationService.js";
import { WebsiteCrawlJobService } from "../../modules/websiteCrawler/jobService.js";
import { RadiosoCrawlerProvider } from "../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import { WebsiteCrawlWorker } from "../../modules/websiteCrawler/worker.js";
import { WorkspaceService, WorkspaceSummaryService } from "../../modules/workspace/public.js";
import { ProductAnalyticsService } from "../../shared/analytics/productAnalyticsService.js";
import { NoopUsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import { IncidentReportingService } from "../../shared/incidents/incidentReportingService.js";
import { Database } from "../../shared/infra/database.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import { createLogger, type AppLogger } from "../../shared/observability/logger.js";
import { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import {
  createDefaultAnalyticsSinks,
  createDefaultIncidentSinks,
  createDefaultTelemetrySinks,
} from "../composition/index.js";
import type { Env } from "../config/env.js";

export const buildInfrastructure = (input: {
  env: Env;
  logger: AppLogger;
  composition: ApplicationComposition;
}) => {
  const { env, logger, composition } = input;
  const { metricsRegistry, sinks: defaultTelemetrySinks } = createDefaultTelemetrySinks(env);
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
  const telemetryService = new TelemetryService({
    enabled: env.OBSERVABILITY_ENABLED,
    environment: env.OBSERVABILITY_ENVIRONMENT,
    logger,
    service: env.OBSERVABILITY_SERVICE_NAME,
    sinks: [...defaultTelemetrySinks, ...composition.telemetrySinks],
    version: env.OBSERVABILITY_VERSION,
  });
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
  const incidentReportingService = new IncidentReportingService({
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
  const usageLimitPolicy = !composition.usageLimitPolicyRegistration
    ? new NoopUsageLimitPolicy()
    : typeof composition.usageLimitPolicyRegistration === "function"
      ? composition.usageLimitPolicyRegistration({ database, logger })
      : composition.usageLimitPolicyRegistration;

  return {
    auditEventRepository,
    auditService,
    database,
    incidentReportingService,
    metricsRegistry,
    productAnalyticsService,
    telemetryService,
    usageLimitPolicy,
  };
};

export const buildRepositories = (
  database: Database,
  options: { agentSurfaceExtensions?: AgentSurfaceExtensionRegistry } = {},
) => ({
  accountMembershipRepository: new AccountMembershipRepository(database),
  accountRepository: new AccountRepository(database),
  agentRepository: new AgentRepository(database, options.agentSurfaceExtensions),
  bootstrapGreetingCacheRepository: new BootstrapGreetingCacheRepository(database),
  chunkRepository: new ChunkRepository(database),
  conversationRepository: new ConversationRepository(database),
  documentProcessingJobRepository: new DocumentProcessingJobRepository(database),
  documentRepository: new DocumentRepository(database),
  documentSourceRepository: new DocumentSourceRepository(database),
  historyItemsRepository: new HistoryItemsRepository(database),
  ingestionSettingsRepository: new IngestionSettingsRepository(database),
  messageRepository: new MessageRepository(database),
  retrievalSettingsRepository: new RetrievalSettingsRepository(database),
  sessionRepository: new SessionRepository(database),
  supportImpersonationRepository: new SupportImpersonationRepository(database),
  userRepository: new UserRepository(database),
  websiteCrawlJobRepository: new WebsiteCrawlJobRepository(database),
  workspaceGrantRepository: new WorkspaceGrantRepository(database),
  workspaceRepository: new WorkspaceRepository(database),
  workspaceTokenRepository: new WorkspaceTokenRepository(database),
  abuseControlRepository: new AbuseControlRepository(database),
  accountInvitationRepository: new AccountInvitationRepository(database),
});

export const buildAccessServices = (input: {
  auditService: AuditService;
  env: Env;
  repositories: ReturnType<typeof buildRepositories>;
}) => {
  const { auditService, env, repositories } = input;
  const supportImpersonationService = new SupportImpersonationService(
    repositories.supportImpersonationRepository,
    repositories.userRepository,
    auditService,
    env,
  );
  const accountAccessService = new AccountAccessService(
    repositories.accountMembershipRepository,
    auditService,
    repositories.workspaceGrantRepository,
    repositories.workspaceRepository,
  );
  const accountInvitationService = new AccountInvitationService(
    repositories.accountInvitationRepository,
    repositories.userRepository,
    accountAccessService,
    auditService,
  );

  return {
    accountAccessService,
    accountInvitationService,
    supportImpersonationService,
  };
};

export const buildLlmRegistry = (env: Env, logger: AppLogger): LlmProviderRegistry => {
  const llmRegistry = new LlmProviderRegistry(resolveLlmConfig(env), logger);
  logger.info({ llmProviders: llmRegistry.describe() }, "Resolved LLM providers");
  return llmRegistry;
};

export const buildSettingsServices = (input: {
  auditService: AuditService;
  documentRepository: DocumentRepository;
  ingestionSettingsRepository: IngestionSettingsRepository;
  productAnalyticsService: ProductAnalyticsService;
  retrievalSettingsRepository: RetrievalSettingsRepository;
}) => {
  const ingestionSettingsService = new IngestionSettingsService(
    input.ingestionSettingsRepository,
    input.auditService,
  );
  const retrievalSettingsService = new RetrievalSettingsService(
    input.retrievalSettingsRepository,
    input.auditService,
    input.documentRepository,
    input.productAnalyticsService,
  );

  return {
    ingestionSettingsService,
    retrievalSettingsService,
  };
};

export const buildDocumentServices = (input: {
  auditService: AuditService;
  composition: ApplicationComposition;
  documentSourceRepository: DocumentSourceRepository;
  env: Env;
  logger: AppLogger;
  productAnalyticsService: ProductAnalyticsService;
  repositories: ReturnType<typeof buildRepositories>;
  auditEventRepository: AuditEventRepository;
  settings: ReturnType<typeof buildSettingsServices>;
  telemetryService: TelemetryService;
  usageLimitPolicy: ReturnType<typeof buildInfrastructure>["usageLimitPolicy"];
  embeddingService: EmbeddingService;
}) => {
  const {
    auditService,
    composition,
    documentSourceRepository,
    env,
    logger,
    productAnalyticsService,
    repositories,
    settings,
    telemetryService,
    usageLimitPolicy,
    embeddingService,
  } = input;
  const documentStorage = composition.documentStorage ?? createDefaultDocumentStorage(env);
  const documentSourceContentService = new DocumentSourceContentService(documentStorage);
  const documentJobDispatcher = composition.documentJobDispatcher ?? createDefaultDocumentJobDispatcher(env, logger);
  const websiteCrawlJobDispatcher = createDefaultWebsiteCrawlJobDispatcher(env, logger);
  const websiteCrawlerProvider = composition.websiteCrawlerProvider ?? new RadiosoCrawlerProvider();
  const chunkingStrategyRegistry = createDefaultChunkingStrategyRegistry(embeddingService);
  const documentProcessingService = new DocumentProcessingService(
    repositories.documentRepository,
    repositories.chunkRepository,
    embeddingService,
    auditService,
    settings.ingestionSettingsService,
    chunkingStrategyRegistry,
    documentSourceContentService,
    logger,
  );
  const documentIngestionService = new DocumentIngestionService(
    repositories.documentRepository,
    auditService,
    () => repositories.documentProcessingJobRepository.getQueueSnapshot(),
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
    productAnalyticsService,
    usageLimitPolicy,
    documentSourceRepository,
  );
  const websiteCrawlJobService = new WebsiteCrawlJobService({
    repository: repositories.websiteCrawlJobRepository,
    dispatcher: websiteCrawlJobDispatcher,
    documentIngestionService,
    logger,
  });
  const documentImportService = new DocumentImportService(
    repositories.documentRepository,
    auditService,
    documentStorage,
    () => repositories.documentProcessingJobRepository.getQueueSnapshot(),
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
    usageLimitPolicy,
    documentSourceRepository,
  );
  const documentProcessingWorker = new DocumentProcessingWorker(
    repositories.documentRepository,
    repositories.documentProcessingJobRepository,
    documentProcessingService,
    auditService,
    logger,
    undefined,
    documentJobDispatcher,
    env.DOCUMENT_PROCESSING_JOB_LEASE_MS,
    telemetryService,
  );
  const documentJobConsumer = composition.documentJobConsumer ?? createDefaultDocumentJobConsumer(
    env,
    logger,
    documentProcessingWorker,
  );
  const websiteCrawlWorker = new WebsiteCrawlWorker({
    repository: repositories.websiteCrawlJobRepository,
    provider: websiteCrawlerProvider,
    documentIngestionService,
    auditService,
    logger,
    pollIntervalMs: env.WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS,
    jobLeaseMs: env.WEBSITE_CRAWL_JOB_LEASE_MS,
  });
  const websiteCrawlJobConsumer = createDefaultWebsiteCrawlJobConsumer(env, logger, websiteCrawlWorker);
  const documentDeletionService = new DocumentDeletionService(
    repositories.documentRepository,
    documentStorage,
    auditService,
    composition.capabilityPolicy,
  );
  const workspaceIngestionReprocessService = new WorkspaceIngestionReprocessService(
    repositories.documentRepository,
    auditService,
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
  );
  const documentSearchHistoryService = new DocumentSearchHistoryService(
    input.auditEventRepository,
    repositories.documentRepository,
  );

  return {
    documentDeletionService,
    documentImportService,
    documentIngestionService,
    documentJobConsumer,
    documentProcessingWorker,
    documentSearchHistoryService,
    documentStorage,
    websiteCrawlJobConsumer,
    websiteCrawlJobService,
    websiteCrawlerProvider,
    websiteCrawlWorker,
    workspaceIngestionReprocessService,
  };
};

export const buildRetrievalServices = (input: {
  auditService: AuditService;
  database: Database;
  documentRepository: DocumentRepository;
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
  const documentSearchService = new DocumentSearchService(
    input.documentRepository,
    retrievalPipeline,
    input.auditService,
  );
  const retrievalSearchService = new RetrievalSearchService(retrievalPipeline);

  return {
    documentSearchService,
    retrievalPipeline,
    retrievalSearchService,
  };
};

export const buildWorkspaceServices = (input: {
  accountMembershipRepository: AccountMembershipRepository;
  auditService: AuditService;
  conversationRepository: ConversationRepository;
  documentRepository: DocumentRepository;
  env: Env;
  workspaceRepository: WorkspaceRepository;
}) => {
  const workspaceService = new WorkspaceService(
    input.workspaceRepository,
    input.auditService,
    input.accountMembershipRepository,
  );
  return {
    workspaceService,
    workspaceSessionService: new WorkspaceSessionService(workspaceService),
    workspaceSummaryService: new WorkspaceSummaryService(input.documentRepository, input.conversationRepository, {
      websiteCrawlerEnabled: input.env.WEBSITE_CRAWLER_ENABLED,
    }),
  };
};

export const buildChatServices = (input: {
  agentService: AgentService;
  auditEventRepository: AuditEventRepository;
  auditService: AuditService;
  bootstrapGreetingCacheRepository: BootstrapGreetingCacheRepository;
  composition: ApplicationComposition;
  conversationRepository: ConversationRepository;
  database: Database;
  env: Env;
  historyItemsRepository: HistoryItemsRepository;
  llmRegistry: LlmProviderRegistry;
  logger: AppLogger;
  messageRepository: MessageRepository;
  productAnalyticsService: ProductAnalyticsService;
  retrievalPipeline: RetrievalPipelineService;
  usageLimitPolicy: ReturnType<typeof buildInfrastructure>["usageLimitPolicy"];
  workspaceRepository: WorkspaceRepository;
}) => {
  const chatGateway = input.llmRegistry.createChatGateway();
  const abuseControlService = new AbuseControlService(new AbuseControlRepository(input.database));
  const registeredChatIntakeProvider = !input.composition.chatIntakeProviderRegistration
    ? null
    : typeof input.composition.chatIntakeProviderRegistration === "function"
      ? input.composition.chatIntakeProviderRegistration({
          database: input.database,
          chatGateway,
          logger: input.logger,
          conversationRepository: input.conversationRepository,
          messageRepository: input.messageRepository,
          auditService: input.auditService,
          abuseControlService,
        })
      : input.composition.chatIntakeProviderRegistration;
  const chatIntakeProviders = [
    ...(registeredChatIntakeProvider ? [registeredChatIntakeProvider] : []),
  ];
  const chatIntakeProvider = chatIntakeProviders.length === 0
    ? new NoopChatIntakeProvider()
    : chatIntakeProviders.length === 1
      ? chatIntakeProviders[0]!
      : new ChainedChatIntakeProvider(chatIntakeProviders);
  const contactHistoryProvider = !input.composition.contactHistoryProviderRegistration
    ? new NoopContactHistoryProvider()
    : typeof input.composition.contactHistoryProviderRegistration === "function"
      ? input.composition.contactHistoryProviderRegistration({
          database: input.database,
          logger: input.logger,
        })
      : input.composition.contactHistoryProviderRegistration;
  const answerFeedbackHistoryProvider = !input.composition.answerFeedbackHistoryProviderRegistration
    ? new NoopAnswerFeedbackHistoryProvider()
    : typeof input.composition.answerFeedbackHistoryProviderRegistration === "function"
      ? input.composition.answerFeedbackHistoryProviderRegistration({
          database: input.database,
          logger: input.logger,
        })
      : input.composition.answerFeedbackHistoryProviderRegistration;
  const chatService = new ChatService(
    input.conversationRepository,
    input.messageRepository,
    input.retrievalPipeline,
    chatGateway,
    input.auditService,
    input.llmRegistry.createGroundedMissResponseComposer(),
    input.productAnalyticsService,
    input.workspaceRepository,
    input.usageLimitPolicy,
    input.agentService,
    chatIntakeProvider,
  );
  const chatBootstrapService = new ChatBootstrapService(
    input.workspaceRepository,
    input.bootstrapGreetingCacheRepository,
    chatGateway,
    input.auditService,
    input.usageLimitPolicy,
    input.productAnalyticsService,
    input.agentService,
  );
  const chatHistoryService = new ChatHistoryService(
    input.conversationRepository,
    input.messageRepository,
    input.auditEventRepository,
    input.historyItemsRepository,
    contactHistoryProvider,
    answerFeedbackHistoryProvider,
  );
  const retrievalAnswerService = new RetrievalAnswerService({
    retrievalPipeline: input.retrievalPipeline,
    chatGateway,
    usageLimitPolicy: input.usageLimitPolicy,
  });

  return {
    abuseControlService,
    assistantChatService: new AssistantChatService(chatService, chatBootstrapService),
    assistantHistoryService: new AssistantHistoryService(chatHistoryService),
    chatIntakeProvider,
    chatBootstrapService,
    chatGateway,
    chatHistoryService,
    chatService,
    contactHistoryProvider,
    retrievalAnswerService,
  };
};

export const buildConnectorRegistry = (input: {
  composition: ApplicationComposition;
  env: Env;
  logger: AppLogger;
}) => {
  const connectorRegistry = createDefaultConnectorRegistry(input.composition.connectors);
  if (input.env.CONNECTOR_ENCRYPTION_KEY) {
    connectorRegistry.setEncryptionKey(input.env.CONNECTOR_ENCRYPTION_KEY);
  } else {
    input.logger.warn(
      {
        remediation: "Set CONNECTOR_ENCRYPTION_KEY before saving or rotating connector secrets.",
      },
      "Connector secret encryption is not configured; secret-field writes will be rejected until this is fixed",
    );
  }
  return connectorRegistry;
};

export const buildAuthService = (input: {
  access: ReturnType<typeof buildAccessServices>;
  auditService: AuditService;
  env: Env;
  onAccountCreated?: (input: { accountId: string }) => Promise<void>;
  repositories: ReturnType<typeof buildRepositories>;
  workspaceService: WorkspaceService;
}): AuthService =>
  new AuthService({
    env: input.env,
    accountRepository: input.repositories.accountRepository,
    userRepository: input.repositories.userRepository,
    sessionRepository: input.repositories.sessionRepository,
    workspaceTokenRepository: input.repositories.workspaceTokenRepository,
    workspaceService: input.workspaceService,
    accountAccessService: input.access.accountAccessService,
    accountInvitationService: input.access.accountInvitationService,
    onAccountCreated: input.onAccountCreated,
    auditService: input.auditService,
  });

export const buildLogger = (): AppLogger => createLogger();
