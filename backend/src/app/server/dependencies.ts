import { getEnv, type Env } from "../config/env.js";
import {
  createDefaultApplicationComposition,
  createDefaultAgentSkillSettingsRegistry,
  createRetrievalSkillSettingsResolver,
  createDefaultDocumentJobDispatcher,
  type ApplicationModule,
} from "../composition/index.js";
import { AgentService, AgentSurfaceExtensionRegistry } from "../../modules/agents/public.js";
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
  buildWorkspaceServices,
  listSupportedEmbeddingModels,
} from "./dependencyBuilders.js";
import { resolveLlmConfig } from "../../shared/infra/llm/providerConfig.js";
import { EmbeddingService } from "../../modules/retrieval/composition.js";
import { resolveWebsiteCrawlerConfig } from "../../modules/websiteCrawler/config.js";
import { assertPublicWebsiteUrl } from "../../modules/websiteCrawler/urlPolicy.js";
import { createRadiosoCrawlerUtilityProvider } from "../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import { SkillCatalogService } from "../../modules/skills/public.js";
import { createConnectorIngestionPort } from "../../modules/connectors/services/connectorIngestionPort.js";
import {
  ChatGatewayLlmJudge,
  EvalCaseService,
  EvalRepository,
  EvalRunService,
  EvalSnapshotService,
  RetrievalPipelineEvalRunner,
} from "../../modules/eval/composition.js";

export interface BuildDependenciesOptions {
  modules?: ApplicationModule[];
}

export const buildDependencies = (env: Env = getEnv(), options: BuildDependenciesOptions = {}): AppDependencies => {
  const logger = buildLogger();
  const composition = createDefaultApplicationComposition({
    logger,
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
    repositories,
  });
  const workspaceProviderCredentialsService = buildWorkspaceProviderCredentialsService({
    auditService: infrastructure.auditService,
    env,
    logger,
    repositories,
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
    productAnalyticsService: infrastructure.productAnalyticsService,
    retrievalSettingsRepository: repositories.retrievalSettingsRepository,
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
    retrievalSettingsService: settings.retrievalSettingsService,
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
  });
  const retrieval = buildRetrievalServices({
    auditService: infrastructure.auditService,
    database: infrastructure.database,
    documentRepository: repositories.documentRepository,
    embeddingService,
    ingestionSettingsService: settings.ingestionSettingsService,
    llmRegistry,
    logger,
    retrievalSettingsService: settings.retrievalSettingsService,
    skillSettingsResolver: createRetrievalSkillSettingsResolver(),
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
    settings.retrievalSettingsService,
    repositories.documentSourceRepository,
    resolveEmbedConfigCacheInvalidator({
      projectId: env.GOOGLE_CLOUD_PROJECT,
      urlMap: env.RADIOSO_CDN_URL_MAP,
      logger,
    }),
  );
  const chat = buildChatServices({
    agentService,
    auditEventRepository: infrastructure.auditEventRepository,
    auditService: infrastructure.auditService,
    bootstrapGreetingCacheRepository: repositories.bootstrapGreetingCacheRepository,
    composition,
    conversationRepository: repositories.conversationRepository,
    database: infrastructure.database,
    env,
    historyItemsRepository: repositories.historyItemsRepository,
    llmRegistry,
    logger,
    mailService: infrastructure.mailService,
    messageRepository: repositories.messageRepository,
    productAnalyticsService: infrastructure.productAnalyticsService,
    retrievalPipeline: retrieval.retrievalPipeline,
    usageEventRecorder: infrastructure.usageEventRecorder,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    workspaceRepository: repositories.workspaceRepository,
    assertPublicWebsiteUrl,
  });
  const platformSettingsService = new PlatformSettingsService({
    workspaceRepository: repositories.workspaceRepository,
    agentService,
    retrievalSettingsService: settings.retrievalSettingsService,
    auditService: infrastructure.auditService,
    publicChatBaseUrl: env.PUBLIC_CHAT_BASE_URL,
    websiteEmbedIntegration: composition.websiteEmbedIntegration,
  });
  const skillCatalogService = new SkillCatalogService({
    capabilityPolicy: composition.capabilityPolicy,
    registry: composition.skillCatalogRegistry,
  });
  const onAccountCreated = composition.accountCreatedHooks.length === 0
    ? undefined
    : async ({ accountId }: { accountId: string }) => {
        for (const hook of composition.accountCreatedHooks) {
          await hook({ accountId, database: infrastructure.database, logger });
        }
      };
  const authService = buildAuthService({
    access,
    auditService: infrastructure.auditService,
    env,
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

  const evalRepository = new EvalRepository(infrastructure.database);
  const evalSnapshotService = new EvalSnapshotService(
    repositories.conversationRepository,
    repositories.messageRepository,
    repositories.agentRepository,
    settings.retrievalSettingsService,
    evalRepository,
  );
  const evalCaseService = new EvalCaseService(evalRepository);
  const evalRunService = new EvalRunService(
    evalRepository,
    new RetrievalPipelineEvalRunner(
      retrieval.retrievalPipeline,
      chat.chatGateway,
      llmCapabilityResolver,
      settings.retrievalSettingsService,
      chat.answerPresentation,
    ),
    new ChatGatewayLlmJudge(chat.chatGateway),
  );

  return {
    env,
    logger,
    metricsRegistry: infrastructure.metricsRegistry,
    telemetryService: infrastructure.telemetryService,
    errorReportingService: infrastructure.errorReportingService,
    productAnalyticsService: infrastructure.productAnalyticsService,
    capabilityPolicy: composition.capabilityPolicy,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    publicChatActionAdvertiser: chat.publicChatActionAdvertiser,
    contactHistoryProvider: chat.contactHistoryProvider,
    applicationRouteMounts: composition.routeMounts,
    applicationModules: composition.lifecycle,
    authService,
    passwordResetService,
    emailVerificationService,
    accountAccessService: access.accountAccessService,
    accountInvitationService: access.accountInvitationService,
    workspaceSessionService: workspace.workspaceSessionService,
    abuseControlService: chat.abuseControlService,
    workspaceProviderCredentialsService,
    workspaceLlmCapabilitySettingsService,
    auditService: infrastructure.auditService,
    mailService: infrastructure.mailService,
    workspaceService: workspace.workspaceService,
    workspaceSummaryService: workspace.workspaceSummaryService,
    ingestionSettingsService: settings.ingestionSettingsService,
    retrievalSettingsService: settings.retrievalSettingsService,
    chunkRepository: repositories.chunkRepository,
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
    chatBootstrapService: chat.chatBootstrapService,
    chatHistoryService: chat.chatHistoryService,
    assistantChatService: chat.assistantChatService,
    assistantHistoryService: chat.assistantHistoryService,
    retrievalSearchService: retrieval.retrievalSearchService,
    retrievalAnswerService: chat.retrievalAnswerService,
    actionDispatchWorker: chat.actionDispatchWorker,
    evalSnapshotService,
    evalCaseService,
    evalRunService,
    platformSettingsService,
    agentService,
    agentSurfaceExtensions,
    skillCatalogService,
    accountRepository: repositories.accountRepository,
    userRepository: repositories.userRepository,
    workspaceRepository: repositories.workspaceRepository,
    agentRepository: repositories.agentRepository,
    bootstrapGreetingCacheRepository: repositories.bootstrapGreetingCacheRepository,
    conversationRepository: repositories.conversationRepository,
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
