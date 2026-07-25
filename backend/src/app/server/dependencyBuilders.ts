import { AccountInvitationRepository } from "../../db/repositories/accountInvitationRepository.js";
import { AccountMembershipRepository } from "../../db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../db/repositories/accountRepository.js";
import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { AccessGrantRepository } from "../../db/repositories/accessGrantRepository.js";
import { AgentRepository } from "../../db/repositories/agentRepository.js";
import { ContextVariableRepository } from "../../db/repositories/contextVariableRepository.js";
import { IdentityNonceRepository } from "../../db/repositories/identityNonceRepository.js";
import { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import { RoutineStateRepository } from "../../db/repositories/routineStateRepository.js";
import { DirectiveStateRepository } from "../../db/repositories/directiveStateRepository.js";
import { ConversationSummaryRepository } from "../../db/repositories/conversationSummaryRepository.js";
import {
  ConversationSummaryService,
  ModelConversationSummaryGenerator,
} from "../../modules/chat/composition.js";
import { PendingDecisionRepository } from "../../db/repositories/pendingDecisionRepository.js";
import { ClarificationStateRepository } from "../../db/repositories/clarificationStateRepository.js";
import { createConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";
import type { AgentSkillSettingsRegistry, AgentSurfaceExtensionRegistry } from "../../modules/agents/public.js";
import { AuditEventRepository } from "../../db/repositories/auditEventRepository.js";
import { BootstrapGreetingCacheRepository } from "../../db/repositories/bootstrapGreetingCacheRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
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
import { LlmResponseLanguageDetector } from "../../shared/services/responseLanguageDetector.js";
import { LlmHandoffWaitingMessageGenerator } from "../../shared/services/handoffWaitingMessageGenerator.js";
import { PostgresAssistantTurnPersistence } from "../../modules/chat/infra/postgresAssistantTurnPersistence.js";
import { registeredCapabilityNames } from "../../shared/domain/capabilityPolicy.js";
import { AccountAccessService, AccountInvitationService } from "../../modules/account/public.js";
import { AccessGrantService, DefaultOriginMatcher } from "../../modules/accessGrants/public.js";
import { AgentService } from "../../modules/agents/public.js";
import { AuditService } from "../../modules/audit/composition.js";
import { ApprovalDecisionService } from "../../modules/approvals/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { AuthService } from "../../modules/auth/services/authService.js";
import { PostgresOrganizationProvisioner } from "../../modules/auth/infra/postgresOrganizationProvisioner.js";
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
  ConversationForkService,
  ChatService,
  ChatTurnAssemblyFactory,
  InMemoryConversationTurnRegistry,
  LoggingConversationTurnInterruptionObserver,
  type ChatRoutineProvider,
  type PublicConversationEventBus,
  ChainedPublicChatActionAdvertiser,
  buildChatTurnRuntime,
  createRouteScopedDirectiveSteering,
  createSkillOutcomeCapabilityProvider,
  LlmTurnRouter,
  LlmConversationTurnInterpreter,
  ModelTurnInterpretationGateway,
  ModelTurnRouterGateway,
  NoopAnswerFeedbackHistoryProvider,
  NoopPublicChatActionAdvertiser,
  NoopContactHistoryProvider,
  RetrievalTurnController,
  RoutineRegistry,
  RoutineChatModelGateway,
  RoutineNextStepSelector,
  RoutineStepRenderer,
  RoutineSlotCorrector,
  RoutineReentryGate,
  DefaultClarifier,
  type RoutineActivationPrefilter,
  type RoutineRegistration,
  SkillRetrievalTurnDispatch,
  WorkbenchReplayRunner,
  TurnPlanCoordinator,
  TurnPlanService,
  planAwareRoutineActivator,
  planAwareRoutineReentryGate,
  planAwareRoutineSlotCorrection,
  AgentConverseAudit,
  AgentConverseService,
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
  DocumentEnrichmentService,
  DocumentImportService,
  DocumentIngestionService,
  ModelDocumentEnrichmentGateway,
  DocumentProcessingService,
  DocumentProcessingWorker,
  DocumentSearchHistoryService,
  DocumentSearchService,
  DocumentSourceReprocessService,
  DocumentSourceContentService,
  WorkspaceIngestionReprocessService,
  AgentConverseResourceService,
} from "../../modules/documents/composition.js";
import {
  AgenticRetrievalPipelineService,
  AgenticRetrievalRunner,
  EmbeddingService,
  GatewayQueryRewritePortAdapter,
  ModelSenseLabelGateway,
  PostgresChunkCandidateHydrator,
  PgLexicalSearch,
  PostgresSenseEmbeddingReader,
  PgVectorChunkStorage,
  PgVectorIndex,
  PromptBuilder,
  RetrievalAnswerExecutor,
  RetrievalAnswerService,
  SenseGroupingService,
  createDefaultRetrievalServices,
  AgentConverseGroundedAnswerService,
  type RetrievalSensePolicy,
  type RetrievalPipelinePort,
} from "../../modules/retrieval/composition.js";
import { AgenticCapabilityRunner, DefaultAgentRuntime } from "../../shared/agent-runtime/index.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import { AbuseControlRepository } from "../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import {
  WorkspaceProviderCredentialsRepository,
  type WorkspaceProviderCredentialsRepositoryPort,
} from "../../db/repositories/workspaceProviderCredentialsRepository.js";
import { WorkspaceProviderCredentialsService } from "../../modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { WebhookDestinationRepository } from "../../db/repositories/webhookDestinationRepository.js";
import { CustomerEmailConnectionRepository } from "../../db/repositories/customerEmailConnectionRepository.js";
import { EmailSkillDefinitionRepository } from "../../db/repositories/emailSkillDefinitionRepository.js";
import { EmailSkillActivityRepository } from "../../db/repositories/emailSkillActivityRepository.js";
import { WebhookSkillDefinitionRepository } from "../../db/repositories/webhookSkillDefinitionRepository.js";
import { OauthConnectionRepository } from "../../db/repositories/oauthConnectionRepository.js";
import { IntegrationConnectionRepository } from "../../modules/integrationConnections/public.js";
import {
  SlackChannelBindingRepository,
  SlackInstallationRepository,
} from "../../modules/slack/public.js";
import {
  DefaultWebhookDestinationAdapter,
  WebhookDestinationService,
  FetchWebhookHttpClient,
  type WebhookDestinationPublicAdapter,
  type WebhookDestinationRepositoryPort,
  type WebhookDestinationRoutineReferencePort,
  type WebhookDestinationRuntimePort,
} from "../../modules/webhooks/public.js";
import { WorkspaceLlmCapabilitySettingsService } from "../../modules/settings/composition.js";
import type { WorkspaceLlmCapabilityPreferencesRepositoryPort } from "../../modules/settings/composition.js";
import { WorkspaceLlmCapabilityResolver } from "../composition/workspaceLlmCapabilityResolver.js";
import type { LlmCapabilityResolver } from "../../shared/infra/llm/capabilityResolver.js";
import type { LlmProviderName } from "../../shared/infra/llm/providerTypes.js";
import {
  embeddingModelIds,
  IngestionSettingsService,
  PlatformSettingsService,
  AgentConverseSessionService,
} from "../../modules/settings/composition.js";
import type { EmbeddingModelId } from "../../modules/settings/contracts/ingestion.js";
import {
  SkillCatalogService,
  retrievalAnswerSkillDefinition,
  routineDispatchableBuiltInSkills,
} from "../../modules/skills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER, RetrievalAnswerSkillExecutor } from "../../modules/retrieval/public.js";
import { RetrieveRoutineSkillResolver } from "../../modules/retrieval/public.js";
import { EXTERNAL_SKILLS_ADAPTER, McpSkillExecutor } from "../../modules/externalSkills/executor/mcpSkillExecutor.js";
import { buildExternalSkillsDeps } from "../../modules/externalSkills/composition.js";
import { ExternalSkillRoutineSkillResolver } from "../../modules/externalSkills/routineSkillResolver.js";
import {
  CUSTOMER_EMAIL_SKILLS_ADAPTER,
  CustomerEmailDeliveryService,
  CustomerEmailRoutineSkillResolver,
  EmailSkillExecutor,
  MockCustomerEmailProviderAdapter,
  StaticCustomerEmailProviderRegistry,
  customerEmailOauthProviderIds,
} from "../../modules/customerEmail/public.js";
import {
  WEBHOOK_SKILLS_ADAPTER,
  WebhookRoutineSkillResolver,
  WebhookSkillExecutor,
} from "../../modules/webhookSkills/public.js";
import {
  SLACK_SKILLS_ADAPTER,
  SlackEscalationExecutor,
  SlackRoutineSkillResolver,
  SlackSkillDefinitionRepository,
} from "../../modules/slackSkills/public.js";
import { NotifyExecutor, NOTIFY_SKILLS_ADAPTER } from "../../modules/notify/notifyExecutor.js";
import { RoutineSkillExecutorDispatcher, StaticRoutineSkillResolver, type RoutineTriggerEmbeddingService } from "../../modules/routines/public.js";
import { WebsiteCrawlJobService } from "../../modules/websiteCrawler/jobService.js";
import { RadiosoCrawlerProvider } from "../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import { WebsiteCrawlWorker } from "../../modules/websiteCrawler/worker.js";
import { WorkspaceService, WorkspaceSummaryService } from "../../modules/workspace/public.js";
import type { RetrievalDefaultsProvider, SkillSettingsResolver } from "../../modules/retrieval/public.js";
import { ProductAnalyticsService } from "../../shared/analytics/productAnalyticsService.js";
import type { OrganizationCreationGuard } from "../../shared/domain/organizationCreationGuard.js";
import { NoopUsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import { DurableUsageEventRecorder } from "../../shared/infra/usage/durableUsageEventRecorder.js";
import { ErrorReportingService } from "../../shared/errors/errorReportingService.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import { Database } from "../../shared/infra/database.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../shared/infra/llm/providerRegistry.js";
import { ContextualDirectiveMatchGatewayFactory, ContextualTurnPlanGatewayFactory } from "../../shared/infra/llm/contextualGateways.js";
import { TextGenerationClientCache } from "../../shared/infra/llm/textClientFactory.js";
import { createMailService } from "../../modules/mail/public.js";
import { AgentSkillRepository } from "../../modules/agentSkills/public.js";
import { ContextVariableResolverService } from "../../modules/context-variables/public.js";
import { SkillBackedContextResolver } from "../composition/builtIn/contextResolverModule.js";
import { RepositoryAgentSkillTurnSkillProvider } from "../composition/builtIn/agentSkillTurnSkillProvider.js";
import { createLogger, type AppLogger } from "../../shared/observability/logger.js";
import { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import { createPublishedRoutineRegistrationSource } from "../composition/routineDefinitionSource.js";
import { ChatAnswerSupport, recordClarificationDecision } from "../../modules/chat/composition.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import {
  createDefaultAnalyticsSinks,
  createDefaultErrorSinks,
  createDefaultTelemetrySinks,
} from "../composition/index.js";
import type { Env } from "../config/env.js";
import type {
  McpConverseRouteDependencies,
  McpConverseRouteServices,
} from "../http/routes/mcpConverseRoutes.js";

// Builds the MCP converse service graph at app-wiring depth (this module is an approved importer of
// the chat/documents/retrieval/settings composition entrypoints), so the HTTP route never
// value-imports module internals. Shared by the route mount and converse route tests.
export const buildMcpConverseServices = (
  dependencies: McpConverseRouteDependencies,
): McpConverseRouteServices => {
  const audit = new AgentConverseAudit(dependencies.auditService);
  const sessionService = new AgentConverseSessionService({
    accessGrantService: dependencies.accessGrantService,
    agentRepository: dependencies.agentRepository,
    publicChatSessionSecret: dependencies.env.PUBLIC_CHAT_SESSION_SECRET,
    audit,
  });
  const converseService = new AgentConverseService({
    assistantChatService: dependencies.assistantChatService,
    conversationRepository: dependencies.conversationRepository,
    audit,
  });
  const groundedAnswerService = new AgentConverseGroundedAnswerService({
    agentRepository: dependencies.agentRepository,
    retrievalAnswerService: dependencies.retrievalAnswerService,
    audit,
  });
  const resourceService = new AgentConverseResourceService({
    agentRepository: dependencies.agentRepository,
    documentRepository: dependencies.documentRepository,
    documentSourceContentService: new DocumentSourceContentService(dependencies.documentStorage),
    audit,
  });
  return { audit, sessionService, converseService, groundedAnswerService, resourceService };
};

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
  const auditEventRepository = new AuditEventRepository(database.kysely);
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
    ? new DurableUsageEventRecorder(database.kysely, logger)
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
  options: {
    agentSurfaceExtensions?: AgentSurfaceExtensionRegistry;
    agentSkillSettings?: AgentSkillSettingsRegistry;
  } = {},
) => ({
  accountMembershipRepository: new AccountMembershipRepository(database.kysely),
  accountRepository: new AccountRepository(database.kysely),
  accessGrantRepository: new AccessGrantRepository(database.kysely),
  agentRepository: new AgentRepository(database.kysely, options.agentSurfaceExtensions, options.agentSkillSettings),
  bootstrapGreetingCacheRepository: new BootstrapGreetingCacheRepository(database.kysely),
  chunkRepository: new ChunkRepository(database, new PgVectorChunkStorage()),
  conversationRepository: new ConversationRepository(database.kysely),
  conversationOwnershipRepository: new ConversationOwnershipRepository(database.kysely),
  documentProcessingJobRepository: new DocumentProcessingJobRepository(database.kysely),
  documentRepository: new DocumentRepository(database.kysely),
  documentSourceRepository: new DocumentSourceRepository(database.kysely),
  emailVerificationTokenRepository: new EmailVerificationTokenRepository(database.kysely),
  historyItemsRepository: new HistoryItemsRepository(database.kysely),
  ingestionSettingsRepository: new IngestionSettingsRepository(database.kysely),
  messageRepository: new MessageRepository(database.kysely),
  passwordResetTokenRepository: new PasswordResetTokenRepository(database.kysely),
  retrievalSettingsRepository: new RetrievalSettingsRepository(database.kysely),
  routineDefinitionRepository: new RoutineDefinitionRepository(database.kysely),
  sessionRepository: new SessionRepository(database.kysely),
  userRepository: new UserRepository(database.kysely),
  websiteCrawlJobRepository: new WebsiteCrawlJobRepository(database.kysely),
  workspaceGrantRepository: new WorkspaceGrantRepository(database.kysely),
  workspaceRepository: new WorkspaceRepository(database.kysely),
  workspaceTokenRepository: new WorkspaceTokenRepository(database.kysely),
  abuseControlRepository: new AbuseControlRepository(database.kysely),
  accountInvitationRepository: new AccountInvitationRepository(database.kysely),
  workspaceProviderCredentialsRepository: new WorkspaceProviderCredentialsRepository(database.kysely),
  webhookDestinationRepository: new WebhookDestinationRepository(database.kysely),
  // customer-email connections moved onto the integration_connections spine (#751) after
  // this Kysely migration began; that repo still targets the spine via raw SQL and will be
  // migrated to Kysely in a later pass, so it keeps the raw Database here.
  customerEmailConnectionRepository: new CustomerEmailConnectionRepository(database.kysely),
  integrationConnectionRepository: new IntegrationConnectionRepository(database.kysely),
  identityNonceRepository: new IdentityNonceRepository(database.kysely),
  slackInstallationRepository: new SlackInstallationRepository(database.kysely),
  slackChannelBindingRepository: new SlackChannelBindingRepository(database.kysely),
  emailSkillDefinitionRepository: new EmailSkillDefinitionRepository(database.kysely),
  emailSkillActivityRepository: new EmailSkillActivityRepository(database.kysely),
  webhookSkillDefinitionRepository: new WebhookSkillDefinitionRepository(database.kysely),
  slackSkillDefinitionRepository: new SlackSkillDefinitionRepository(database.kysely),
});

export const buildAccessServices = (input: {
  auditService: AuditService;
  env: Pick<Env, "WORKSPACE_TOKEN_SECRET">;
  repositories: ReturnType<typeof buildRepositories>;
}) => {
  const { auditService, env, repositories } = input;
  const accessGrantService = new AccessGrantService({
    repository: repositories.accessGrantRepository,
    originMatcher: new DefaultOriginMatcher(),
    workspaceTokenSecret: env.WORKSPACE_TOKEN_SECRET,
    auditService,
  });
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
    accessGrantService,
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

export const buildWebhookDestinationAdapter = (input: {
  auditService: AuditPort;
  env: Pick<Env, "CONNECTOR_ENCRYPTION_KEY" | "NODE_ENV" | "WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK">;
  logger: Pick<AppLogger, "warn">;
  repositories: {
    webhookDestinationRepository: WebhookDestinationRepositoryPort;
    routineDefinitionRepository: WebhookDestinationRoutineReferencePort;
    webhookSkillDefinitionRepository?: Pick<WebhookSkillDefinitionRepository, "listSkillNamesByDestination">;
  };
  assertPublicUrl: (url: string) => Promise<void>;
}): WebhookDestinationPublicAdapter =>
  new DefaultWebhookDestinationAdapter(new WebhookDestinationService({
    repository: input.repositories.webhookDestinationRepository,
    auditService: input.auditService,
    encryption: { key: input.env.CONNECTOR_ENCRYPTION_KEY },
    assertPublicUrl: input.assertPublicUrl,
    allowHttpLoopback: input.env.NODE_ENV !== "production" && input.env.WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK === true,
    routineReferences: input.repositories.routineDefinitionRepository,
    skillReferences: input.repositories.webhookSkillDefinitionRepository
      ? {
          async listAgentSkillNamesReferencingDestination(workspaceId, destinationId) {
            return input.repositories.webhookSkillDefinitionRepository!.listSkillNamesByDestination(workspaceId, destinationId);
          },
        }
      : undefined,
  }));

export const buildWorkspaceLlmCapabilitySettingsService = (input: {
  auditService: AuditPort;
  capabilityRepository: WorkspaceLlmCapabilityPreferencesRepositoryPort;
  logger?: Pick<AppLogger, "warn">;
}): WorkspaceLlmCapabilitySettingsService =>
  new WorkspaceLlmCapabilitySettingsService(
    input.capabilityRepository,
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

  return {
    ingestionSettingsService,
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
  errorReporter: ErrorReporter;
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
  const documentEnrichmentService = new DocumentEnrichmentService({
    gateway: new ModelDocumentEnrichmentGateway(llmRegistry.createChatInferencePipeline(usageEventRecorder)),
  });
  const documentProcessingService = new DocumentProcessingService(
    repositories.documentRepository,
    repositories.chunkRepository,
    embeddingService,
    auditService,
    settings.ingestionSettingsService,
    chunkingStrategyRegistry,
    documentSourceContentService,
    logger,
    documentEnrichmentService,
    documentSourceRepository,
    repositories.documentProcessingJobRepository,
    documentJobDispatcher,
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
    input.errorReporter,
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
  const documentSourceReprocessService = new DocumentSourceReprocessService(
    repositories.documentRepository,
    documentSourceRepository,
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
    documentSourceReprocessService,
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
  retrievalDefaultsProvider: RetrievalDefaultsProvider;
  skillSettingsResolver?: SkillSettingsResolver;
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
        capabilityRunner: new AgenticCapabilityRunner({
          runtime: new DefaultAgentRuntime({ gateway: input.llmRegistry.createToolCallingGateway(input.usageEventRecorder) }),
        }),
        embeddings: input.embeddingService,
        vectorIndex: new PgVectorIndex(input.database),
        chunkHydrator: new PostgresChunkCandidateHydrator(input.database.kysely),
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

const ROUTINE_ACTIVATION_PREFILTER_TOP_K = 8;
const ROUTINE_ACTIVATION_PREFILTER_MIN_SCORE = 0.2;
// Bounds per-turn background embedding fan-out while unembedded published
// rows (pre-migration-128 catalogs, or a changed workspace embedding model)
// converge to persisted vectors over successive turns.
const ROUTINE_TRIGGER_SELF_HEAL_PER_TURN = 16;
const routineDefinitionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const createRoutineActivationPrefilter = (input: {
  accountId?: string;
  embeddingService: EmbeddingService;
  embeddingModelForWorkspace: (workspaceId: string) => Promise<string>;
  logger: AppLogger;
  routineDefinitionRepository: Pick<RoutineDefinitionRepository, "searchActivationTriggerEmbeddings">;
  selfHealTriggerEmbedding?: (input: { routineId: string; description: string }) => void;
  workspaceId: string;
}): RoutineActivationPrefilter => ({
  minScore: ROUTINE_ACTIVATION_PREFILTER_MIN_SCORE,
  topK: ROUTINE_ACTIVATION_PREFILTER_TOP_K,
  async rank({ query, triggers, turn }) {
    if (triggers.length === 0) {
      return [];
    }
    const allCandidates = () => triggers.map((trigger) => ({ routineId: trigger.routineId, score: 1 }));
    let embeddingModel: string;
    let queryVector: number[] | undefined;
    try {
      embeddingModel = await input.embeddingModelForWorkspace(input.workspaceId);
      [queryVector] = await input.embeddingService.embedTexts(
        [query],
        {
          model: embeddingModel,
          usageContext: {
            accountId: input.accountId ?? null,
            workspaceId: input.workspaceId,
            conversationId: turn.sessionId,
            messageId: turn.inputEvent.id ?? null,
            surface: "assistant",
            operation: "routine_activation_embedding",
            attemptKey: "routine_activation_prefilter",
          },
        },
      );
      if (!queryVector) {
        throw new Error("routine_activation_query_embedding_missing");
      }
    } catch {
      input.logger.debug(
        {
          mode: "embed_failed",
          candidateCountBefore: triggers.length,
          candidateCountAfter: triggers.length,
          candidateRoutineIds: triggers.map((trigger) => trigger.routineId),
          keptRoutineIds: triggers.map((trigger) => trigger.routineId),
        },
        "Routine activation prefilter fell back to all candidates",
      );
      return allCandidates();
    }
    try {
      const result = await input.routineDefinitionRepository.searchActivationTriggerEmbeddings({
        candidateRoutineIds: triggers
          .map((trigger) => trigger.routineId)
          .filter((routineId) => routineDefinitionIdPattern.test(routineId)),
        embeddingModel: embeddingModel!,
        queryEmbedding: queryVector!,
        topK: ROUTINE_ACTIVATION_PREFILTER_TOP_K,
      });
      const scored = result.matches.flatMap(({ routineId, distance }) => {
        const score = 1 - distance;
        return score >= ROUTINE_ACTIVATION_PREFILTER_MIN_SCORE ? [{ routineId, score }] : [];
      });
      const noVector = [
        ...result.noVectorRoutineIds,
        ...triggers
          .map((trigger) => trigger.routineId)
          .filter((routineId) => !routineDefinitionIdPattern.test(routineId)),
      ].map((routineId) => ({ routineId, score: 1 }));
      // DB-backed rows in the no-vector lane are legacy/unembedded or stale on
      // a changed embedding model. Re-embed a bounded batch fire-and-forget so
      // the lane stays a transient recall fallback, not a steady state that
      // outranks real similarity scores. Drafts self-skip in the service.
      if (input.selfHealTriggerEmbedding) {
        const descriptionsById = new Map(triggers.map((trigger) => [trigger.routineId, trigger.description]));
        for (const routineId of result.noVectorRoutineIds.slice(0, ROUTINE_TRIGGER_SELF_HEAL_PER_TURN)) {
          const description = descriptionsById.get(routineId);
          if (description) {
            input.selfHealTriggerEmbedding({ routineId, description });
          }
        }
      }
      input.logger.debug(
        {
          mode: "persisted",
          candidateCountBefore: triggers.length,
          candidateCountAfter: scored.length + noVector.length,
          candidateRoutineIds: triggers.map((trigger) => trigger.routineId),
          keptRoutineIds: [...scored, ...noVector].map((candidate) => candidate.routineId),
        },
        "Routine activation prefilter completed",
      );
      return [...scored, ...noVector];
    } catch {
      input.logger.debug(
        {
          mode: "fallback_full",
          candidateCountBefore: triggers.length,
          candidateCountAfter: triggers.length,
          candidateRoutineIds: triggers.map((trigger) => trigger.routineId),
          keptRoutineIds: triggers.map((trigger) => trigger.routineId),
        },
        "Routine activation prefilter fell back to all candidates",
      );
      return allCandidates();
    }
  },
});


export const buildChatServices = (input: {
  accountAccessService: AccountAccessService;
  agentService: AgentService;
  auditEventRepository: AuditEventRepository;
  auditService: AuditService;
  bootstrapGreetingCacheRepository: BootstrapGreetingCacheRepository;
  composition: ApplicationComposition;
  conversationOwnershipRepository: ConversationOwnershipRepository;
  conversationRepository: ConversationRepository;
  database: Database;
  env: Env;
  historyItemsRepository: HistoryItemsRepository;
  llmRegistry: LlmProviderRegistry;
  llmCapabilityResolver: LlmCapabilityResolver;
  logger: AppLogger;
  messageRepository: MessageRepository;
  metricsRegistry?: MetricsRegistry | null;
  telemetryService: TelemetryService;
  webhookDestinations: WebhookDestinationRuntimePort;
  productAnalyticsService: ProductAnalyticsService;
  routineDefinitionRepository: RoutineDefinitionRepository;
  customerEmailConnectionRepository: CustomerEmailConnectionRepository;
  emailSkillDefinitionRepository: EmailSkillDefinitionRepository;
  emailSkillActivityRepository: EmailSkillActivityRepository;
  webhookSkillDefinitionRepository: WebhookSkillDefinitionRepository;
  slackSkillDefinitionRepository: SlackSkillDefinitionRepository;
  mailService: ReturnType<typeof buildInfrastructure>["mailService"];
  publicConversationEventBus: PublicConversationEventBus;
  usageEventRecorder: ReturnType<typeof buildInfrastructure>["usageEventRecorder"];
  retrievalPipeline: RetrievalPipelinePort;
  retrievalDefaultsProvider: RetrievalDefaultsProvider;
  skillSettingsResolver?: SkillSettingsResolver;
  usageLimitPolicy: ReturnType<typeof buildInfrastructure>["usageLimitPolicy"];
  workspaceRepository: WorkspaceRepository;
  assertPublicWebsiteUrl: (url: string) => Promise<void>;
  errorReporter: ErrorReporter;
  ingestionSettingsService: IngestionSettingsService;
  routineTriggerEmbeddingService: RoutineTriggerEmbeddingService;
}) => {
  const chatGateway = input.llmRegistry.createChatGateway(input.usageEventRecorder);
  const routineActivationEmbeddingService = new EmbeddingService(
    input.llmRegistry.createEmbeddingGateway(input.usageEventRecorder),
  );
  const routineActivationPolicy = { floor: 0.4, margin: 0.15, askMargin: 0.15, maxOptions: 4 };
  // Retrieval-sense clarification is answer-first: once a candidate set survives
  // floor/suppression/clear-margin/loop-guard/priority checks, a no-clear-winner case
  // soft-picks the strongest sense and offers alternatives instead of blocking. The
  // small askMargin reserves a *blocking* question only for genuine ties — senses whose
  // confidences are within this gap are statistically indistinguishable, so leading
  // with an arbitrary pick (even with an offer) would be worse than asking. Bands:
  // gap >= margin (0.15) -> silent auto-pick; askMargin <= gap < margin -> answer + offer;
  // gap < askMargin -> ask. Kept deliberately tight: near-but-distinguishable senses
  // (e.g. a ~0.02 confidence gap) should answer-first and offer the alternative rather
  // than interrupt with a blocking clarifying question, which reads as a non-answer.
  const retrievalSenseAnswerFirstAskMargin = 0.01;
  const retrievalSensePolicy: RetrievalSensePolicy = {
    minGroupShare: 0.3,
    // Euclidean centroid distance over involved chunk embeddings. The value is
    // intentionally conservative for v1 fixtures: it filters near-duplicate
    // document groups while allowing clearly distinct senses to label once.
    separationThreshold: 0.4,
    maxOptions: 4,
  };
  const directiveMatchGatewayFactory = input.composition.directiveMatchGatewayFactory ??
    new ContextualDirectiveMatchGatewayFactory(
      {
        resolver: input.llmCapabilityResolver,
        clientCache: new TextGenerationClientCache(),
      },
      input.usageEventRecorder,
    );
  const turnPlanCoordinator = new TurnPlanCoordinator(
    new TurnPlanService(
      new ContextualTurnPlanGatewayFactory(
        { resolver: input.llmCapabilityResolver, clientCache: new TextGenerationClientCache() },
        input.usageEventRecorder,
      ),
    ),
    input.logger,
    input.metricsRegistry,
  );
  const answerPresentationService = new AnswerPresentationService();
  const answerPresentation = {
    normalize: answerPresentationService.normalize.bind(answerPresentationService),
    present: answerPresentationService.present.bind(answerPresentationService),
  };
  const abuseControlService = new AbuseControlService(new AbuseControlRepository(input.database.kysely));
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
  // Register the retrieval adapter once; it serves both answer and context
  // retrieval skills. Guarded so repeated dependency builds (tests) do not double-register.
  if (!input.composition.skillExecutorRegistry.resolve({ kind: "internal", adapter: RETRIEVAL_ANSWER_ADAPTER })) {
    input.composition.skillExecutorRegistry.register({
      kind: "internal",
      adapter: RETRIEVAL_ANSWER_ADAPTER,
      executor: new RetrievalAnswerSkillExecutor(input.retrievalPipeline),
    });
  }
  // Register the external-skills (MCP) executor here, where the database + encryption
  // key are available (spec 087). Guarded for repeated dependency builds; skipped when
  // no encryption key is configured, since stored credentials cannot be decrypted then
  // (routine skill steps then degrade to a failed outcome rather than crashing).
  if (
    input.env.CONNECTOR_ENCRYPTION_KEY &&
    !input.composition.skillExecutorRegistry.resolve({ kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER })
  ) {
    input.composition.skillExecutorRegistry.register({
      kind: "internal",
      adapter: EXTERNAL_SKILLS_ADAPTER,
      executor: new McpSkillExecutor(
        buildExternalSkillsDeps(input.database, input.env.CONNECTOR_ENCRYPTION_KEY, input.assertPublicWebsiteUrl, {
          logger: input.logger,
        }),
      ),
    });
  }
  if (
    input.env.CONNECTOR_ENCRYPTION_KEY &&
    !input.composition.skillExecutorRegistry.resolve({ kind: "internal", adapter: CUSTOMER_EMAIL_SKILLS_ADAPTER })
  ) {
    const oauthConnectionRepository = new OauthConnectionRepository(input.database.kysely);
    // No real Gmail/Microsoft Graph adapter is wired yet (spec 089 follow-up): the
    // mock provider accepts every draft/send and returns a placeholder message id, so
    // `drafted`/`sent` outcomes do NOT mean a message was delivered. Warn loudly so
    // operators do not trust activity receipts as proof of delivery.
    input.logger.warn(
      { event: "customer_email", provider: "mock" },
      "Customer email skills are using the MOCK provider; no real email is delivered and drafted/sent outcomes are simulated",
    );
    const customerEmailProviderRegistry = new StaticCustomerEmailProviderRegistry(
      customerEmailOauthProviderIds.map((provider) => new MockCustomerEmailProviderAdapter(provider)),
    );
    input.composition.skillExecutorRegistry.register({
      kind: "internal",
      adapter: CUSTOMER_EMAIL_SKILLS_ADAPTER,
      executor: new EmailSkillExecutor({
        skills: input.emailSkillDefinitionRepository,
        delivery: new CustomerEmailDeliveryService({
          connections: input.customerEmailConnectionRepository,
          oauthCredentials: {
            findCredentialById: (workspaceId, id) => oauthConnectionRepository.findById(workspaceId, id),
          },
          oauthTokenRepository: oauthConnectionRepository,
          providers: customerEmailProviderRegistry,
          encryptionKey: input.env.CONNECTOR_ENCRYPTION_KEY,
          assertPublicUrl: input.assertPublicWebsiteUrl,
          logger: input.logger,
        }),
        activity: input.emailSkillActivityRepository,
      }),
    });
  }
  if (!input.composition.skillExecutorRegistry.resolve({ kind: "internal", adapter: WEBHOOK_SKILLS_ADAPTER })) {
    input.composition.skillExecutorRegistry.register({
      kind: "internal",
      adapter: WEBHOOK_SKILLS_ADAPTER,
      executor: new WebhookSkillExecutor({
        skills: input.webhookSkillDefinitionRepository,
        destinations: input.webhookDestinations,
        httpClient: new FetchWebhookHttpClient(input.assertPublicWebsiteUrl, {
          allowHttpLoopback: input.env.NODE_ENV !== "production" && input.env.WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK === true,
        }),
        logger: input.logger,
      }),
    });
  }
  if (!input.composition.skillExecutorRegistry.resolve({ kind: "internal", adapter: SLACK_SKILLS_ADAPTER })) {
    input.composition.skillExecutorRegistry.register({
      kind: "internal",
      adapter: SLACK_SKILLS_ADAPTER,
      executor: new SlackEscalationExecutor({
        skills: input.slackSkillDefinitionRepository,
        outbox: new ActionRequestRepository(input.database.kysely),
      }),
    });
  }
  if (!input.composition.skillExecutorRegistry.resolve({ kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER })) {
    input.composition.skillExecutorRegistry.register({
      kind: "internal",
      adapter: NOTIFY_SKILLS_ADAPTER,
      executor: new NotifyExecutor({
        skills: new AgentSkillRepository(input.database.kysely),
        outbox: new ActionRequestRepository(input.database.kysely),
      }),
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
          database: input.database.kysely,
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
    metrics: input.metricsRegistry,
    logger: input.logger,
  });
  // Behavioral steering comes from application composition. Chat and direct
  // retrieval answer surfaces share this port so extracted answer directives
  // stay consistent across `/assistant/chat`, `/retrieval/answer`, and MCP.
  const directiveSteering = createRouteScopedDirectiveSteering({
    capabilityPolicy: input.composition.capabilityPolicy,
    registrations: input.composition.directiveRegistrations,
    matcher: input.composition.directiveMatcher,
    directiveMatchGatewayFactory,
    logger: input.logger,
  });
  // Async conversation actions (spec 070). A routine action step enqueues an intent to
  // the outbox during the turn (`actionOutbox`); the worker drains and routes it to a
  // registered handler out of band (`actionDispatchWorker`). The two share one repository
  // so the same table backs the enqueue and the drain.
  const actionOutbox = new ActionRequestRepository(input.database.kysely);
  const actionHandlerRegistry = new ActionHandlerRegistry(
    input.composition.actionHandlerRegistrations.map((registration) => ({
      type: registration.type,
      handler:
        typeof registration.handler === "function"
          ? registration.handler({
              database: input.database,
              env: input.env,
              logger: input.logger,
              auditService: input.auditService,
              telemetryService: input.telemetryService,
              webhookDestinations: input.webhookDestinations,
              mailService: input.mailService,
              assertPublicWebsiteUrl: input.assertPublicWebsiteUrl,
            })
          : registration.handler,
    })),
  );
  const actionDispatchWorker = new ActionDispatchWorker(
    new ActionDispatcher(actionOutbox, actionHandlerRegistry),
    { logger: input.logger, errorReporter: input.errorReporter },
  );
  // Routine machinery (spec 070 / #520). Composition loads the turn agent's published
  // routines, unions them with static registrations, and assembles the engine runner +
  // LLM adapter per turn. ChatService supplies only the model gateway and agent id; if
  // the union is empty the provider returns null and ChatService skips the store load.
  const publishedRoutineSource = createPublishedRoutineRegistrationSource(input.routineDefinitionRepository, {
    onDefinitionError: ({ agentId, definitionId, error }) => {
      input.logger.warn(
        {
          agentId,
          definitionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Published routine definition failed to compile; skipping",
      );
    },
    onPinnedDefinitionError: ({ agentId, routineId, definitionId, error }) => {
      input.logger.warn(
        {
          agentId,
          routineId,
          definitionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Pinned routine definition failed to load or compile; skipping resume-only registration",
      );
    },
    onPreviewDefinitionError: ({ agentId, routineId, error }) => {
      input.logger.warn(
        {
          agentId,
          routineId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Preview (draft) routine definition failed to load or compile; workbench draft test will not run it",
      );
    },
    resolveCompletionExport: async (definition) => {
      const [skill] = await input.database.query<{
        target_id: string | null;
        enabled: boolean;
      }>(
        `SELECT target_id, enabled
         FROM agent_skills
         WHERE agent_id = $1
           AND skill_name = 'completion_export'
           AND kind = 'webhook'
         LIMIT 1`,
        [definition.agentId],
      );
      if (!skill) {
        return null;
      }
      if (!skill.enabled || !skill.target_id) {
        return { enabled: false, triggerKinds: [], destinationRef: "" };
      }
      return {
        enabled: true,
        triggerKinds: definition.completionExport?.triggerKinds?.length
          ? definition.completionExport.triggerKinds
          : ["complete", "handoff"],
        destinationRef: skill.target_id,
      };
    },
  });
  const routineProvider: ChatRoutineProvider = {
    async forTurn({
      modelGateway,
      agentId,
      workspaceId,
      accountId,
      pinnedRoutineIds = [],
      previewRoutineIds = [],
      responseLanguage,
      groundedAnswerRenderer,
      throwIfCancelled,
      turnPlan,
    }) {
      let publishedRegistrations: RoutineRegistration[];
      try {
        publishedRegistrations = await publishedRoutineSource.load({ agentId });
      } catch (error) {
        input.logger.warn(
          {
            agentId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Published routine definitions failed to load; continuing without DB-backed routines",
        );
        publishedRegistrations = [];
      }
      // Operator-only workbench test override: make specific draft (or any-status)
      // definitions eligible this turn so an author can test-run an unpublished routine.
      // Reachable only via the authenticated workbench chat; never set on live turns.
      let previewRegistrations: RoutineRegistration[] = [];
      if (previewRoutineIds.length > 0) {
        try {
          previewRegistrations = await publishedRoutineSource.loadPreview({ agentId, routineIds: previewRoutineIds });
        } catch (error) {
          input.logger.warn(
            {
              agentId,
              routineIds: previewRoutineIds,
              err: error instanceof Error ? error.message : String(error),
            },
            "Preview routine definitions failed to load; continuing without workbench draft routines",
          );
          previewRegistrations = [];
        }
      }
      let pinnedRegistrations: RoutineRegistration[];
      try {
        pinnedRegistrations = await publishedRoutineSource.loadPinned({ agentId, routineIds: pinnedRoutineIds });
      } catch (error) {
        input.logger.warn(
          {
            agentId,
            routineIds: pinnedRoutineIds,
            err: error instanceof Error ? error.message : String(error),
          },
          "Pinned routine definitions failed to load; continuing without resume-only DB-backed routines",
        );
        pinnedRegistrations = [];
      }
      const registrations = [
        ...input.composition.routineRegistrations,
        ...publishedRegistrations,
        // Preview (draft) routines are fresh-activation candidates too, still subject
        // to the same capability gating below.
        ...previewRegistrations,
      ];
      const gatedRegistrations = [];
      for (const registration of registrations) {
        const gateRef = registration.trigger.gateRef;
        if (!gateRef || !registeredCapabilityNames.has(gateRef)) {
          gatedRegistrations.push(registration);
          continue;
        }
        const decision = await input.composition.capabilityPolicy.can({
          capability: gateRef,
          workspaceId,
        });
        if (decision.allowed) {
          gatedRegistrations.push(registration);
        }
      }
      const routineRegistry = new RoutineRegistry(gatedRegistrations, {
        policy: routineActivationPolicy,
        promptTemplate: loadPromptTemplate("chat/routine-ranked-activation.md"),
        ...(workspaceId
          ? {
              activationPrefilter: createRoutineActivationPrefilter({
                accountId,
                embeddingService: routineActivationEmbeddingService,
                embeddingModelForWorkspace: async (inputWorkspaceId) =>
                  (await input.ingestionSettingsService.getForWorkspace(inputWorkspaceId)).embeddingModel,
                logger: input.logger,
                routineDefinitionRepository: input.routineDefinitionRepository,
                selfHealTriggerEmbedding: ({ routineId, description }) => {
                  // persistPublished is total (catch-all) — safe fire-and-forget.
                  void input.routineTriggerEmbeddingService.persistPublished({
                    workspaceId,
                    agentId,
                    routine: { id: routineId, activation: { triggerDescription: description } },
                  });
                },
                workspaceId,
              }),
            }
          : {}),
      });
      const routinesById = new Map(routineRegistry.routines.map((routine) => [routine.id, routine]));
      for (const registration of pinnedRegistrations) {
        routinesById.set(registration.routine.id, registration.routine);
      }
      // Preview routines resume mid-flight regardless of the activation gate, matching
      // pinned-resume semantics, so a draft under test continues across turns.
      for (const registration of previewRegistrations) {
        routinesById.set(registration.routine.id, registration.routine);
      }
      const routines = [...routinesById.values()];
      if (routineRegistry.isEmpty && routines.length === 0) {
        return null;
      }
      let emailSkillNames: string[] = [];
      let webhookSkillNames: string[] = [];
      let slackSkillNames: string[] = [];
      let retrieveSkills: Array<{
        skillName: string;
        enabled: boolean;
        invocationMode: string;
        config?: Record<string, unknown>;
      }> = [];
      try {
        if (workspaceId && agentId) {
          emailSkillNames = (await input.emailSkillDefinitionRepository.listByAgent(workspaceId, agentId))
            .filter((skill) => skill.enabled)
            .map((skill) => skill.skillName);
        }
      } catch (error) {
        input.logger.warn(
          {
            agentId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Customer email skill definitions failed to load for routine routing; continuing without email skills",
        );
      }
      try {
        if (workspaceId && agentId) {
          webhookSkillNames = (await input.webhookSkillDefinitionRepository.listByAgent(workspaceId, agentId))
            .filter((skill) => skill.enabled)
            .map((skill) => skill.skillName);
        }
      } catch (error) {
        input.logger.warn(
          {
            agentId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Webhook skill definitions failed to load for routine routing; continuing without webhook skills",
        );
      }
      try {
        if (workspaceId && agentId) {
          slackSkillNames = (await input.slackSkillDefinitionRepository.listByAgent(workspaceId, agentId))
            .filter((skill) => skill.enabled)
            .map((skill) => skill.skillName);
        }
      } catch (error) {
        input.logger.warn(
          {
            agentId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Slack skill definitions failed to load for routine routing; continuing without Slack skills",
        );
      }
      try {
        if (workspaceId && agentId) {
          retrieveSkills = (await new AgentSkillRepository(input.database.kysely).listByAgent(workspaceId, agentId))
            .filter((skill) => skill.kind === "retrieve")
            .map((skill) => ({
              skillName: skill.skillName,
              enabled: skill.enabled,
              invocationMode: skill.invocationMode,
              config: skill.config,
            }));
        }
      } catch (error) {
        input.logger.warn(
          {
            agentId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Retrieve skill definitions failed to load for routine routing; continuing without retrieve skills",
        );
      }
      return {
        routines,
        // The plan-aware activator prepares candidates once through the registry's
        // seam, feeds them to the shared turn plan (earliest consumer), and applies
        // precomputed rankings; without a plan handle it is exactly the staged
        // ranked-activation activator.
        activator: routineRegistry.isEmpty
          ? { activate: async () => null }
          : planAwareRoutineActivator({
              handle: turnPlan,
              registry: routineRegistry,
              fallback: routineRegistry.activator(modelGateway),
            }),
        // Post-completion slot correction (issue #746): resolves the completed routine
        // from the same per-turn routine set and runs model-driven detection/confirmation.
        slotCorrection: planAwareRoutineSlotCorrection({
          handle: turnPlan,
          fallback: new RoutineSlotCorrector(routines, modelGateway, {
            detectPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-detect.md"),
            confirmPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-confirm.md"),
            invalidPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-invalid.md"),
          }),
        }),
        // Semantic reentry gate (issue #746): inert unless a routine opts into semantic mode.
        reentryGate: planAwareRoutineReentryGate({
          handle: turnPlan,
          fallback: new RoutineReentryGate(routines, modelGateway, {
            promptTemplate: loadPromptTemplate("chat/routine-reentry-gate.md"),
          }),
        }),
        runner: new DefaultRoutineRunner(
          routines,
          new RoutineNextStepSelector(modelGateway, {
            promptTemplate: loadPromptTemplate("chat/routine-next-step.md"),
          }),
          new RoutineStepRenderer(modelGateway, {
            promptTemplate: loadPromptTemplate("chat/routine-step-reply.md"),
            terminalHandoffWithMessagePromptTemplate: loadPromptTemplate("chat/routine-step-terminal-handoff-with-message.md"),
            terminalHandoffDefaultPromptTemplate: loadPromptTemplate("chat/routine-step-terminal-handoff-default.md"),
            responseLanguage,
            groundedAnswerRenderer,
          }),
          new RoutineSkillExecutorDispatcher(
            new StaticRoutineSkillResolver(
              routineDispatchableBuiltInSkills,
              new WebhookRoutineSkillResolver(
                webhookSkillNames,
                new CustomerEmailRoutineSkillResolver(
                  emailSkillNames,
                  new SlackRoutineSkillResolver(
                    slackSkillNames,
                    new RetrieveRoutineSkillResolver(retrieveSkills, new ExternalSkillRoutineSkillResolver()),
                  ),
                ),
              ),
            ),
            input.composition.skillExecutorRegistry,
            {
              workspaceId,
              ...(accountId ? { accountId } : {}),
              capabilityGate: (capability) =>
                input.composition.capabilityPolicy.can({
                  capability,
                  workspaceId,
                }),
              metricsRegistry: input.metricsRegistry ?? null,
              throwIfCancelled,
            },
          ),
        ),
      };
    },
  };
  const retrievalTurn = new RetrievalTurnController(
    input.retrievalPipeline,
    new SkillRetrievalTurnDispatch(
      input.composition.skillExecutorRegistry,
      retrievalAnswerSkillDefinition,
      input.composition.capabilityPolicy,
    ),
  );
  const conversationEngine = createConversationEngine();
  const clarificationStore = new ClarificationStateRepository(input.database.kysely);
  const retrievalSenseDetector = new SenseGroupingService({
    policy: retrievalSensePolicy,
    embeddingReader: new PostgresSenseEmbeddingReader(input.database.kysely),
    labelGateway: new ModelSenseLabelGateway(
      input.llmRegistry.createChatInferencePipeline(input.usageEventRecorder),
      loadPromptTemplate("chat/clarification-sense-labels.md"),
    ),
  });
  const chatAnswerSupport = new ChatAnswerSupport();
  // The router is a lightweight classifier: run it on the cheap rewrite-tier
  // inference at minimal effort (CHAT_BEHAVIOR.intentRouting), not the heavier
  // chat answer model/effort. Shared by live turns and workbench replay so a
  // replayed turn takes the same route. (ChatGatewayTurnRouterGateway remains
  // available as a workspace-model-aware alternative seam.)
  const turnRouter = new LlmTurnRouter(
    new ModelTurnRouterGateway(input.llmRegistry.createRewriteInferencePipeline(input.usageEventRecorder)),
  );
  const turnInterpreter = new LlmConversationTurnInterpreter(
    new ModelTurnInterpretationGateway(input.llmRegistry.createRewriteInferencePipeline(input.usageEventRecorder)),
    input.retrievalDefaultsProvider,
    input.skillSettingsResolver,
  );
  const responseLanguageDetector = new LlmResponseLanguageDetector(
    input.llmRegistry.createRewriteInferencePipeline(input.usageEventRecorder),
  );
  const handoffWaitingMessageGenerator = new LlmHandoffWaitingMessageGenerator(
    input.llmRegistry.createRewriteInferencePipeline(input.usageEventRecorder),
  );
  const routineStateRepository = new RoutineStateRepository(input.database.kysely);
  const directiveStateRepository = new DirectiveStateRepository(input.database.kysely);
  const conversationSummaryRepository = new ConversationSummaryRepository(input.database.kysely);
  // Rolling per-conversation summary (#866): read at prepare, regenerated
  // fire-and-forget post-turn on the cheap rewrite-tier inference (a background
  // summarization pass, never on the answer latency budget).
  const conversationSummaryService = new ConversationSummaryService(
    conversationSummaryRepository,
    input.messageRepository,
    new ModelConversationSummaryGenerator(
      input.llmRegistry.createRewriteInferencePipeline(input.usageEventRecorder),
    ),
    input.logger,
  );
  const contextVariableRepository = new ContextVariableRepository(input.database.kysely);
  const contextVariableResolver = new ContextVariableResolverService({
    repository: contextVariableRepository,
    resolver: new SkillBackedContextResolver({
      agentSkills: new AgentSkillRepository(input.database.kysely),
      skillExecutorRegistry: input.composition.skillExecutorRegistry,
    }),
    logger: input.logger,
    metrics: input.metricsRegistry ?? null,
  });
  // One agent-skill turn runtime shared by the live chat turn and workbench replay,
  // so a replayed directive-bound turn selects and dispatches exactly like production.
  const agentSkillTurnSkillProvider = new RepositoryAgentSkillTurnSkillProvider({
    agentSkills: new AgentSkillRepository(input.database.kysely),
    executorRegistry: input.composition.skillExecutorRegistry,
    capabilityPolicy: input.composition.capabilityPolicy,
  });
  const turnClarificationPolicy = {
    floor: 0,
    margin: 0.15,
    askMargin: retrievalSenseAnswerFirstAskMargin,
    maxOptions: retrievalSensePolicy.maxOptions,
  };
  const clarificationDecisionRecorder = input.metricsRegistry
    ? (decision: Parameters<typeof recordClarificationDecision>[1]) =>
        recordClarificationDecision(input.metricsRegistry!, decision)
    : undefined;
  const chatTurnAssemblyFactory = new ChatTurnAssemblyFactory({
    chatGateway,
    chatAnswerPresenter: chatTurnRuntime.chatAnswerPresenter,
    conversationEngine,
    turnSkills: chatTurnRuntime.turnSkills,
    selectionStrategy: input.composition.selectionStrategy,
    directiveRuntime: directiveSteering,
    turnRouter,
    turnInterpreter,
    routineProvider,
    retrievalSenseDetector,
    retrievalSenseClarificationPolicy: turnClarificationPolicy,
    recordClarificationDecision: clarificationDecisionRecorder,
    agentSkillTurnSkillProvider,
    logger: input.logger,
  });
  const chatService = new ChatService({
    conversationRepository: input.conversationRepository,
    messageRepository: input.messageRepository,
    // 066 slice 3: chat reaches retrieval only through a narrow turn port —
    // interpret via the controller, execute via the dispatched retrieval.answer
    // skill. ChatService carries no RetrievalPipelineService reference.
    retrievalTurn,
    chatGateway,
    auditService: input.auditService,
    turnRuntime: chatTurnRuntime,
    productAnalyticsService: input.productAnalyticsService,
    workspaceRepository: input.workspaceRepository,
    bootstrapGreetingCacheRepository: input.bootstrapGreetingCacheRepository,
    usageLimitPolicy: input.usageLimitPolicy,
    agentService: input.agentService,
    contextVariableRepository: contextVariableResolver,
    // 067: behavioral steering. The standing set is supplied by application
    // composition; default answer behavior is registered by a built-in module.
    // Contextual matching is created per turn so the model call carries the
    // current workspace/conversation/message usage context.
    directiveSteering,
    // Turn selection strategy comes from composition (default: retrieval/direct
    // terminal turn). Registerable so a host can swap it.
    selectionStrategy: input.composition.selectionStrategy,
    turnRouter,
    turnInterpreter,
    turnPlanCoordinator,
    turnPlanInterpretationContextSettings: {
      retrievalDefaultsProvider: input.retrievalDefaultsProvider,
      ...(input.skillSettingsResolver ? { skillSettingsResolver: input.skillSettingsResolver } : {}),
    },
    responseLanguageDetector,
    handoffWaitingMessageGenerator,
    // The reusable conversation engine is the chat turn spine in every
    // environment. ChatService keeps an engine-less path for tests, but
    // composition always wires it.
    conversationEngine,
    turnAssemblyFactory: chatTurnAssemblyFactory,
    // Turn-emitted action intents land here, persisted to the outbox and
    // dispatched out of band by `actionDispatchWorker` in the worker process.
    actionOutbox,
    assistantTurnPersistence: new PostgresAssistantTurnPersistence(
      input.database.kysely,
      undefined,
      input.conversationOwnershipRepository,
    ),
    actionCapabilities: input.composition.actionCapabilityMap,
    capabilityPolicy: input.composition.capabilityPolicy,
    logger: input.logger,
    conversationTurnRegistry: new InMemoryConversationTurnRegistry(
      new LoggingConversationTurnInterruptionObserver(input.logger, input.metricsRegistry),
    ),
    conversationOwnershipRepository: input.conversationOwnershipRepository,
    // Routine resume/activate per turn — present only when routines are registered.
    routineStore: routineStateRepository,
    suspendedRoutineReader: routineStateRepository,
    // Per-conversation directive firing memory for once/cooldown lifecycle (#865).
    directiveStateStore: directiveStateRepository,
    // Rolling per-conversation summary (#866): read at prepare, regenerated post-turn.
    conversationSummaryStore: conversationSummaryRepository,
    conversationSummaryUpdater: conversationSummaryService,
    conversationOwnershipReader: input.conversationOwnershipRepository,
    routineProvider,
    clarifierFactory: ({ session, accountId }) => new DefaultClarifier(
      new RoutineChatModelGateway(chatGateway, {
        workspaceContext: chatAnswerSupport.buildChatWorkspaceContext(session),
        usageContext: {
          ...chatAnswerSupport.buildChatUsageContext(session, accountId, "clarification"),
          operation: "clarification",
        },
      }),
      {
        questionPromptTemplate: loadPromptTemplate("chat/clarification-question.md"),
        replyMapPromptTemplate: loadPromptTemplate("chat/clarification-reply-map.md"),
        offerReplyMapPromptTemplate: loadPromptTemplate("chat/clarification-offer-reply-map.md"),
      },
    ),
    clarificationStore,
    retrievalSenseDetector,
    retrievalSenseClarificationPolicy: turnClarificationPolicy,
    agentSkillTurnSkillProvider,
    recordClarificationDecision: clarificationDecisionRecorder,
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
    input.conversationOwnershipRepository,
  );
  const conversationForkService = new ConversationForkService(
    input.conversationRepository,
    input.messageRepository,
    routineStateRepository,
    // Forks carry the rolling summary (#866) so long-conversation test sessions
    // keep the pre-window context of their source.
    conversationSummaryRepository,
  );
  const retrievalAnswerService = new RetrievalAnswerService({
    retrievalPipeline: input.retrievalPipeline,
    chatGateway,
    usageLimitPolicy: input.usageLimitPolicy,
    auditService: input.auditService,
    directiveSteering,
  });
  const workbenchReplayRunner = new WorkbenchReplayRunner({
    retrievalTurn,
    auditService: input.auditService,
    turnSkills: chatTurnRuntime.turnSkills,
    directiveSteering,
    selectionStrategy: input.composition.selectionStrategy,
    conversationEngine,
    turnAssemblyFactory: chatTurnAssemblyFactory,
    turnRouter,
    turnInterpreter,
    responseLanguageDetector,
    // Routine ports — let a replayed turn attempt routines before grounding, exactly
    // as the live chat turn does, so routine-driven behavior is faithfully evaluated.
    routineProvider,
    chatGateway,
    chatAnswerPresenter: chatTurnRuntime.chatAnswerPresenter,
    clarifierFactory: ({ session, accountId }) => new DefaultClarifier(
      new RoutineChatModelGateway(chatGateway, {
        workspaceContext: chatAnswerSupport.buildChatWorkspaceContext(session),
        usageContext: {
          ...chatAnswerSupport.buildChatUsageContext(session, accountId, "clarification"),
          operation: "clarification",
        },
      }),
      {
        questionPromptTemplate: loadPromptTemplate("chat/clarification-question.md"),
        replyMapPromptTemplate: loadPromptTemplate("chat/clarification-reply-map.md"),
        offerReplyMapPromptTemplate: loadPromptTemplate("chat/clarification-offer-reply-map.md"),
      },
    ),
    retrievalSenseDetector,
    retrievalSenseClarificationPolicy: turnClarificationPolicy,
    recordClarificationDecision: clarificationDecisionRecorder,
    agentSkillTurnSkillProvider,
    // Same fused-planning coordinator as live chat, so replay executes the
    // identical planner-or-staged schedule under the same bypass semantics.
    turnPlanCoordinator,
    turnPlanInterpretationContextSettings: {
      retrievalDefaultsProvider: input.retrievalDefaultsProvider,
      ...(input.skillSettingsResolver ? { skillSettingsResolver: input.skillSettingsResolver } : {}),
    },
    logger: input.logger,
  });
  const approvalDecisionService = new ApprovalDecisionService(
    new PendingDecisionRepository(input.database.kysely),
    chatService.asApprovalResumeRunner(),
    {
      resolveWorkspaceRole: (caller) => input.accountAccessService.resolveWorkspaceRole(caller),
    },
    {
      publishMessageCreated: (event) => input.publicConversationEventBus.publish({
        type: "message.created",
        ...event,
      }),
    },
  );

  return {
    abuseControlService,
    answerPresentation,
    assistantChatService: new AssistantChatService(chatService, chatBootstrapService),
    assistantHistoryService: new AssistantHistoryService(chatHistoryService),
    publicChatActionAdvertiser,
    chatBootstrapService,
    chatGateway,
    chatHistoryService,
    conversationForkService,
    chatService,
    workbenchReplayRunner,
    contactHistoryProvider,
    retrievalAnswerService,
    actionDispatchWorker,
    approvalDecisionService,
  };
};

export const buildConnectorRegistry = (input: {
  composition: ApplicationComposition;
  env: Env;
  logger: AppLogger;
}) => {
  const connectorRegistry = createDefaultConnectorRegistry(input.composition.connectors, input.env);
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
  database: Database;
  env: Env;
  organizationCreationGuard: OrganizationCreationGuard;
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
    organizationCreationGuard: input.organizationCreationGuard,
    organizationProvisioner: new PostgresOrganizationProvisioner(input.database, input.auditService),
    auditService: input.auditService,
  });

export const buildPasswordResetService = (input: {
  access: ReturnType<typeof buildAccessServices>;
  auditService: AuditService;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
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
    logger: input.logger,
  });

export const buildEmailVerificationService = (input: {
  auditService: AuditService;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
}): EmailVerificationService =>
  new EmailVerificationService({
    env: input.env,
    userRepository: input.repositories.userRepository,
    emailVerificationTokenRepository: input.repositories.emailVerificationTokenRepository,
    mailService: input.infrastructure.mailService,
    auditService: input.auditService,
    logger: input.logger,
  });

export const buildLogger = (): AppLogger => createLogger();
