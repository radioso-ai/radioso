import { getEnv, type Env } from "../config/env.js";
import {
  createDefaultAgentSkillSettingsRegistry,
  createDefaultApplicationComposition,
  type ApplicationModule,
} from "../composition/index.js";
import { AgentService, AgentSurfaceExtensionRegistry } from "../../modules/agents/public.js";
import { InMemoryPublicConversationEventBus, PostgresAudiencePulseHistorySource } from "../../modules/chat/composition.js";
import { createFacetExtractionWorker, FacetExtractionService } from "../../modules/facets/composition.js";
import { RoutineTriggerEmbeddingService } from "../../modules/routines/public.js";
import { resolveEmbedConfigCacheInvalidator } from "../composition/builtIn/cloudCdnEmbedConfigCacheInvalidator.js";
import { ContextualStructuredInferenceFactory, createRewriteTierStructuredInferenceFactory } from "../../shared/infra/llm/contextualGateways.js";
import type { AppDependencies } from "./types.js";
import {
  buildInfrastructure,
  buildLogger,
  buildRepositories,
} from "./builders/infra.js";
import {
  buildAccessServices,
  buildAuthService,
  buildEmailVerificationService,
  buildPasswordResetService,
  buildWorkspaceProviderCredentialsService,
} from "./builders/accessAuth.js";
import { buildChatServices } from "./builders/chat.js";
import { buildConnectorRegistry } from "./builders/integrations.js";
import { buildIntegrationServices } from "./builders/integrations.js";
import { buildDocumentRetrievalGraph } from "./builders/documentRetrievalGraph.js";
import {
  buildRoutineAuthoringServices,
  buildSkillCatalogServices,
} from "./builders/skillsRoutines.js";
import { buildAudiencePulseService } from "./builders/audiencePulse.js";
import { buildEvalServices } from "./builders/eval.js";
import { noopOrganizationCreationGuard } from "../../shared/domain/organizationCreationGuard.js";
import { ContextVariableRepository } from "../../db/repositories/contextVariableRepository.js";
import { createConnectorIngestionPort } from "../../modules/connectors/services/connectorIngestionPort.js";
import { ConnectorManagementService } from "../../modules/connectors/services/connectorManagementService.js";
import { resolveWebsiteCrawlerConfig } from "../../modules/websiteCrawler/config.js";
import { assertPublicWebsiteUrl } from "../../modules/websiteCrawler/urlPolicy.js";
import { createRadiosoCrawlerUtilityProvider } from "../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import { OperatorCopilotService } from "../../modules/operatorCopilot/public.js";
import { AgenticCapabilityRunner, DefaultAgentRuntime } from "../../shared/agent-runtime/index.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import { createCopilotToolCatalog } from "../composition/copilotToolCatalog.js";
import { createAgentSettingCopilotProposalAdapter, createDirectiveCopilotProposalAdapter, createRoutineCopilotProposalAdapter } from "../composition/copilotProposalAdapters.js";
import { QualityTurnsService, SkillCatalogOutcomeSource } from "../../modules/quality/composition.js";

export interface BuildDependenciesOptions {
  modules?: ApplicationModule[];
}

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
  const integrations = buildIntegrationServices({
    assertPublicUrl: assertPublicWebsiteUrl,
    composition,
    env,
    infrastructure,
    logger,
    repositories,
  });
  const {
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
  } = integrations;
  const documentRetrievalGraph = buildDocumentRetrievalGraph({
    composition,
    env,
    infrastructure,
    logger,
    repositories,
    workspaceProviderCredentialsService,
  });
  const {
    documents,
    embeddingBindingResolver,
    embeddingPorts,
    llmCapabilityResolver,
    llmRegistry,
    retrieval,
    retrievalDefaultsProvider,
    settings,
    skillSettingsResolver,
    vectorIndexReconciler,
    workspace,
    workspaceIngestionReprocessService,
    workspaceLlmCapabilitySettingsService,
  } = documentRetrievalGraph;
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
    agentSkillRepository,
  );
  // Shared by routine publishing (write-time trigger embedding) and the chat
  // activation prefilter (lazy self-heal of unembedded/stale rows) so both
  // paths dedup concurrent embedding work through one instance.
  const routineTriggerEmbeddingGateway = llmRegistry.createEmbeddingGateway(
    infrastructure.usageEventRecorder,
  );
  const routineTriggerEmbeddingService = new RoutineTriggerEmbeddingService({
    embeddings: {
      embedTexts: (texts, options) =>
        routineTriggerEmbeddingGateway.embedTexts(texts, options),
    },
    settings: settings.ingestionSettingsService,
    store: {
      get: ({ agentId, routineId }) => repositories.routineDefinitionRepository.getTriggerEmbeddingMetadata(agentId, routineId),
      save: (embedding) => repositories.routineDefinitionRepository.saveTriggerEmbedding(embedding),
      clear: (input) => repositories.routineDefinitionRepository.clearTriggerEmbedding(input),
    },
    logger,
  });
  const chat = buildChatServices({
    accountAccessService: access.accountAccessService,
    agentService,
    agentSkillRepository,
    auditEventRepository: infrastructure.auditEventRepository,
    auditService: infrastructure.auditService,
    bootstrapGreetingCacheRepository: repositories.bootstrapGreetingCacheRepository,
    composition,
    conversationOwnershipRepository: repositories.conversationOwnershipRepository,
    conversationRepository: repositories.conversationRepository,
    clusteringEmbeddings: embeddingPorts,
    database: infrastructure.database,
    env,
    historyItemsRepository: repositories.historyItemsRepository,
    llmRegistry,
    llmCapabilityResolver,
    logger,
    mailService: infrastructure.mailService,
    messageRepository: repositories.messageRepository,
    facetExtractionJobs: repositories.facetExtractionJobRepository,
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
    routineInvocableSkillNames,
    retrievalPipeline: retrieval.retrievalPipeline,
    retrievalDefaultsProvider,
    skillSettingsResolver,
    usageEventRecorder: infrastructure.usageEventRecorder,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    workspaceRepository: repositories.workspaceRepository,
    assertPublicWebsiteUrl,
    errorReporter: infrastructure.errorReportingService,
    ingestionSettingsService: settings.ingestionSettingsService,
    routineTriggerEmbeddingService,
  });
  const skillCatalog = buildSkillCatalogServices({
    accessGrantService: access.accessGrantService,
    agentService,
    agentSkillRepository,
    composition,
    externalSkillDefinitionService,
    infrastructure,
    logger,
    publicChatBaseUrl: env.PUBLIC_CHAT_BASE_URL,
    repositories,
    skillCapabilityRegistry,
  });
  const {
    platformSettingsService,
    skillAuthoringCatalog,
    skillCatalogService,
  } = skillCatalog;
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
      ? organizationCreationGuardRegistration({
          auditService: infrastructure.auditService,
          database: infrastructure.database,
          logger,
        })
      : organizationCreationGuardRegistration;
  const authService = buildAuthService({
    access,
    auditService: infrastructure.auditService,
    database: infrastructure.database,
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
    logger,
    repositories,
    workspaceService: workspace.workspaceService,
  });
  const emailVerificationService = buildEmailVerificationService({
    auditService: infrastructure.auditService,
    env,
    infrastructure,
    logger,
    repositories,
  });
  const connectorRegistry = buildConnectorRegistry({ composition, env, logger });
  const connectorManagementService = new ConnectorManagementService({
    database: infrastructure.database,
    registry: connectorRegistry,
  });
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
  const routineAuthoring = buildRoutineAuthoringServices({
    agentSkillRepository,
    chatInferencePipeline,
    composition,
    contextVariableRepository,
    infrastructure,
    logger,
    repositories,
    routineInvocableSkillNames,
    routineTriggerEmbeddingService,
    skillAuthoringCatalog,
    webhookDestinations,
  });
  const {
    authoredDirectiveService,
    directiveAuthorService,
    routineDefinitionService,
    routineDraftAssistService,
  } = routineAuthoring;
  const evalServices = buildEvalServices({
    chat,
    infrastructure,
    integrations,
    llmCapabilityResolver,
    logger,
    publicConversationEventBus,
    repositories,
    retrieval,
    retrievalDefaultsProvider,
    skillSettingsResolver,
  });
  const {
    evalCaseService,
    evalMessageCaseService,
    evalRunService,
    evalSnapshotService,
    evalSuiteService,
    operatorReplyService,
  } = evalServices;
  const qualitySignalsService = new QualityTurnsService(
    infrastructure.database.kysely,
    new SkillCatalogOutcomeSource(skillCatalogService),
    undefined,
    {
      getByAssistantMessageIds: (workspaceId, assistantMessageIds) =>
        evalMessageCaseService.lookupVerifications(workspaceId, assistantMessageIds),
    },
  );
  const audiencePulseService = buildAudiencePulseService({
    kysely: infrastructure.database.kysely,
    llmCapabilityResolver,
    usageEventRecorder: infrastructure.usageEventRecorder,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    auditService: infrastructure.auditService,
    logger,
    telemetryService: infrastructure.telemetryService,
    abuseControlService: chat.abuseControlService,
    embeddingBindingResolver,
  });
  const copilotProposalAdapters = [
    createDirectiveCopilotProposalAdapter({ authoredDirectiveService, directiveAuthorService, agentService }),
    createAgentSettingCopilotProposalAdapter({ agentService }),
    createRoutineCopilotProposalAdapter({ agentService, routineDraftAssistService, routineDefinitionService }),
  ] as const;
  const operatorCopilotService = new OperatorCopilotService({
    repository: repositories.copilotRepository,
    capabilityRunner: new AgenticCapabilityRunner({ runtime: new DefaultAgentRuntime({ gateway: llmRegistry.createToolCallingGateway(infrastructure.usageEventRecorder) }) }),
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    auditService: infrastructure.auditService,
    proposalAdapters: copilotProposalAdapters,
    prompt: loadPromptTemplate("copilot/system.md"),
    tools: createCopilotToolCatalog({
      agentService: {
        get: agentService.get.bind(agentService),
        listExisting: agentService.listExisting.bind(agentService),
        resolve: agentService.resolve.bind(agentService),
      },
      routineDefinitionService: {
        get: routineDefinitionService.get.bind(routineDefinitionService),
        list: routineDefinitionService.list.bind(routineDefinitionService),
      },
      chatHistoryService: chat.chatHistoryService,
      documentSearchService: retrieval.documentSearchService,
      evalResultsService: evalCaseService,
      qualitySignalsService,
      audiencePulseService,
      documentStatusService: documents.documentIngestionService,
      documentSourceStatusService: repositories.documentSourceRepository,
      agentSkillsService,
      skillCapabilityRegistry,
      workspaceRepository: repositories.workspaceRepository,
      workspaceSettings: {
        async getRetrievalDefaults(workspaceId) {
          return retrievalDefaultsProvider.getDefaults(workspaceId);
        },
        async getIngestionSettings(workspaceId) {
          return settings.ingestionSettingsService.getForWorkspace(workspaceId);
        },
        async listLlmModels(workspaceId) {
          return workspaceLlmCapabilitySettingsService.listForWorkspace(workspaceId);
        },
        async getProviderCredentialHealth(workspaceId) {
          return {
            encryptionConfigured: workspaceProviderCredentialsService.isEncryptionConfigured(),
            credentials: await workspaceProviderCredentialsService.listConfigured(workspaceId),
            envProviderAvailability: {
              openai: Boolean(env.OPENAI_API_KEY),
              "openai-compatible": Boolean(env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY),
              gemini: Boolean(env.GEMINI_API_KEY),
              claude: Boolean(env.ANTHROPIC_API_KEY),
            },
          };
        },
        async getGeneralSettings(workspaceId) {
          return platformSettingsService.getForWorkspace(workspaceId);
        },
      },
      proposalRepository: repositories.copilotRepository,
      proposalAdapters: copilotProposalAdapters,
      auditService: infrastructure.auditService,
    }),
  });
  // Per-message facet extraction (topic census). `composition.facetExtraction` lets a
  // host override the extractor entirely (mirroring `chunkingProvider` /
  // `websiteCrawlerProvider`); the OSS default below uses the cheap `"rewrite"` model
  // tier and the workspace's clustering embedding profile, the same ports the census
  // read path will consume.
  const facetExtractionWorker = createFacetExtractionWorker({
    jobs: repositories.facetExtractionJobRepository,
    extraction: composition.facetExtraction ?? new FacetExtractionService({
      messages: repositories.messageRepository,
      facets: repositories.messageFacetRepository,
      embeddings: embeddingPorts,
      inferenceFactory: createRewriteTierStructuredInferenceFactory(
        { resolver: llmCapabilityResolver },
        infrastructure.usageEventRecorder,
      ),
    }),
    logger,
    pollIntervalMs: env.FACET_EXTRACTION_WORKER_POLL_INTERVAL_MS,
    batchSize: env.FACET_EXTRACTION_WORKER_BATCH_SIZE,
    jobLeaseMs: env.FACET_EXTRACTION_JOB_LEASE_MS,
    telemetryService: infrastructure.telemetryService,
    errorReporter: infrastructure.errorReportingService,
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
    usageEventRecorder: infrastructure.usageEventRecorder,
    organizationCreationGuard,
    publicChatActionAdvertiser: chat.publicChatActionAdvertiser,
    publicConversationEventBus,
    contactHistoryProvider: chat.contactHistoryProvider,
    applicationRouteMounts: composition.routeMounts,
    applicationModules: composition.lifecycle,
    vectorIndexReconciler,
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
    llmCapabilityResolver,
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
    embeddingBindingResolver,
    documentSourceReprocessService: documents.documentSourceReprocessService,
    documentProcessingWorker: documents.documentProcessingWorker,
    documentJobConsumer: documents.documentJobConsumer,
    facetExtractionWorker,
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
    conversationForkService: chat.conversationForkService,
    assistantChatService: chat.assistantChatService,
    assistantHistoryService: chat.assistantHistoryService,
    retrievalSearchService: retrieval.retrievalSearchService,
    retrievalAnswerService: chat.retrievalAnswerService,
    retrievalDefaultsProvider,
    actionDispatchWorker: chat.actionDispatchWorker,
    evalSnapshotService,
    evalMessageCaseService,
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
    connectorManagementService,
    connectorIngestionPort,
    connectorDb: infrastructure.database,
    chatInferencePipeline,
    operatorCopilotService,
    qualitySignalsService,
    audiencePulseService,
    copilotRepository: repositories.copilotRepository,
    crawlerProvider,
    assertPublicWebsiteUrl,
    websiteCrawlerLimits: (() => {
      const config = resolveWebsiteCrawlerConfig();
      return { defaultLimit: config.defaultLimit, maxLimit: config.maxLimit };
    })(),
  };
};
