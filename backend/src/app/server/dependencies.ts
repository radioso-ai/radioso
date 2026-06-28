import { getEnv, type Env } from "../config/env.js";
import { McpConnectionService } from "../../modules/externalSkills/services/mcpConnectionService.js";
import { ExternalSkillDefinitionService } from "../../modules/externalSkills/services/externalSkillDefinitionService.js";
import { McpConnectionRepository } from "../../db/repositories/mcpConnectionRepository.js";
import { RoutineStateRepository } from "../../db/repositories/routineStateRepository.js";
import { OauthConnectionRepository } from "../../db/repositories/oauthConnectionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../db/repositories/externalSkillDefinitionRepository.js";
import { createMcpToolServiceFactory } from "../../modules/externalSkills/composition.js";
import { MCP_OAUTH_CALLBACK_PATH } from "../../modules/externalSkills/domain.js";
import {
  createDefaultApplicationComposition,
  createDefaultAgentSkillSettingsRegistry,
  createRetrievalSkillSettingsResolver,
  createSystemRetrievalDefaultsProvider,
  createDefaultDocumentJobDispatcher,
  type ApplicationModule,
} from "../composition/index.js";
import { AgentService, AgentSurfaceExtensionRegistry, AuthoredDirectiveService, DirectiveAuthorService } from "../../modules/agents/public.js";
import { InMemoryPublicConversationEventBus } from "../../modules/chat/composition.js";
import { RoutineDefinitionService, RoutineDraftAssistService } from "../../modules/routines/public.js";
import { createDirectiveCoherenceChecker, scopeTag } from "@radioso/conversation-defaults";
import { resolveEmbedConfigCacheInvalidator } from "../composition/builtIn/cloudCdnEmbedConfigCacheInvalidator.js";
import { PlatformSettingsService } from "../../modules/settings/composition.js";
import type { AppDependencies } from "./types.js";
import {
  buildAccessServices,
  buildAuthService,
  buildChatServices,
  buildConnectorRegistry,
  buildDocumentServices,
  buildEmailVerificationService,
  buildInfrastructure,
  buildLlmRegistry,
  buildLogger,
  buildPasswordResetService,
  buildRepositories,
  buildRetrievalServices,
  buildLlmCapabilityResolver,
  buildSettingsServices,
  buildWorkspaceIngestionReprocessService,
  buildWorkspaceLlmCapabilitySettingsService,
  buildWorkspaceProviderCredentialsService,
  buildWebhookDestinationAdapter,
  buildWorkspaceServices,
  listSupportedEmbeddingModels,
} from "./dependencyBuilders.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { registeredCapabilityNames } from "../../shared/domain/capabilityPolicy.js";
import { noopOrganizationCreationGuard } from "../../shared/domain/organizationCreationGuard.js";
import { EmbeddingService } from "../../modules/retrieval/composition.js";
import { resolveWebsiteCrawlerConfig } from "../../modules/websiteCrawler/config.js";
import { assertPublicWebsiteUrl } from "../../modules/websiteCrawler/urlPolicy.js";
import { createRadiosoCrawlerUtilityProvider } from "../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import {
  SkillAuthoringCatalogService,
  SkillCatalogService,
  routineAuthoringBuiltInSkills,
} from "../../modules/skills/public.js";
import { createConnectorIngestionPort } from "../../modules/connectors/services/connectorIngestionPort.js";
import {
  ChatGatewayLlmJudge,
  EvalCaseService,
  EvalRepository,
  EvalRunService,
  EvalSnapshotService,
  EvalSuiteService,
  RetrievalPipelineEvalRunner,
} from "../../modules/eval/composition.js";
import type { ConversationModelGateway } from "@radioso/conversation-contract";
import type { ModelInferencePipeline } from "../../shared/infra/llm/modelInferencePipeline.js";
import { OauthConnectionService, StaticOauthProviderRegistry } from "../../modules/integrationOauth/public.js";
import {
  PostgresSlackConversationLinkLookup,
  SlackInstallationService,
  SlackWebApiClient,
  type SlackOauthMetadata,
} from "../../modules/slack/public.js";
import {
  CustomerEmailConnectionService,
  CustomerEmailOAuthService,
  EmailSkillDefinitionService,
  MockCustomerEmailProviderAdapter,
  StaticCustomerEmailProviderRegistry,
  customerEmailOauthProviderIds,
} from "../../modules/customerEmail/public.js";
import { WebhookSkillDefinitionService } from "../../modules/webhookSkills/public.js";
import { SlackSkillDefinitionService } from "../../modules/slackSkills/public.js";
import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { ContextVariableRepository } from "../../db/repositories/contextVariableRepository.js";
import { CustomerReplyDeliveryDispatcher } from "../../modules/customerReplyDelivery/public.js";
import { OperatorReplyService } from "../../modules/handoff/public.js";
import { SlackCustomerReplyDeliverer } from "../../modules/slack/public.js";
import { AgentSkillRepository, AgentSkillsService } from "../../modules/agentSkills/public.js";
import { createDefaultSkillCapabilityRegistry } from "../../modules/skills/public.js";
import { bindSkillCapabilityExecutors } from "../composition/skillCapabilityRegistry.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../modules/documents/contracts/index.js";

export interface BuildDependenciesOptions {
  modules?: ApplicationModule[];
}

const createConversationModelGateway = (pipeline: ModelInferencePipeline): ConversationModelGateway => ({
  async complete(input) {
    const { text } = await pipeline.complete({
      prompt: input.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
      systemPrompt: input.systemPrompt,
      operation: {
        workspaceId: "directive-coherence",
        surface: "agents",
        operation: "directive_coherence",
        attemptKey: String(input.metadata?.candidateDirectiveName ?? "candidate"),
      },
    });
    return {
      text,
      metadata: {
        capability: pipeline.metadata.capability,
        provider: pipeline.metadata.provider,
        model: pipeline.metadata.model,
      },
    };
  },
});

export const buildDependencies = (env: Env = getEnv(), options: BuildDependenciesOptions = {}): AppDependencies => {
  const logger = buildLogger();
  const publicConversationEventBus = new InMemoryPublicConversationEventBus();
  const composition = createDefaultApplicationComposition({
    logger,
    env,
    modules: options.modules,
    widgetOrigin: env.RADIOSO_WIDGET_ORIGIN ?? env.APP_BASE_URL,
  });
  const infrastructure = buildInfrastructure({ env, logger, composition });
  const agentSurfaceExtensions = new AgentSurfaceExtensionRegistry();
  for (const extension of composition.agentSurfaceExtensions) {
    agentSurfaceExtensions.register(extension);
  }
  const agentSkillSettings = createDefaultAgentSkillSettingsRegistry();
  const repositories = buildRepositories(infrastructure.database, { agentSurfaceExtensions, agentSkillSettings });
  const access = buildAccessServices({
    auditService: infrastructure.auditService,
    env,
    repositories,
  });
  const workspaceProviderCredentialsService = buildWorkspaceProviderCredentialsService({
    auditService: infrastructure.auditService,
    env,
    logger,
    repositories,
  });
  const slackInstallationService = new SlackInstallationService({
    oauthConnections: new OauthConnectionRepository(infrastructure.database.kysely),
    integrationConnections: repositories.integrationConnectionRepository,
    installations: repositories.slackInstallationRepository,
    bindings: repositories.slackChannelBindingRepository,
    encryptionKey: env.CONNECTOR_ENCRYPTION_KEY,
  });
  const oauthConnectionService = new OauthConnectionService({
    repository: new OauthConnectionRepository(infrastructure.database.kysely),
    providers: new StaticOauthProviderRegistry(composition.oauthProviders),
    encryptionKey: env.CONNECTOR_ENCRYPTION_KEY,
    appBaseUrl: env.APP_BASE_URL,
    apiBaseUrl: env.CONNECTOR_PUBLIC_BASE_URL ?? env.APP_BASE_URL,
    assertPublicUrl: assertPublicWebsiteUrl,
    logger,
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
    repository: repositories.customerEmailConnectionRepository,
    oauthConnections: oauthConnectionService,
    providers: new StaticCustomerEmailProviderRegistry(
      customerEmailOauthProviderIds.map((provider) => new MockCustomerEmailProviderAdapter(provider)),
    ),
  });
  const mcpConnectionRepository = new McpConnectionRepository(infrastructure.database.kysely);
  const externalSkillDefinitionRepository = new ExternalSkillDefinitionRepository(infrastructure.database.kysely);
  const mcpConnectionService = new McpConnectionService({
    repository: mcpConnectionRepository,
    toolServiceFactory: createMcpToolServiceFactory(assertPublicWebsiteUrl),
    encryptionKey: env.CONNECTOR_ENCRYPTION_KEY,
    assertPublicUrl: assertPublicWebsiteUrl,
    oauthRedirectUri: env.APP_BASE_URL ? `${env.APP_BASE_URL.replace(/\/$/, "")}${MCP_OAUTH_CALLBACK_PATH}` : undefined,
    logger,
  });
  const externalSkillDefinitionService = new ExternalSkillDefinitionService(
    externalSkillDefinitionRepository,
    mcpConnectionService,
  );
  const emailSkillDefinitionService = new EmailSkillDefinitionService({
    repository: repositories.emailSkillDefinitionRepository,
    connections: repositories.customerEmailConnectionRepository,
  });
  const webhookDestinations = buildWebhookDestinationAdapter({
    auditService: infrastructure.auditService,
    env,
    logger,
    repositories,
    assertPublicUrl: assertPublicWebsiteUrl,
  });
  const webhookSkillDefinitionService = new WebhookSkillDefinitionService({
    repository: repositories.webhookSkillDefinitionRepository,
    destinations: webhookDestinations,
  });
  const slackSkillDefinitionService = new SlackSkillDefinitionService({
    repository: repositories.slackSkillDefinitionRepository,
    installations: repositories.slackInstallationRepository,
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
        ? [{
            id: status.installationId,
            label: status.teamName ?? "Slack",
            status: status.status,
          }]
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
        repositories.documentSourceRepository.listByWorkspaceIdWithDocumentCounts(workspaceId),
        repositories.documentSourceRepository.countDocumentsWithoutSource(workspaceId),
      ]);
      return [
        ...sources.map((source) => ({
          id: source.id,
          label: source.name,
          status: source.lastSyncStatus ?? undefined,
        })),
        ...(manualDocumentCount > 0
          ? [{
              id: MANUALLY_ADDED_DOCUMENTS_SOURCE_ID,
              label: "Manually added documents",
              status: "available",
            }]
          : []),
      ];
    },
  });
  const agentSkillsService = new AgentSkillsService({
    repository: new AgentSkillRepository(infrastructure.database.kysely),
    capabilities: skillCapabilityRegistry,
    logger,
  });
  // Build the registry first (no resolver yet) so we can compute supported embedding
  // models; embedding stays env-default and doesn't need the workspace-aware resolver.
  const llmRegistry = buildLlmRegistry(env, logger);
  const embeddingService = new EmbeddingService(llmRegistry.createEmbeddingGateway(infrastructure.usageEventRecorder));
  const documentJobDispatcher = composition.documentJobDispatcher ?? createDefaultDocumentJobDispatcher(env, logger);
  const workspaceIngestionReprocessService = buildWorkspaceIngestionReprocessService({
    auditService: infrastructure.auditService,
    documentJobDispatcher,
    repositories,
  });
  const supportedEmbeddingModels = listSupportedEmbeddingModels(llmRegistry);
  const settings = buildSettingsServices({
    auditService: infrastructure.auditService,
    documentRepository: repositories.documentRepository,
    ingestionSettingsRepository: repositories.ingestionSettingsRepository,
    supportedEmbeddingModels,
    workspaceIngestionReprocessService,
  });
  // Now that settings are available, build the capability service (backed by the
  // retrieval_settings row through the repository) and the resolver, then attach
  // the resolver to the registry before any chat/rewrite/rerank gateways are
  // constructed downstream.
  const workspaceLlmCapabilitySettingsService = buildWorkspaceLlmCapabilitySettingsService({
    auditService: infrastructure.auditService,
    capabilityRepository: repositories.retrievalSettingsRepository,
    logger,
  });
  const llmCapabilityResolver = buildLlmCapabilityResolver({
    env,
    defaults: resolveLlmConfig(env),
    settings: workspaceLlmCapabilitySettingsService,
    credentials: workspaceProviderCredentialsService,
  });
  llmRegistry.setResolver(llmCapabilityResolver);
  const documents = buildDocumentServices({
    auditEventRepository: infrastructure.auditEventRepository,
    auditService: infrastructure.auditService,
    composition,
    documentJobDispatcher,
    documentSourceRepository: repositories.documentSourceRepository,
    embeddingService,
    env,
    logger,
    productAnalyticsService: infrastructure.productAnalyticsService,
    repositories,
    settings,
    telemetryService: infrastructure.telemetryService,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    usageEventRecorder: infrastructure.usageEventRecorder,
    llmRegistry,
    workspaceIngestionReprocessService,
    errorReporter: infrastructure.errorReportingService,
  });
  const retrievalDefaultsProvider = createSystemRetrievalDefaultsProvider();
  const skillSettingsResolver = createRetrievalSkillSettingsResolver();
  const retrieval = buildRetrievalServices({
    auditService: infrastructure.auditService,
    database: infrastructure.database,
    documentRepository: repositories.documentRepository,
    embeddingService,
    ingestionSettingsService: settings.ingestionSettingsService,
    llmRegistry,
    logger,
    retrievalDefaultsProvider,
    skillSettingsResolver,
    telemetryService: infrastructure.telemetryService,
    usageEventRecorder: infrastructure.usageEventRecorder,
  });
  const workspace = buildWorkspaceServices({
    accountMembershipRepository: repositories.accountMembershipRepository,
    auditService: infrastructure.auditService,
    conversationRepository: repositories.conversationRepository,
    documentRepository: repositories.documentRepository,
    env,
    workspaceRepository: repositories.workspaceRepository,
  });
  const agentService = new AgentService(
    repositories.agentRepository,
    repositories.workspaceRepository,
    repositories.documentSourceRepository,
    resolveEmbedConfigCacheInvalidator({
      projectId: env.GOOGLE_CLOUD_PROJECT,
      urlMap: env.RADIOSO_CDN_URL_MAP,
      logger,
    }),
    access.accessGrantService,
    new AgentSkillRepository(infrastructure.database.kysely),
  );
  const chat = buildChatServices({
    accountAccessService: access.accountAccessService,
    agentService,
    auditEventRepository: infrastructure.auditEventRepository,
    auditService: infrastructure.auditService,
    bootstrapGreetingCacheRepository: repositories.bootstrapGreetingCacheRepository,
    composition,
    conversationOwnershipRepository: repositories.conversationOwnershipRepository,
    conversationRepository: repositories.conversationRepository,
    database: infrastructure.database,
    env,
    historyItemsRepository: repositories.historyItemsRepository,
    llmRegistry,
    llmCapabilityResolver,
    logger,
    mailService: infrastructure.mailService,
    messageRepository: repositories.messageRepository,
    metricsRegistry: infrastructure.metricsRegistry,
    telemetryService: infrastructure.telemetryService,
    webhookDestinations,
    productAnalyticsService: infrastructure.productAnalyticsService,
    publicConversationEventBus,
    routineDefinitionRepository: repositories.routineDefinitionRepository,
    customerEmailConnectionRepository: repositories.customerEmailConnectionRepository,
    emailSkillDefinitionRepository: repositories.emailSkillDefinitionRepository,
    emailSkillActivityRepository: repositories.emailSkillActivityRepository,
    webhookSkillDefinitionRepository: repositories.webhookSkillDefinitionRepository,
    slackSkillDefinitionRepository: repositories.slackSkillDefinitionRepository,
    retrievalPipeline: retrieval.retrievalPipeline,
    usageEventRecorder: infrastructure.usageEventRecorder,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    workspaceRepository: repositories.workspaceRepository,
    assertPublicWebsiteUrl,
    errorReporter: infrastructure.errorReportingService,
  });
  const skillCapabilityBindings = bindSkillCapabilityExecutors({
    capabilities: skillCapabilityRegistry,
    executors: composition.skillExecutorRegistry,
  });
  const unboundCapabilities = skillCapabilityBindings.filter((binding) => !binding.bound);
  if (unboundCapabilities.length > 0) {
    // A capability with no resolvable executor still advertises as available via
    // GET /skill-capabilities, so an author can create+enable a skill that only
    // fails at routine-dispatch time. This is a legitimate degraded mode (e.g.
    // email/external skipped when CONNECTOR_ENCRYPTION_KEY is unset), so warn
    // rather than fail boot — but make it observable instead of silent.
    logger.warn(
      {
        event: "skill_capability_executor_unbound",
        capabilities: unboundCapabilities.map((binding) => ({
          capability: binding.capabilityId,
          executorAdapter: binding.executorAdapter,
        })),
      },
      "One or more skill capabilities have no bound executor; skills using them will fail at dispatch",
    );
  }
  const platformSettingsService = new PlatformSettingsService({
    workspaceRepository: repositories.workspaceRepository,
    agentService,
    accessGrantService: access.accessGrantService,
    auditService: infrastructure.auditService,
    publicChatBaseUrl: env.PUBLIC_CHAT_BASE_URL,
    websiteEmbedIntegration: composition.websiteEmbedIntegration,
  });
  const skillCatalogService = new SkillCatalogService({
    capabilityPolicy: composition.capabilityPolicy,
    registry: composition.skillCatalogRegistry,
  });
  const skillAuthoringCatalog = new SkillAuthoringCatalogService({
    skillCatalog: skillCatalogService,
    externalSkills: externalSkillDefinitionService,
    logger,
  });
  const onAccountCreated = composition.accountCreatedHooks.length === 0
    ? undefined
    : async ({ accountId }: { accountId: string }) => {
        for (const hook of composition.accountCreatedHooks) {
          await hook({ accountId, database: infrastructure.database, logger });
        }
      };
  const organizationCreationGuardRegistration = composition.organizationCreationGuardRegistration;
  const organizationCreationGuard = !organizationCreationGuardRegistration
    ? noopOrganizationCreationGuard
    : typeof organizationCreationGuardRegistration === "function"
      ? organizationCreationGuardRegistration({ database: infrastructure.database, logger })
      : organizationCreationGuardRegistration;
  const authService = buildAuthService({
    access,
    auditService: infrastructure.auditService,
    env,
    organizationCreationGuard,
    onAccountCreated,
    repositories,
    workspaceService: workspace.workspaceService,
  });
  const passwordResetService = buildPasswordResetService({
    access,
    auditService: infrastructure.auditService,
    env,
    infrastructure,
    repositories,
    workspaceService: workspace.workspaceService,
  });
  const emailVerificationService = buildEmailVerificationService({
    auditService: infrastructure.auditService,
    env,
    infrastructure,
    repositories,
  });
  const connectorRegistry = buildConnectorRegistry({ composition, env, logger });
  const contextVariableRepository = new ContextVariableRepository(infrastructure.database.kysely);

  // Lazy-loaded crawler utility provider for EE agent wizard, also reused by
  // the connector ingestion port for HTML-to-text normalisation.
  const crawlerProvider = createRadiosoCrawlerUtilityProvider();

  const connectorIngestionPort = createConnectorIngestionPort({
    documentIngestionService: documents.documentIngestionService,
    documentDeletionService: documents.documentDeletionService,
    documentRepository: repositories.documentRepository,
    htmlContentNormalizer: {
      extractTextFromHtml: (html) => crawlerProvider.extractTextFromHtml(html),
    },
  });

  const chatInferencePipeline = llmRegistry.createChatInferencePipeline(infrastructure.usageEventRecorder);
  const authoredDirectiveService = new AuthoredDirectiveService({
    repository: repositories.agentRepository,
    coherenceChecker: createDirectiveCoherenceChecker({
      modelGateway: createConversationModelGateway(chatInferencePipeline),
    }),
    registeredCapabilityNames,
  });
  const routineDefinitionService = new RoutineDefinitionService({
    agentRepository: repositories.agentRepository,
    repository: repositories.routineDefinitionRepository,
    actionCapabilities: composition.actionCapabilityMap,
    capabilityPolicy: composition.capabilityPolicy,
    skillAuthoringCatalog,
    contextVariableReader: contextVariableRepository,
    // Mirror the runtime routine-skill resolver's name set (enabled webhook +
    // customer-email skills) so publish validation accepts what runtime routes.
    additionalRoutineSkillNames: async ({ workspaceId, agentId }) => {
      const [emails, webhooks] = await Promise.all([
        emailSkillDefinitionService.list(workspaceId, agentId),
        webhookSkillDefinitionService.list(workspaceId, agentId),
      ]);
      return [
        ...emails.filter((skill) => skill.enabled).map((skill) => skill.skillName),
        ...webhooks.filter((skill) => skill.enabled).map((skill) => skill.skillName),
      ];
    },
    webhookDestinations: {
      existsByIdAndWorkspace: async (inputWorkspaceId, destinationId) =>
        webhookDestinations.existsByIdAndWorkspace(inputWorkspaceId, destinationId),
    },
    auditService: infrastructure.auditService,
    directiveScopeTags: repositories.agentRepository,
  });
  const routineDraftAssistService = new RoutineDraftAssistService({
    repository: repositories.agentRepository,
    textGenerationClient: {
      complete: async ({ signal: _signal, ...input }) =>
        (await chatInferencePipeline.complete(input)).text,
    },
    actionCatalog: [
      ...routineAuthoringBuiltInSkills.map((skill) => ({
        type: skill.name,
        kind: "tool" as const,
        label: skill.displayName,
        description: skill.description,
        outcomeStatuses: skill.outcomes?.map((outcome) => outcome.name),
      })),
      ...composition.actionHandlerRegistrations.map((registration) => ({
        type: registration.type,
        kind: "action" as const,
      })),
    ],
    logger,
    telemetryService: infrastructure.telemetryService,
  });
  const directiveAuthorService = new DirectiveAuthorService({
    repository: repositories.agentRepository,
    textGenerationClient: {
      complete: async ({ signal: _signal, ...input }) =>
        (await chatInferencePipeline.complete(input)).text,
    },
    logger,
    telemetryService: infrastructure.telemetryService,
    buildStepScopeTag: scopeTag.step,
  });

  const evalRepository = new EvalRepository(infrastructure.database.kysely);
  const evalSnapshotService = new EvalSnapshotService(
    repositories.conversationRepository,
    repositories.messageRepository,
    repositories.agentRepository,
    retrievalDefaultsProvider,
    skillSettingsResolver,
    evalRepository,
    {
      connections: mcpConnectionRepository,
      skillDefinitions: externalSkillDefinitionRepository,
    },
    // Freeze the active routine position at capture time for faithful mid-routine replay.
    new RoutineStateRepository(infrastructure.database.kysely),
  );
  const evalCaseService = new EvalCaseService(evalRepository);
  const evalRunService = new EvalRunService(
    evalRepository,
    new RetrievalPipelineEvalRunner(
      retrieval.retrievalPipeline,
      chat.chatGateway,
      llmCapabilityResolver,
      retrievalDefaultsProvider,
      chat.answerPresentation,
      skillSettingsResolver,
    ),
    new ChatGatewayLlmJudge(chat.chatGateway),
    chat.workbenchReplayRunner,
    logger,
  );
  const evalSuiteService = new EvalSuiteService(evalRepository, evalRunService, logger);
  const customerReplyDelivery = new CustomerReplyDeliveryDispatcher({
    slack: new SlackCustomerReplyDeliverer({
      installations: repositories.slackInstallationRepository,
      installationService: slackInstallationService,
      persistence: new PostgresSlackConversationLinkLookup(infrastructure.database.kysely),
      slack: {
        conversationsOpen: async ({ users, botToken }) =>
          new SlackWebApiClient({ botToken }).conversationsOpen({ users }),
      },
      outbox: new ActionRequestRepository(infrastructure.database.kysely),
      logger,
    }),
  });
  const operatorReplyService = new OperatorReplyService({
    conversationRepository: repositories.conversationRepository,
    messageRepository: repositories.messageRepository,
    auditService: infrastructure.auditService,
    publicConversationEventBus,
    customerReplyDelivery,
  });

  return {
    env,
    logger,
    metricsRegistry: infrastructure.metricsRegistry,
    telemetryService: infrastructure.telemetryService,
    errorReportingService: infrastructure.errorReportingService,
    productAnalyticsService: infrastructure.productAnalyticsService,
    capabilityPolicy: composition.capabilityPolicy,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    organizationCreationGuard,
    publicChatActionAdvertiser: chat.publicChatActionAdvertiser,
    publicConversationEventBus,
    contactHistoryProvider: chat.contactHistoryProvider,
    applicationRouteMounts: composition.routeMounts,
    applicationModules: composition.lifecycle,
    authService,
    accessGrantService: access.accessGrantService,
    passwordResetService,
    emailVerificationService,
    accountAccessService: access.accountAccessService,
    accountInvitationService: access.accountInvitationService,
    workspaceSessionService: workspace.workspaceSessionService,
    abuseControlService: chat.abuseControlService,
    workspaceProviderCredentialsService,
    oauthConnectionService,
    slackInstallationService,
    customerEmailOAuthService,
    customerEmailConnectionService,
    emailSkillDefinitionService,
    webhookSkillDefinitionService,
    slackSkillDefinitionService,
    emailSkillActivityRepository: repositories.emailSkillActivityRepository,
    mcpConnectionService,
    externalSkillDefinitionService,
    webhookDestinations,
    workspaceLlmCapabilitySettingsService,
    auditService: infrastructure.auditService,
    mailService: infrastructure.mailService,
    workspaceService: workspace.workspaceService,
    workspaceSummaryService: workspace.workspaceSummaryService,
    ingestionSettingsService: settings.ingestionSettingsService,
    chunkRepository: repositories.chunkRepository,
    documentRepository: repositories.documentRepository,
    documentIngestionService: documents.documentIngestionService,
    documentSourceRepository: repositories.documentSourceRepository,
    documentImportService: documents.documentImportService,
    documentSearchService: retrieval.documentSearchService,
    documentSearchHistoryService: documents.documentSearchHistoryService,
    workspaceIngestionReprocessService: documents.workspaceIngestionReprocessService,
    documentProcessingWorker: documents.documentProcessingWorker,
    documentJobConsumer: documents.documentJobConsumer,
    websiteCrawlerProvider: documents.websiteCrawlerProvider,
    websiteCrawlJobService: documents.websiteCrawlJobService,
    websiteCrawlWorker: documents.websiteCrawlWorker,
    websiteCrawlJobConsumer: documents.websiteCrawlJobConsumer,
    documentDeletionService: documents.documentDeletionService,
    documentStorage: documents.documentStorage,
    chatService: chat.chatService,
    approvalDecisionService: chat.approvalDecisionService,
    operatorReplyService,
    workbenchReplayRunner: chat.workbenchReplayRunner,
    chatBootstrapService: chat.chatBootstrapService,
    chatHistoryService: chat.chatHistoryService,
    assistantChatService: chat.assistantChatService,
    assistantHistoryService: chat.assistantHistoryService,
    retrievalSearchService: retrieval.retrievalSearchService,
    retrievalAnswerService: chat.retrievalAnswerService,
    retrievalDefaultsProvider,
    actionDispatchWorker: chat.actionDispatchWorker,
    evalSnapshotService,
    evalCaseService,
    evalRunService,
    evalSuiteService,
    platformSettingsService,
    agentService,
    authoredDirectiveService,
    routineDefinitionService,
    routineDraftAssistService,
    directiveAuthorService,
    agentSurfaceExtensions,
    skillCatalogService,
    skillAuthoringCatalog,
    skillCapabilityRegistry,
    agentSkillsService,
    accountRepository: repositories.accountRepository,
    userRepository: repositories.userRepository,
    workspaceRepository: repositories.workspaceRepository,
    agentRepository: repositories.agentRepository,
    contextVariableRepository,
    identityNonceRepository: repositories.identityNonceRepository,
    bootstrapGreetingCacheRepository: repositories.bootstrapGreetingCacheRepository,
    conversationRepository: repositories.conversationRepository,
    conversationOwnershipRepository: repositories.conversationOwnershipRepository,
    messageRepository: repositories.messageRepository,
    connectorRegistry,
    connectorIngestionPort,
    connectorDb: infrastructure.database,
    chatInferencePipeline,
    crawlerProvider,
    assertPublicWebsiteUrl,
    websiteCrawlerLimits: (() => {
      const config = resolveWebsiteCrawlerConfig();
      return { defaultLimit: config.defaultLimit, maxLimit: config.maxLimit };
    })(),
  };
};
