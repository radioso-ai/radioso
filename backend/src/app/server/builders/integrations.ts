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
import { buildInfrastructure, buildRepositories } from "./infra.js";
import { McpConnectionService } from "../../../modules/externalSkills/services/mcpConnectionService.js";
import { ExternalSkillDefinitionService } from "../../../modules/externalSkills/services/externalSkillDefinitionService.js";
import { createMcpToolServiceFactory } from "../../../modules/externalSkills/composition.js";
import { McpConnectionRepository } from "../../../db/repositories/mcpConnectionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../../db/repositories/externalSkillDefinitionRepository.js";
import { OauthConnectionService, StaticOauthProviderRegistry } from "../../../modules/integrationOauth/public.js";
import {
  CustomerEmailConnectionService,
  CustomerEmailOAuthService,
} from "../../../modules/customerEmail/public.js";
import {
  SlackInstallationService,
  PostgresWorkspaceAccountLookup,
  type SlackOauthMetadata,
} from "../../../modules/slack/public.js";
import { WebhookSkillDefinitionService } from "../../../modules/webhookSkills/public.js";
import { SlackSkillDefinitionService } from "../../../modules/slackSkills/public.js";
import { AgentSkillsService } from "../../../modules/agentSkills/public.js";
import {
  createDefaultSkillCapabilityRegistry,
  RoutineInvocableSkillNamesService,
} from "../../../modules/skills/public.js";
import { EmailSkillDefinitionService } from "../../../modules/customerEmail/public.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../../modules/documents/contracts/index.js";
import { MCP_OAUTH_CALLBACK_PATH } from "../../../modules/externalSkills/domain.js";


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

/** Builds OAuth-backed integrations and the shared agent-skill registry. */
export const buildIntegrationServices = (input: {
  assertPublicUrl: (url: string) => Promise<void>;
  composition: ApplicationComposition;
  env: Env;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
}) => {
  const slackInstallationService = new SlackInstallationService({
    oauthConnections: new OauthConnectionRepository(input.infrastructure.database.kysely),
    integrationConnections: input.repositories.integrationConnectionRepository,
    installations: input.repositories.slackInstallationRepository,
    bindings: input.repositories.slackChannelBindingRepository,
    workspaceAccounts: new PostgresWorkspaceAccountLookup(input.infrastructure.database.kysely),
    encryptionKey: input.env.CONNECTOR_ENCRYPTION_KEY,
  });
  const oauthConnectionService = new OauthConnectionService({
    repository: new OauthConnectionRepository(input.infrastructure.database.kysely),
    providers: new StaticOauthProviderRegistry(input.composition.oauthProviders),
    encryptionKey: input.env.CONNECTOR_ENCRYPTION_KEY,
    appBaseUrl: input.env.APP_BASE_URL,
    apiBaseUrl: input.env.CONNECTOR_PUBLIC_BASE_URL ?? input.env.APP_BASE_URL,
    assertPublicUrl: input.assertPublicUrl,
    logger: input.logger,
    onAuthorized: async ({ connection, tokens, metadata }) => {
      if (connection.provider !== "slack") {
        return;
      }
      const slackMetadata = metadata as Partial<SlackOauthMetadata>;
      if (!slackMetadata.teamId || !slackMetadata.botUserId) {
        throw new Error("Slack OAuth metadata was missing team or bot identity");
      }
      await slackInstallationService.saveInstallation({
        workspaceId: connection.workspaceId,
        oauthConnectionId: connection.id,
        teamId: slackMetadata.teamId,
        teamName: slackMetadata.teamName ?? null,
        botUserId: slackMetadata.botUserId,
        botAccessToken: tokens.accessToken,
        grantedScopes: connection.grantedScopes,
      });
    },
  });
  const customerEmailOAuthService = new CustomerEmailOAuthService(oauthConnectionService);
  const customerEmailConnectionService = new CustomerEmailConnectionService({
    repository: input.repositories.customerEmailConnectionRepository,
    oauthConnections: oauthConnectionService,
    providers: new StaticCustomerEmailProviderRegistry(
      customerEmailOauthProviderIds.map((provider) => new MockCustomerEmailProviderAdapter(provider)),
    ),
  });
  const mcpConnectionRepository = new McpConnectionRepository(input.infrastructure.database.kysely);
  const externalSkillDefinitionRepository = new ExternalSkillDefinitionRepository(input.infrastructure.database.kysely);
  const mcpConnectionService = new McpConnectionService({
    repository: mcpConnectionRepository,
    toolServiceFactory: createMcpToolServiceFactory(input.assertPublicUrl),
    encryptionKey: input.env.CONNECTOR_ENCRYPTION_KEY,
    assertPublicUrl: input.assertPublicUrl,
    oauthRedirectUri: input.env.APP_BASE_URL
      ? `${input.env.APP_BASE_URL.replace(/\/$/, "")}${MCP_OAUTH_CALLBACK_PATH}`
      : undefined,
    logger: input.logger,
  });
  const externalSkillDefinitionService = new ExternalSkillDefinitionService(
    externalSkillDefinitionRepository,
    mcpConnectionService,
  );
  const emailSkillDefinitionService = new EmailSkillDefinitionService({
    repository: input.repositories.emailSkillDefinitionRepository,
    connections: input.repositories.customerEmailConnectionRepository,
  });
  const webhookDestinations = buildWebhookDestinationAdapter({
    auditService: input.infrastructure.auditService,
    env: input.env,
    logger: input.logger,
    repositories: input.repositories,
    assertPublicUrl: input.assertPublicUrl,
  });
  const webhookSkillDefinitionService = new WebhookSkillDefinitionService({
    repository: input.repositories.webhookSkillDefinitionRepository,
    destinations: webhookDestinations,
  });
  const slackSkillDefinitionService = new SlackSkillDefinitionService({
    repository: input.repositories.slackSkillDefinitionRepository,
    installations: input.repositories.slackInstallationRepository,
  });
  const skillCapabilityRegistry = createDefaultSkillCapabilityRegistry({
    mcp_tool: async ({ agentId }) =>
      (await mcpConnectionService.list(agentId)).map((connection) => ({
        id: connection.id,
        label: connection.displayName,
        status: connection.status,
      })),
    email: async ({ workspaceId }) =>
      (await customerEmailConnectionService.list(workspaceId)).map((connection) => ({
        id: connection.id,
        label: connection.displayName,
        status: connection.status,
      })),
    slack_post: async ({ workspaceId }) => {
      const status = await slackInstallationService.getStatus(workspaceId);
      return status.installationId
        ? [{ id: status.installationId, label: status.teamName ?? "Slack", status: status.status }]
        : [];
    },
    webhook_call: async ({ workspaceId }) =>
      (await webhookDestinations.list(workspaceId)).map((destination) => ({
        id: destination.id,
        label: destination.name,
        status: destination.lastDeliveryStatus ?? undefined,
      })),
    retrieve: async ({ workspaceId }) => {
      const [sources, manualDocumentCount] = await Promise.all([
        input.repositories.documentSourceRepository.listByWorkspaceIdWithDocumentCounts(workspaceId),
        input.repositories.documentSourceRepository.countDocumentsWithoutSource(workspaceId),
      ]);
      return [
        ...sources.map((source) => ({
          id: source.id,
          label: source.name,
          status: source.lastSyncStatus ?? undefined,
        })),
        ...(manualDocumentCount > 0
          ? [{ id: MANUALLY_ADDED_DOCUMENTS_SOURCE_ID, label: "Manually added documents", status: "available" }]
          : []),
      ];
    },
  });
  const agentSkillRepository = new AgentSkillRepository(input.infrastructure.database.kysely);
  const routineInvocableSkillNames = new RoutineInvocableSkillNamesService({ agentSkills: agentSkillRepository });
  const agentSkillsService = new AgentSkillsService({
    repository: agentSkillRepository,
    capabilities: skillCapabilityRegistry,
    logger: input.logger,
  });
  return {
    agentSkillRepository,
    agentSkillsService,
    customerEmailConnectionService,
    customerEmailOAuthService,
    emailSkillDefinitionService,
    externalSkillDefinitionRepository,
    externalSkillDefinitionService,
    mcpConnectionRepository,
    mcpConnectionService,
    oauthConnectionService,
    slackInstallationService,
    slackSkillDefinitionService,
    skillCapabilityRegistry,
    routineInvocableSkillNames,
    webhookDestinations,
    webhookSkillDefinitionService,
  };
};
