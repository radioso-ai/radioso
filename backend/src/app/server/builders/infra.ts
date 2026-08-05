import { AccountInvitationRepository } from "../../../db/repositories/accountInvitationRepository.js";
import { AccountMembershipRepository } from "../../../db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../../db/repositories/accountRepository.js";
import { ActionRequestRepository } from "../../../db/repositories/actionRequestRepository.js";
import { AccessGrantRepository } from "../../../db/repositories/accessGrantRepository.js";
import { AgentRepository } from "../../../db/repositories/agentRepository.js";
import { ContextVariableRepository } from "../../../db/repositories/contextVariableRepository.js";
import { IdentityNonceRepository } from "../../../db/repositories/identityNonceRepository.js";
import { RoutineDefinitionRepository } from "../../../db/repositories/routineDefinitionRepository.js";
import { RoutineStateRepository } from "../../../db/repositories/routineStateRepository.js";
import { DirectiveStateRepository } from "../../../db/repositories/directiveStateRepository.js";
import { ConversationSummaryRepository } from "../../../db/repositories/conversationSummaryRepository.js";
import {
  ConversationSummaryService,
  ModelConversationSummaryGenerator,
} from "../../../modules/chat/composition.js";
import { PendingDecisionRepository } from "../../../db/repositories/pendingDecisionRepository.js";
import { ClarificationStateRepository } from "../../../db/repositories/clarificationStateRepository.js";
import { createConversationEngine } from "@radioso/conversation-engine";
import type { AgentSkillSettingsRegistry, AgentSurfaceExtensionRegistry } from "../../../modules/agents/public.js";
import { AuditEventRepository } from "../../../db/repositories/auditEventRepository.js";
import { BootstrapGreetingCacheRepository } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { DocumentProcessingJobRepository } from "../../../db/repositories/documentProcessingJobRepository.js";
import { EmbeddingProfileJobRepository } from "../../../db/repositories/embeddingProfileJobRepository.js";
import { EmbeddingProfileCleanupRepository } from "../../../db/repositories/embeddingProfileCleanupRepository.js";
import { DocumentRepository } from "../../../db/repositories/documentRepository.js";
import { DocumentSourceRepository } from "../../../db/repositories/documentSourceRepository.js";
import { EmbeddingProfileRepository } from "../../../db/repositories/embeddingProfileRepository.js";
import { VectorIndexWorkRepository } from "../../../db/repositories/vectorIndexWorkRepository.js";
import { EmailVerificationTokenRepository } from "../../../db/repositories/emailVerificationTokenRepository.js";
import { HistoryItemsRepository } from "../../../db/repositories/historyItemsRepository.js";
import { IngestionSettingsRepository } from "../../../db/repositories/ingestionSettingsRepository.js";
import { MessageRepository } from "../../../db/repositories/messageRepository.js";
import { PasswordResetTokenRepository } from "../../../db/repositories/passwordResetTokenRepository.js";
import { RetrievalSettingsRepository } from "../../../db/repositories/retrievalSettingsRepository.js";
import { SessionRepository } from "../../../db/repositories/sessionRepository.js";
import { UserRepository } from "../../../db/repositories/userRepository.js";
import { WebsiteCrawlJobRepository } from "../../../db/repositories/websiteCrawlJobRepository.js";
import { WorkspaceGrantRepository } from "../../../db/repositories/workspaceGrantRepository.js";
import { WorkspaceRepository } from "../../../db/repositories/workspaceRepository.js";
import { WorkspaceTokenRepository } from "../../../db/repositories/workspaceTokenRepository.js";
import { LlmResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import { LlmHandoffWaitingMessageGenerator } from "../../../shared/services/handoffWaitingMessageGenerator.js";
import { PostgresAssistantTurnPersistence } from "../../../modules/chat/infra/postgresAssistantTurnPersistence.js";
import { registeredCapabilityNames } from "../../../shared/domain/capabilityPolicy.js";
import { AccountAccessService, AccountInvitationService } from "../../../modules/account/public.js";
import { AccessGrantService, DefaultOriginMatcher } from "../../../modules/accessGrants/public.js";
import { AgentService } from "../../../modules/agents/public.js";
import { AuditService } from "../../../modules/audit/composition.js";
import { ApprovalDecisionService } from "../../../modules/approvals/public.js";
import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import { AuthService } from "../../../modules/auth/services/authService.js";
import { PostgresOrganizationProvisioner } from "../../../modules/auth/infra/postgresOrganizationProvisioner.js";
import { EmailVerificationService } from "../../../modules/auth/services/emailVerificationService.js";
import { PasswordResetService } from "../../../modules/auth/services/passwordResetService.js";
import { WorkspaceSessionService } from "../../../modules/auth/services/workspaceSessionService.js";
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
  DefaultClarifier,
  SkillRetrievalTurnDispatch,
  WorkbenchReplayRunner,
  TurnPlanCoordinator,
  TurnPlanService,
  planAwareRoutineActivator,
  planAwareRoutineReentryGate,
  planAwareRoutineSlotCorrection,
  AgentConverseAudit,
  AgentConverseService,
} from "../../../modules/chat/composition.js";
import {
  createDefaultConnectorRegistry,
  createDefaultChunkingStrategyRegistry,
  createDefaultDocumentJobConsumer,
  createDefaultDocumentJobDispatcher,
  createDefaultDocumentStorage,
  createDefaultWebsiteCrawlJobConsumer,
  createDefaultWebsiteCrawlJobDispatcher,
  type ApplicationComposition,
} from "../../composition/index.js";
import {
  ChunkRepository,
  type DocumentJobDispatcherPort,
  DocumentDeletionService,
  DocumentEnrichmentService,
  DocumentImportService,
  DocumentIngestionService,
  type EmbeddingCoverageReconciliationPort,
  ModelDocumentEnrichmentGateway,
  DocumentProcessingService,
  DocumentProcessingWorker,
  EmbeddingProfileJobService,
  type EmbeddingProfileTerminalFailurePort,
  DocumentSearchHistoryService,
  DocumentSearchService,
  DocumentSourceReprocessService,
  DocumentSourceContentService,
  WorkspaceIngestionReprocessService,
  AgentConverseResourceService,
} from "../../../modules/documents/composition.js";
import {
  AgenticRetrievalPipelineService,
  AgenticRetrievalRunner,
  GatewayQueryRewritePortAdapter,
  ModelSenseLabelGateway,
  type ChunkCandidateHydratorPort,
  PgLexicalSearch,
  PostgresSenseEmbeddingReader,
  PgVectorChunkStorage,
  PromptBuilder,
  RetrievalAnswerExecutor,
  RetrievalAnswerService,
  SenseGroupingService,
  createDefaultRetrievalServices,
  AgentConverseGroundedAnswerService,
  type RetrievalSensePolicy,
  type RetrievalPipelinePort,
} from "../../../modules/retrieval/composition.js";
import type {
  ClusteringEmbeddingPort,
  DocumentEmbeddingPort,
  PinnedDocumentEmbeddingPort,
  QueryEmbeddingPort,
} from "../../../modules/embeddingProfiles/contracts/embeddingConsumers.js";
import {
  EmbeddingProfileCleanupService,
  type EmbeddingProfileProjectionCleanupPort,
} from "../../../modules/embeddingProfiles/public.js";
import type { VectorCandidateSearchPort } from "../../../modules/retrieval/domain/vectorAdapter.js";
import { AgenticCapabilityRunner, DefaultAgentRuntime } from "../../../shared/agent-runtime/index.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { AbuseControlRepository } from "../../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../../modules/security/services/abuseControlService.js";
import {
  WorkspaceProviderCredentialsRepository,
  type WorkspaceProviderCredentialsRepositoryPort,
} from "../../../db/repositories/workspaceProviderCredentialsRepository.js";
import { WorkspaceProviderCredentialsService } from "../../../modules/security/credentials/services/workspaceProviderCredentialsService.js";
import { WebhookDestinationRepository } from "../../../db/repositories/webhookDestinationRepository.js";
import { CustomerEmailConnectionRepository } from "../../../db/repositories/customerEmailConnectionRepository.js";
import { EmailSkillDefinitionRepository } from "../../../db/repositories/emailSkillDefinitionRepository.js";
import { EmailSkillActivityRepository } from "../../../db/repositories/emailSkillActivityRepository.js";
import { WebhookSkillDefinitionRepository } from "../../../db/repositories/webhookSkillDefinitionRepository.js";
import { OauthConnectionRepository } from "../../../db/repositories/oauthConnectionRepository.js";
import { IntegrationConnectionRepository } from "../../../modules/integrationConnections/public.js";
import {
  SlackChannelBindingRepository,
  SlackInstallationRepository,
} from "../../../modules/slack/public.js";
import {
  DefaultWebhookDestinationAdapter,
  WebhookDestinationService,
  FetchWebhookHttpClient,
  type WebhookDestinationPublicAdapter,
  type WebhookDestinationRepositoryPort,
  type WebhookDestinationRoutineReferencePort,
  type WebhookDestinationRuntimePort,
} from "../../../modules/webhooks/public.js";
import { WorkspaceLlmCapabilitySettingsService } from "../../../modules/settings/composition.js";
import type { WorkspaceLlmCapabilityPreferencesRepositoryPort } from "../../../modules/settings/composition.js";
import { WorkspaceLlmCapabilityResolver } from "../../composition/workspaceLlmCapabilityResolver.js";
import type { LlmCapabilityResolver } from "../../../shared/infra/llm/capabilityResolver.js";
import type { LlmProviderName } from "../../../shared/infra/llm/providerTypes.js";
import {
  embeddingModelIds,
  IngestionSettingsService,
  PlatformSettingsService,
  AgentConverseSessionService,
  type EmbeddingModelTransitionPort,
} from "../../../modules/settings/composition.js";
import type { EmbeddingModelId } from "../../../modules/settings/contracts/ingestion.js";
import {
  SkillCatalogService,
  retrievalAnswerSkillDefinition,
  routineDispatchableBuiltInSkills,
  type RoutineInvocableSkillNames,
} from "../../../modules/skills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER, RetrievalAnswerSkillExecutor } from "../../../modules/retrieval/public.js";
import { RetrieveRoutineSkillResolver } from "../../../modules/retrieval/public.js";
import { EXTERNAL_SKILLS_ADAPTER, McpSkillExecutor } from "../../../modules/externalSkills/executor/mcpSkillExecutor.js";
import { buildExternalSkillsDeps } from "../../../modules/externalSkills/composition.js";
import { ExternalSkillRoutineSkillResolver } from "../../../modules/externalSkills/routineSkillResolver.js";
import {
  CUSTOMER_EMAIL_SKILLS_ADAPTER,
  CustomerEmailDeliveryService,
  CustomerEmailRoutineSkillResolver,
  EmailSkillExecutor,
  MockCustomerEmailProviderAdapter,
  StaticCustomerEmailProviderRegistry,
  customerEmailOauthProviderIds,
} from "../../../modules/customerEmail/public.js";
import {
  WEBHOOK_SKILLS_ADAPTER,
  WebhookRoutineSkillResolver,
  WebhookSkillExecutor,
} from "../../../modules/webhookSkills/public.js";
import {
  SLACK_SKILLS_ADAPTER,
  SlackEscalationExecutor,
  SlackRoutineSkillResolver,
  SlackSkillDefinitionRepository,
} from "../../../modules/slackSkills/public.js";
import { NotifyExecutor, NOTIFY_SKILLS_ADAPTER } from "../../../modules/notify/notifyExecutor.js";
import { createRoutineTurnProvider, type RoutineTriggerEmbeddingService } from "../../../modules/routines/public.js";
import { WebsiteCrawlJobService } from "../../../modules/websiteCrawler/jobService.js";
import { RadiosoCrawlerProvider } from "../../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import { WebsiteCrawlWorker } from "../../../modules/websiteCrawler/worker.js";
import { WorkspaceService, WorkspaceSummaryService } from "../../../modules/workspace/public.js";
import type { RetrievalDefaultsProvider, SkillSettingsResolver } from "../../../modules/retrieval/public.js";
import { ProductAnalyticsService } from "../../../shared/analytics/productAnalyticsService.js";
import type { OrganizationCreationGuard } from "../../../shared/domain/organizationCreationGuard.js";
import { NoopUsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";
import { DurableUsageEventRecorder } from "../../../shared/infra/usage/durableUsageEventRecorder.js";
import { ErrorReportingService } from "../../../shared/errors/errorReportingService.js";
import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import { Database } from "../../../shared/infra/database.js";
import { resolveLlmConfig } from "../../../shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../../shared/infra/llm/providerRegistry.js";
import { ContextualDirectiveMatchGatewayFactory, ContextualTurnPlanGatewayFactory } from "../../../shared/infra/llm/contextualGateways.js";
import { TextGenerationClientCache } from "../../../shared/infra/llm/textClientFactory.js";
import { createMailService } from "../../../modules/mail/public.js";
import { AgentSkillRepository } from "../../../modules/agentSkills/public.js";
import { ContextVariableResolverService } from "../../../modules/context-variables/public.js";
import { SkillBackedContextResolver } from "../../composition/builtIn/contextResolverModule.js";
import { RepositoryAgentSkillTurnSkillProvider } from "../../composition/builtIn/agentSkillTurnSkillProvider.js";
import { createLogger, type AppLogger } from "../../../shared/observability/logger.js";
import { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import { createPublishedRoutineRegistrationSource } from "../../composition/routineDefinitionSource.js";
import { ChatAnswerSupport, recordClarificationDecision } from "../../../modules/chat/composition.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  createDefaultAnalyticsSinks,
  createDefaultErrorSinks,
  createDefaultTelemetrySinks,
} from "../../composition/index.js";
import type { Env } from "../../config/env.js";
import type {
  McpConverseRouteDependencies,
  McpConverseRouteServices,
} from "../../http/routes/mcpConverseRoutes.js";
import type { ChatTurnPlanHandle } from "../../../modules/chat/services/turnPlanCoordinator.js";


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
  embeddingProfileRepository: new EmbeddingProfileRepository(database.kysely),
  vectorIndexWorkRepository: new VectorIndexWorkRepository(database.kysely),
  embeddingProfileJobRepository: new EmbeddingProfileJobRepository(database.kysely),
  embeddingProfileCleanupRepository: new EmbeddingProfileCleanupRepository(database.kysely),
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

export const buildLogger = (): AppLogger => createLogger();

// Compatibility export for existing focused tests; the algorithm itself belongs
// to the routines module rather than application composition.
