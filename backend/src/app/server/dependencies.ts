import { getEnv, type Env } from "../config/env.js";
import {
  createDefaultApplicationComposition,
  type ApplicationModule,
} from "../composition/index.js";
import { AgentService, AgentSurfaceExtensionRegistry } from "../../modules/agents/public.js";
import { PlatformSettingsService } from "../../modules/settings/composition.js";
import type { AppDependencies } from "./types.js";
import {
  buildAccessServices,
  buildAuthService,
  buildChatServices,
  buildConnectorRegistry,
  buildDocumentServices,
  buildInfrastructure,
  buildLlmRegistry,
  buildLogger,
  buildRepositories,
  buildRetrievalServices,
  buildSettingsServices,
  buildWorkspaceServices,
} from "./dependencyBuilders.js";
import { EmbeddingService } from "../../modules/retrieval/composition.js";
import { resolveWebsiteCrawlerConfig } from "../../modules/websiteCrawler/config.js";
import { assertPublicWebsiteUrl } from "../../modules/websiteCrawler/urlPolicy.js";
import { SkillCatalogService } from "../../modules/skills/public.js";

export interface BuildDependenciesOptions {
  modules?: ApplicationModule[];
}

export const buildDependencies = (env: Env = getEnv(), options: BuildDependenciesOptions = {}): AppDependencies => {
  const logger = buildLogger();
  const composition = createDefaultApplicationComposition({
    logger,
    modules: options.modules,
  });
  const infrastructure = buildInfrastructure({ env, logger, composition });
  const agentSurfaceExtensions = new AgentSurfaceExtensionRegistry();
  for (const extension of composition.agentSurfaceExtensions) {
    agentSurfaceExtensions.register(extension);
  }
  const repositories = buildRepositories(infrastructure.database, { agentSurfaceExtensions });
  const access = buildAccessServices({
    auditService: infrastructure.auditService,
    repositories,
  });
  const llmRegistry = buildLlmRegistry(env, logger);
  const embeddingService = new EmbeddingService(llmRegistry.createEmbeddingGateway());
  const settings = buildSettingsServices({
    auditService: infrastructure.auditService,
    documentRepository: repositories.documentRepository,
    ingestionSettingsRepository: repositories.ingestionSettingsRepository,
    productAnalyticsService: infrastructure.productAnalyticsService,
    retrievalSettingsRepository: repositories.retrievalSettingsRepository,
  });
  const documents = buildDocumentServices({
    auditEventRepository: infrastructure.auditEventRepository,
    auditService: infrastructure.auditService,
    composition,
    documentSourceRepository: repositories.documentSourceRepository,
    embeddingService,
    env,
    logger,
    productAnalyticsService: infrastructure.productAnalyticsService,
    repositories,
    settings,
    telemetryService: infrastructure.telemetryService,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
  });
  const retrieval = buildRetrievalServices({
    auditService: infrastructure.auditService,
    database: infrastructure.database,
    documentRepository: repositories.documentRepository,
    embeddingService,
    llmRegistry,
    logger,
    retrievalSettingsService: settings.retrievalSettingsService,
    telemetryService: infrastructure.telemetryService,
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
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    workspaceRepository: repositories.workspaceRepository,
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
  const connectorRegistry = buildConnectorRegistry({ composition, env, logger });

  const chatTextGenerationClient = llmRegistry.createChatTextClient();

  // Lazy-loaded crawler provider for EE agent wizard
  const crawlerProvider = {
    async fetchPageWithScreenshot(url: string, options?: {
      signal?: AbortSignal;
      validateNavigationUrl?: (url: string) => Promise<void> | void;
      [key: string]: unknown;
    }) {
      const { fetchPageWithScreenshot } = await import("@radioso/crawler");
      return fetchPageWithScreenshot(url, options);
    },
    async crawlSite(params: {
      baseUrl: string;
      pageLimit: number;
      seedPendingUrls?: string[];
      includeBaseUrl?: boolean;
      signal?: AbortSignal;
    }) {
      const { crawlSite } = await import("@radioso/crawler");
      return crawlSite(params);
    },
    async isBrowserTransportAvailable() {
      const { isPlaywrightAvailable } = await import("@radioso/crawler");
      return isPlaywrightAvailable();
    },
  };

  return {
    env,
    logger,
    metricsRegistry: infrastructure.metricsRegistry,
    telemetryService: infrastructure.telemetryService,
    incidentReportingService: infrastructure.incidentReportingService,
    productAnalyticsService: infrastructure.productAnalyticsService,
    capabilityPolicy: composition.capabilityPolicy,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    chatIntakeProvider: chat.chatIntakeProvider,
    contactHistoryProvider: chat.contactHistoryProvider,
    applicationRouteMounts: composition.routeMounts,
    applicationModules: composition.lifecycle,
    authService,
    accountAccessService: access.accountAccessService,
    accountInvitationService: access.accountInvitationService,
    workspaceSessionService: workspace.workspaceSessionService,
    abuseControlService: chat.abuseControlService,
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
    connectorDb: infrastructure.database,
    chatTextGenerationClient,
    crawlerProvider,
    assertPublicWebsiteUrl,
    websiteCrawlerLimits: (() => {
      const config = resolveWebsiteCrawlerConfig();
      return { defaultLimit: config.defaultLimit, maxLimit: config.maxLimit };
    })(),
  };
};
