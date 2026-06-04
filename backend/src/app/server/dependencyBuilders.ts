import { AccountInvitationRepository } from "../../db/repositories/accountInvitationRepository.js";
import { AccountMembershipRepository } from "../../db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../db/repositories/accountRepository.js";
import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { AgentRepository } from "../../db/repositories/agentRepository.js";
import { RoutineStateRepository } from "../../db/repositories/routineStateRepository.js";
import { createConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";
import type { AgentSurfaceExtensionRegistry } from "../../modules/agents/public.js";
import { AuditEventRepository } from "../../db/repositories/auditEventRepository.js";
import { BootstrapGreetingCacheRepository } from "../../db/repositories/bootstrapGreetingCacheRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { DocumentProcessingJobRepository } from "../../db/repositories/documentProcessingJobRepository.js";
import { DocumentRepository } from "../../db/repositories/documentRepository.js";
import { DocumentSourceRepository } from "../../db/repositories/documentSourceRepository.js";
import { EmailVerificationTokenRepository } from "../../db/repositories/emailVerificationTokenRepository.js";
import { HistoryItemsRepository } from "../../db/repositories/historyItemsRepository.js";
import { IngestionSettingsRepository } from "../../db/repositories/ingestionSettingsRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import { PasswordResetTokenRepository } from "../../db/repositories/passwordResetTokenRepository.js";
import { RetrievalSettingsRepository } from "../../db/repositories/retrievalSettingsRepository.js";
import { SessionRepository } from "../../db/repositories/sessionRepository.js";
import { UserRepository } from "../../db/repositories/userRepository.js";
import { WebsiteCrawlJobRepository } from "../../db/repositories/websiteCrawlJobRepository.js";
import { WorkspaceGrantRepository } from "../../db/repositories/workspaceGrantRepository.js";
import { WorkspaceRepository } from "../../db/repositories/workspaceRepository.js";
import { WorkspaceTokenRepository } from "../../db/repositories/workspaceTokenRepository.js";
import { PostgresAssistantTurnPersistence } from "../../modules/chat/infra/postgresAssistantTurnPersistence.js";
import { AccountAccessService, AccountInvitationService } from "../../modules/account/public.js";
import { AgentService } from "../../modules/agents/public.js";
import { AuditService } from "../../modules/audit/composition.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { AuthService } from "../../modules/auth/services/authService.js";
import { EmailVerificationService } from "../../modules/auth/services/emailVerificationService.js";
import { PasswordResetService } from "../../modules/auth/services/passwordResetService.js";
import { WorkspaceSessionService } from "../../modules/auth/services/workspaceSessionService.js";
import {
  ActionDispatcher,
  ActionDispatchWorker,
  ActionHandlerRegistry,
  AssistantChatService,
  AssistantHistoryService,
  AnswerPresentationService,
  ChatActionSuggestionRegistry,
  ChatActionSuggestionService,
  ChatBootstrapService,
  ChatHistoryService,
  ChatService,
  type ChatRoutineProvider,
  ChainedPublicChatActionAdvertiser,
  buildChatTurnRuntime,
  createRouteScopedDirectiveSteering,
  createSkillOutcomeCapabilityProvider,
  NoopAnswerFeedbackHistoryProvider,
  NoopPublicChatActionAdvertiser,
  NoopContactHistoryProvider,
  resolveCitationArtifacts,
  RetrievalTurnController,
  RoutineRegistry,
  RoutineNextStepSelector,
  RoutineStepRenderer,
  SkillRetrievalTurnDispatch,
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
  ChunkRepository,
  type DocumentJobDispatcherPort,
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
  AgenticRetrievalPipelineService,
  AgenticRetrievalRunner,
  EmbeddingService,
  GatewayQueryRewritePortAdapter,
  PgLexicalSearch,
  PgVectorChunkStorage,
  PgVectorSearch,
  PromptBuilder,
  RetrievalAnswerExecutor,
  RetrievalAnswerService,
  createDefaultRetrievalServices,
  type RetrievalPipelinePort,
} from "../../modules/retrieval/composition.js";
import { DefaultAgentRuntime } from "../../shared/agent-runtime/index.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import { AbuseControlRepository } from "../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import {
  WorkspaceProviderCredentialsRepository,
  type WorkspaceProviderCredentialsRepositoryPort,
} from "../../db/repositories/workspaceProviderCredentialsRepository.js";
import { WorkspaceProviderCredentialsService } from "../../modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { WorkspaceLlmCapabilitySettingsService } from "../../modules/settings/composition.js";
import type { WorkspaceLlmCapabilityPreferencesRepositoryPort } from "../../modules/settings/composition.js";
import { WorkspaceLlmCapabilityResolver } from "../composition/workspaceLlmCapabilityResolver.js";
import type { LlmCapabilityResolver } from "../../shared/infra/llm/capabilityResolver.js";
import type { LlmProviderName } from "../../shared/infra/llm/providerTypes.js";
import {
  embeddingModelIds,
  IngestionSettingsService,
  PlatformSettingsService,
  RetrievalSettingsService,
} from "../../modules/settings/composition.js";
import type { EmbeddingModelId } from "../../modules/settings/contracts/ingestion.js";
import { SkillCatalogService, retrievalAnswerSkillDefinition } from "../../modules/skills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER, RetrievalAnswerSkillExecutor } from "../../modules/retrieval/public.js";
import { WebsiteCrawlJobService } from "../../modules/websiteCrawler/jobService.js";
import { RadiosoCrawlerProvider } from "../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import { WebsiteCrawlWorker } from "../../modules/websiteCrawler/worker.js";
import { WorkspaceService, WorkspaceSummaryService } from "../../modules/workspace/public.js";
import { ProductAnalyticsService } from "../../shared/analytics/productAnalyticsService.js";
import { NoopUsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import {
  DurableUsageEventRecorder,
  requireTransactionalUsageEventDatabase,
} from "../../shared/infra/usage/durableUsageEventRecorder.js";
import { ErrorReportingService } from "../../shared/errors/errorReportingService.js";
import { Database } from "../../shared/infra/database.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import { createMailService } from "../../modules/mail/public.js";
import { createLogger, type AppLogger } from "../../shared/observability/logger.js";
import { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import {
  createDefaultAnalyticsSinks,
  createDefaultErrorSinks,
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
  const errorReportingService = new ErrorReportingService({
    enabled: env.OBSERVABILITY_ENABLED,
    environment: env.OBSERVABILITY_ENVIRONMENT,
    logger,
    service: env.OBSERVABILITY_SERVICE_NAME,
    version: env.OBSERVABILITY_VERSION,
    sinks: [
      ...createDefaultErrorSinks({
        auditService,
        env,
        metricsRegistry,
      }),
      ...composition.errorSinks,
    ],
  });
  const usageLimitPolicy = !composition.usageLimitPolicyRegistration
    ? new NoopUsageLimitPolicy()
    : typeof composition.usageLimitPolicyRegistration === "function"
      ? composition.usageLimitPolicyRegistration({ database, logger })
      : composition.usageLimitPolicyRegistration;
  // OSS default: durable usage accounting out of the box (FR-027). A module may
  // still override the recorder by registering its own.
  const usageEventRecorder = !composition.usageEventRecorderRegistration
    ? new DurableUsageEventRecorder(requireTransactionalUsageEventDatabase(database), logger)
    : typeof composition.usageEventRecorderRegistration === "function"
      ? composition.usageEventRecorderRegistration({ database, logger })
      : composition.usageEventRecorderRegistration;
  const mailService = createMailService(process.env);

  return {
    auditEventRepository,
    auditService,
    database,
    errorReportingService,
    mailService,
    metricsRegistry,
    productAnalyticsService,
    telemetryService,
    usageLimitPolicy,
    usageEventRecorder,
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
  chunkRepository: new ChunkRepository(database, new PgVectorChunkStorage()),
  conversationRepository: new ConversationRepository(database),
  documentProcessingJobRepository: new DocumentProcessingJobRepository(database),
  documentRepository: new DocumentRepository(database),
  documentSourceRepository: new DocumentSourceRepository(database),
  emailVerificationTokenRepository: new EmailVerificationTokenRepository(database),
  historyItemsRepository: new HistoryItemsRepository(database),
  ingestionSettingsRepository: new IngestionSettingsRepository(database),
  messageRepository: new MessageRepository(database),
  passwordResetTokenRepository: new PasswordResetTokenRepository(database),
  retrievalSettingsRepository: new RetrievalSettingsRepository(database),
  sessionRepository: new SessionRepository(database),
  userRepository: new UserRepository(database),
  websiteCrawlJobRepository: new WebsiteCrawlJobRepository(database),
  workspaceGrantRepository: new WorkspaceGrantRepository(database),
  workspaceRepository: new WorkspaceRepository(database),
  workspaceTokenRepository: new WorkspaceTokenRepository(database),
  abuseControlRepository: new AbuseControlRepository(database),
  accountInvitationRepository: new AccountInvitationRepository(database),
  workspaceProviderCredentialsRepository: new WorkspaceProviderCredentialsRepository(database),
});

export const buildAccessServices = (input: {
  auditService: AuditService;
  repositories: ReturnType<typeof buildRepositories>;
}) => {
  const { auditService, repositories } = input;
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
  };
};

export const buildWorkspaceProviderCredentialsService = (input: {
  auditService: AuditPort;
  env: Pick<Env, "CONNECTOR_ENCRYPTION_KEY">;
  logger: Pick<AppLogger, "warn">;
  repositories: { workspaceProviderCredentialsRepository: WorkspaceProviderCredentialsRepositoryPort };
}): WorkspaceProviderCredentialsService => {
  const service = new WorkspaceProviderCredentialsService(
    input.repositories.workspaceProviderCredentialsRepository,
    input.auditService,
    { key: input.env.CONNECTOR_ENCRYPTION_KEY },
    input.logger,
  );
  service.onDecryptError((error, provider) => {
    input.logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        provider,
        remediation:
          "Stored credential ciphertext could not be decrypted. Re-enter the API key for this provider after rotating CONNECTOR_ENCRYPTION_KEY.",
      },
      "Workspace provider credential decrypt failed",
    );
  });
  if (!service.isEncryptionConfigured()) {
    input.logger.warn(
      {
        remediation: "Set CONNECTOR_ENCRYPTION_KEY before saving workspace provider API keys.",
      },
      "Workspace provider credential encryption is not configured; credential writes will be rejected until this is fixed",
    );
  }
  return service;
};

export const buildWorkspaceLlmCapabilitySettingsService = (input: {
  auditService: AuditPort;
  capabilityRepository: WorkspaceLlmCapabilityPreferencesRepositoryPort;
  retrievalSettingsService: Pick<RetrievalSettingsService, "getForWorkspace">;
  logger?: Pick<AppLogger, "warn">;
}): WorkspaceLlmCapabilitySettingsService =>
  new WorkspaceLlmCapabilitySettingsService(
    input.capabilityRepository,
    input.retrievalSettingsService,
    input.auditService,
    input.logger,
  );

const envApiKeyMap = (env: Env): Partial<Record<LlmProviderName, string>> => ({
  openai: env.OPENAI_API_KEY,
  "openai-compatible": env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY,
  gemini: env.GEMINI_API_KEY,
  claude: env.ANTHROPIC_API_KEY,
});

export const buildLlmCapabilityResolver = (input: {
  env: Env;
  defaults: ReturnType<typeof resolveLlmConfig>;
  settings: WorkspaceLlmCapabilitySettingsService;
  credentials: WorkspaceProviderCredentialsService;
}): LlmCapabilityResolver => {
  const keys = envApiKeyMap(input.env);
  return new WorkspaceLlmCapabilityResolver({
    defaults: input.defaults,
    settings: {
      getPreference: (workspaceId, capability) => input.settings.getPreference(workspaceId, capability),
    },
    credentials: {
      getApiKey: (workspaceId, provider) => input.credentials.getApiKey(workspaceId, provider),
    },
    envKeys: {
      resolveEnvApiKey: (provider) => keys[provider],
    },
    envBaseUrls: {
      "openai-compatible": input.env.OPENAI_COMPATIBLE_BASE_URL,
    },
  });
};

export const buildLlmRegistry = (
  env: Env,
  logger: AppLogger,
  options: { resolver?: LlmCapabilityResolver } = {},
): LlmProviderRegistry => {
  const llmRegistry = new LlmProviderRegistry(resolveLlmConfig(env), logger, { resolver: options.resolver });
  logger.info({ llmProviders: llmRegistry.describe() }, "Resolved LLM providers");
  return llmRegistry;
};

export const buildSettingsServices = (input: {
  auditService: AuditService;
  documentRepository: DocumentRepository;
  ingestionSettingsRepository: IngestionSettingsRepository;
  productAnalyticsService: ProductAnalyticsService;
  retrievalSettingsRepository: RetrievalSettingsRepository;
  supportedEmbeddingModels?: readonly EmbeddingModelId[];
  workspaceIngestionReprocessService?: Pick<WorkspaceIngestionReprocessService, "reprocessWorkspace">;
}) => {
  const ingestionSettingsService = new IngestionSettingsService(
    input.ingestionSettingsRepository,
    input.auditService,
    input.documentRepository,
    input.supportedEmbeddingModels,
    input.workspaceIngestionReprocessService,
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

export const listSupportedEmbeddingModels = (llmRegistry: LlmProviderRegistry): readonly EmbeddingModelId[] =>
  embeddingModelIds.filter((model) => llmRegistry.canServeEmbeddingModel(model));

export const buildWorkspaceIngestionReprocessService = (input: {
  auditService: AuditService;
  documentJobDispatcher: DocumentJobDispatcherPort;
  repositories: ReturnType<typeof buildRepositories>;
}): WorkspaceIngestionReprocessService =>
  new WorkspaceIngestionReprocessService(
    input.repositories.documentRepository,
    input.auditService,
    input.repositories.documentProcessingJobRepository,
    input.documentJobDispatcher,
  );

export const buildDocumentServices = (input: {
  auditService: AuditService;
  composition: ApplicationComposition;
  documentJobDispatcher?: DocumentJobDispatcherPort;
  documentSourceRepository: DocumentSourceRepository;
  env: Env;
  logger: AppLogger;
  productAnalyticsService: ProductAnalyticsService;
  repositories: ReturnType<typeof buildRepositories>;
  auditEventRepository: AuditEventRepository;
  settings: ReturnType<typeof buildSettingsServices>;
  telemetryService: TelemetryService;
  usageLimitPolicy: ReturnType<typeof buildInfrastructure>["usageLimitPolicy"];
  usageEventRecorder: ReturnType<typeof buildInfrastructure>["usageEventRecorder"];
  embeddingService: EmbeddingService;
  llmRegistry: LlmProviderRegistry;
  workspaceIngestionReprocessService?: WorkspaceIngestionReprocessService;
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
    usageEventRecorder,
    embeddingService,
    llmRegistry,
  } = input;
  const documentStorage = composition.documentStorage ?? createDefaultDocumentStorage(env);
  const documentSourceContentService = new DocumentSourceContentService(documentStorage);
  const documentJobDispatcher =
    input.documentJobDispatcher ?? composition.documentJobDispatcher ?? createDefaultDocumentJobDispatcher(env, logger);
  const websiteCrawlJobDispatcher = createDefaultWebsiteCrawlJobDispatcher(env, logger);
  const websiteCrawlerProvider = composition.websiteCrawlerProvider ?? new RadiosoCrawlerProvider();
  const chunkingStrategyRegistry = createDefaultChunkingStrategyRegistry(
    embeddingService,
    composition.chunkingProvider,
  );
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
  const workspaceIngestionReprocessService =
    input.workspaceIngestionReprocessService ??
    buildWorkspaceIngestionReprocessService({
      auditService,
      documentJobDispatcher,
      repositories,
    });
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
  ingestionSettingsService: IngestionSettingsService;
  llmRegistry: LlmProviderRegistry;
  logger: AppLogger;
  retrievalSettingsService: RetrievalSettingsService;
  telemetryService: TelemetryService;
  usageEventRecorder: ReturnType<typeof buildInfrastructure>["usageEventRecorder"];
}) => {
  const retrieval = createDefaultRetrievalServices(input);
  const retrievalPipeline = buildRetrievalAnswerExecutor(retrieval.retrievalPipeline, input);
  return {
    ...retrieval,
    retrievalPipeline,
    documentSearchService: new DocumentSearchService(
      input.documentRepository,
      retrievalPipeline,
      input.auditService,
    ),
  };
};

// The retrieval controller: it selects fixed vs reasoning per turn from the
// workspace's `retrievalStrategy` preference and dispatches. The reasoning
// strategy (the agent runtime) is constructed lazily so it costs nothing for
// workspaces that never select it.
const buildRetrievalAnswerExecutor = (
  deterministic: RetrievalPipelinePort,
  input: {
    embeddingService: EmbeddingService;
    database: Database;
    llmRegistry: LlmProviderRegistry;
    logger: AppLogger;
    telemetryService: TelemetryService;
    ingestionSettingsService?: IngestionSettingsService;
    usageEventRecorder: ReturnType<typeof buildInfrastructure>["usageEventRecorder"];
  },
): RetrievalPipelinePort =>
  new RetrievalAnswerExecutor({
    fixed: deterministic,
    reasoning: () => {
      const systemPrompt = loadPromptTemplate("agentic-retrieval/system.md");
      const runner = new AgenticRetrievalRunner({
        runtime: new DefaultAgentRuntime({ gateway: input.llmRegistry.createToolCallingGateway(input.usageEventRecorder) }),
        embeddings: input.embeddingService,
        vectorSearch: new PgVectorSearch(input.database),
        lexicalSearch: new PgLexicalSearch(input.database),
        queryRewrite: new GatewayQueryRewritePortAdapter(input.llmRegistry.createRewriteGateway(input.usageEventRecorder)),
        rerankGateway: input.llmRegistry.createRerankGateway(input.usageEventRecorder),
      });
      return new AgenticRetrievalPipelineService({
        deterministic,
        runner,
        promptBuilder: new PromptBuilder(),
        systemPrompt,
        ingestionSettingsService: input.ingestionSettingsService,
      });
    },
    onStrategySelected: (selection, { workspaceId }) => {
      void input.telemetryService.emit({
        eventType: "retrieval.strategy.selected",
        correlation: { workspaceId },
        metadata: {
          workspaceId,
          strategy: selection.strategy,
          selectionMode: selection.selectionMode,
          selectionReason: selection.selectionReason,
        },
        tags: { strategy: selection.strategy },
      });
    },
  });

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
  mailService: ReturnType<typeof buildInfrastructure>["mailService"];
  usageEventRecorder: ReturnType<typeof buildInfrastructure>["usageEventRecorder"];
  retrievalPipeline: RetrievalPipelinePort;
  usageLimitPolicy: ReturnType<typeof buildInfrastructure>["usageLimitPolicy"];
  workspaceRepository: WorkspaceRepository;
  assertPublicWebsiteUrl: (url: string) => Promise<void>;
}) => {
  const chatGateway = input.llmRegistry.createChatGateway(input.usageEventRecorder);
  const answerPresentationService = new AnswerPresentationService();
  const answerPresentation = {
    normalize: answerPresentationService.normalize.bind(answerPresentationService),
    present: answerPresentationService.present.bind(answerPresentationService),
    resolveCitationArtifacts,
  };
  const abuseControlService = new AbuseControlService(new AbuseControlRepository(input.database));
  const publicChatActionAdvertiserContext = {
    database: input.database,
    chatGateway,
    logger: input.logger,
    conversationRepository: input.conversationRepository,
    messageRepository: input.messageRepository,
    workspaceContactInfoRepository: {
      async findById(workspaceId: string) {
        const workspace = await input.workspaceRepository.findById(workspaceId);
        return workspace
          ? {
              id: workspace.id,
              name: workspace.name,
              publicRouteKey: workspace.publicRouteKey,
            }
          : null;
      },
    },
    auditService: input.auditService,
    abuseControlService,
    mailService: input.mailService,
    dashboardBaseUrl: input.env.APP_BASE_URL ?? null,
    assertPublicWebsiteUrl: input.assertPublicWebsiteUrl,
    skillExecutorRegistry: input.composition.skillExecutorRegistry,
    agentService: input.agentService,
  };
  // Register retrieval.answer as a dispatchable skill (spec 066 slice 1). The
  // chat path does not consume it yet; the loop re-seam (slice 2) routes through
  // it. Guarded so repeated dependency builds (tests) do not double-register.
  if (!input.composition.skillExecutorRegistry.resolve({ kind: "internal", adapter: RETRIEVAL_ANSWER_ADAPTER })) {
    input.composition.skillExecutorRegistry.register({
      kind: "internal",
      adapter: RETRIEVAL_ANSWER_ADAPTER,
      executor: new RetrievalAnswerSkillExecutor(input.retrievalPipeline),
    });
  }
  const publicChatActionAdvertisers = input.composition.publicChatActionAdvertiserRegistrations.map((registration) =>
    typeof registration === "function" ? registration(publicChatActionAdvertiserContext) : registration,
  );
  const publicChatActionAdvertiser = publicChatActionAdvertisers.length === 0
    ? new NoopPublicChatActionAdvertiser()
    : publicChatActionAdvertisers.length === 1
      ? publicChatActionAdvertisers[0]!
      : new ChainedPublicChatActionAdvertiser(publicChatActionAdvertisers);
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
  const resolvedChatActionSuggestionProviders = input.composition.chatActionSuggestionProviders.map(
    (registration) =>
      typeof registration === "function"
        ? registration({
            database: input.database,
            chatGateway,
            logger: input.logger,
            auditService: input.auditService,
          })
        : registration,
  );
  const chatActionSuggestionService = new ChatActionSuggestionService(
    new ChatActionSuggestionRegistry(resolvedChatActionSuggestionProviders),
    {
      onError: (providerName, error) => {
        input.logger.error(
          {
            providerName,
            err: error instanceof Error ? error.message : String(error),
          },
          "Chat action suggestion provider failed",
        );
      },
    },
  );
  const fallbackReplyComposer = input.llmRegistry.createFallbackReplyComposer(
    input.usageEventRecorder,
  );
  // Composition owns terminal-answer skill registration: assemble the chat turn
  // runtime here and inject it, so the host does not inline composer wiring.
  const chatTurnRuntime = buildChatTurnRuntime({
    chatGateway,
    fallbackReplyComposer,
    chatActionSuggestionService,
    skillOutcomeCapabilities: createSkillOutcomeCapabilityProvider(
      input.composition.skillCatalogRegistry,
    ),
  });
  // Behavioral steering comes from application composition. Chat and direct
  // retrieval answer surfaces share this port so extracted answer directives
  // stay consistent across `/assistant/chat`, `/retrieval/answer`, and MCP.
  const directiveSteering = createRouteScopedDirectiveSteering({
    capabilityPolicy: input.composition.capabilityPolicy,
    registrations: input.composition.directiveRegistrations,
    // Composition may register a contextual matcher; defaults to always-match.
    matcher: input.composition.directiveMatcher,
  });
  // Async conversation actions (spec 070). A routine action step enqueues an intent to
  // the outbox during the turn (`actionOutbox`); the worker drains and routes it to a
  // registered handler out of band (`actionDispatchWorker`). The two share one repository
  // so the same table backs the enqueue and the drain.
  const actionOutbox = new ActionRequestRepository(input.database);
  const actionHandlerRegistry = new ActionHandlerRegistry(
    input.composition.actionHandlerRegistrations.map((registration) => ({
      type: registration.type,
      handler:
        typeof registration.handler === "function"
          ? registration.handler({
              database: input.database,
              env: input.env,
              logger: input.logger,
              mailService: input.mailService,
              assertPublicWebsiteUrl: input.assertPublicWebsiteUrl,
            })
          : registration.handler,
    })),
  );
  const actionDispatchWorker = new ActionDispatchWorker(
    new ActionDispatcher(actionOutbox, actionHandlerRegistry),
    { logger: input.logger },
  );
  // Routine machinery (spec 070 / #520). The store + provider are passed to ChatService
  // only when a host registered routines; with none registered the provider is absent,
  // so the engine routine ports stay unwired and turns are unchanged (no store load).
  // Composition owns the engine runner + LLM-adapter assembly so ChatService stays
  // free of engine internals — it just supplies the per-turn model gateway.
  const routineRegistry = new RoutineRegistry(input.composition.routineRegistrations);
  const routineProvider: ChatRoutineProvider | undefined = routineRegistry.isEmpty
    ? undefined
    : {
        isEmpty: false,
        activator: (modelGateway) => routineRegistry.activator(modelGateway),
        createRunner: (modelGateway) =>
          new DefaultRoutineRunner(
            routineRegistry.routines,
            new RoutineNextStepSelector(modelGateway, {
              promptTemplate: loadPromptTemplate("chat/routine-next-step.md"),
            }),
            new RoutineStepRenderer(modelGateway, {
              promptTemplate: loadPromptTemplate("chat/routine-step-reply.md"),
            }),
          ),
      };
  const chatService = new ChatService({
    conversationRepository: input.conversationRepository,
    messageRepository: input.messageRepository,
    // 066 slice 3: chat reaches retrieval only through a narrow turn port —
    // interpret via the controller, execute via the dispatched retrieval.answer
    // skill. ChatService carries no RetrievalPipelineService reference.
    retrievalTurn: new RetrievalTurnController(
      input.retrievalPipeline,
      new SkillRetrievalTurnDispatch(
        input.composition.skillExecutorRegistry,
        retrievalAnswerSkillDefinition,
        input.composition.capabilityPolicy,
      ),
    ),
    chatGateway,
    auditService: input.auditService,
    turnRuntime: chatTurnRuntime,
    productAnalyticsService: input.productAnalyticsService,
    workspaceRepository: input.workspaceRepository,
    usageLimitPolicy: input.usageLimitPolicy,
    agentService: input.agentService,
    // 067: behavioral steering. The standing set is supplied by application
    // composition; default answer behavior is registered by a built-in module.
    // The probabilistic (contextual) matcher is intentionally not wired here: the
    // LLM registry moved from a raw TextGenerationClient to usage-accounted
    // ModelInferencePipelines (#473), so wiring it requires refactoring
    // ModelDirectiveMatchGateway onto ModelInferencePipeline with a usage
    // context — a follow-up to land before any contextual directive ships.
    directiveSteering,
    // Turn selection strategy comes from composition (default: retrieval/direct
    // terminal turn). Registerable so a host can swap it.
    selectionStrategy: input.composition.selectionStrategy,
    // The reusable conversation engine is the chat turn spine in every
    // environment. ChatService keeps an engine-less path for tests, but
    // composition always wires it.
    conversationEngine: createConversationEngine(),
    // Turn-emitted action intents land here, persisted to the outbox and
    // dispatched out of band by `actionDispatchWorker` in the worker process.
    actionOutbox,
    assistantTurnPersistence: new PostgresAssistantTurnPersistence(input.database),
    // Routine resume/activate per turn — present only when routines are registered.
    routineStore: new RoutineStateRepository(input.database),
    routineProvider,
  });
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
    auditService: input.auditService,
    directiveSteering,
  });

  return {
    abuseControlService,
    answerPresentation,
    assistantChatService: new AssistantChatService(chatService, chatBootstrapService),
    assistantHistoryService: new AssistantHistoryService(chatHistoryService),
    publicChatActionAdvertiser,
    chatBootstrapService,
    chatGateway,
    chatHistoryService,
    chatService,
    contactHistoryProvider,
    retrievalAnswerService,
    actionDispatchWorker,
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

export const buildPasswordResetService = (input: {
  access: ReturnType<typeof buildAccessServices>;
  auditService: AuditService;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  repositories: ReturnType<typeof buildRepositories>;
  workspaceService: WorkspaceService;
}): PasswordResetService =>
  new PasswordResetService({
    env: input.env,
    userRepository: input.repositories.userRepository,
    accountRepository: input.repositories.accountRepository,
    accountAccessService: input.access.accountAccessService,
    workspaceService: input.workspaceService,
    sessionRepository: input.repositories.sessionRepository,
    passwordResetTokenRepository: input.repositories.passwordResetTokenRepository,
    mailService: input.infrastructure.mailService,
    auditService: input.auditService,
  });

export const buildEmailVerificationService = (input: {
  auditService: AuditService;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  repositories: ReturnType<typeof buildRepositories>;
}): EmailVerificationService =>
  new EmailVerificationService({
    env: input.env,
    userRepository: input.repositories.userRepository,
    emailVerificationTokenRepository: input.repositories.emailVerificationTokenRepository,
    mailService: input.infrastructure.mailService,
    auditService: input.auditService,
  });

export const buildLogger = (): AppLogger => createLogger();
