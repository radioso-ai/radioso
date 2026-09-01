import { getEnv, type Env } from "../config/env.js";
import {
  createDefaultAgentSkillSettingsRegistry,
  createDefaultApplicationComposition,
  createDefaultFacetExtractionDrainDispatcher,
  createRealtimePublisherComposition,
  type ApplicationModule,
} from "../composition/index.js";
import { parseRealtimeConfig } from "../../modules/realtime/infrastructure/config.js";
import { createRealtimeRolloutPolicy } from "../../modules/realtime/domain/realtimeRolloutPolicy.js";
import { resolveGcpRedisCredentialsProvider } from "../../runtime/gcpMetadataRedisCredentials.js";
import type { RealtimePublisherComposition } from "../composition/realtimePublisherComposition.js";
import { AgentService, AgentSurfaceExtensionRegistry, serializeAuthoredDirectivesWithIds } from "../../modules/agents/public.js";
import { InMemoryPublicConversationEventBus, PostgresAudiencePulseHistorySource } from "../../modules/chat/composition.js";
import {
  createFacetExtractionWorker,
  FacetExtractionService,
  FacetExtractionWorkspaceDrainService,
} from "../../modules/facets/composition.js";
import { RoutineTriggerEmbeddingService } from "../../modules/routines/public.js";
import { MetadataRuleFieldReferenceService } from "../../modules/retrieval/public.js";
import { MetadataFieldSuggestionService } from "../../modules/settings/composition.js";
import { resolveEmbedConfigCacheInvalidator } from "../composition/builtIn/cloudCdnEmbedConfigCacheInvalidator.js";
import { ContextualStructuredInferenceFactory, createRewriteTierStructuredInferenceFactory } from "../../shared/infra/llm/contextualGateways.js";
import type { EvalRunOverrides } from "../../modules/eval/composition.js";
import { CopilotReplayEvidenceRepository } from "../../db/repositories/copilotReplayEvidenceRepository.js";
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
import { ContextVariableService } from "../../modules/context-variables/public.js";
import { createConnectorIngestionPort } from "../../modules/connectors/services/connectorIngestionPort.js";
import { ConnectorManagementService } from "../../modules/connectors/services/connectorManagementService.js";
import { resolveWebsiteCrawlerConfig } from "../../modules/websiteCrawler/config.js";
import { assertPublicWebsiteUrl } from "../../modules/websiteCrawler/urlPolicy.js";
import { normalizeBaseUrl } from "../../modules/websiteCrawler/public.js";
import { createRadiosoCrawlerUtilityProvider } from "../../modules/websiteCrawler/radiosoCrawlerProvider.js";
import {
  AgentTurnProbeService,
  EvalCaseCaptureService,
  EvalCaseReplayService,
  EvalSuiteProbeService,
  CopilotRetentionWorker,
  OperatorCopilotService,
  RetrievalProbeService,
} from "../../modules/operatorCopilot/public.js";
import { AgenticCapabilityRunner, DefaultAgentRuntime } from "../../shared/agent-runtime/index.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import { createCopilotDocumentAuthoringPort, createCopilotToolCatalog, createCopilotWorkspaceAccountResolver, createCopilotWorkspaceRouteKeyResolver } from "../composition/copilotToolCatalog.js";
import { ProbeConversationReader } from "../../modules/chat/composition.js";
import { ProbeRoutineReader } from "../../modules/routines/public.js";
import { createAgentSettingCopilotProposalAdapter, createAgentSkillCopilotProposalAdapter, createContextVariableCopilotProposalAdapter, createDirectiveCopilotProposalAdapter, createRoutineCopilotProposalAdapter } from "../../modules/operatorCopilot/proposalAdapters.js";
import { createDocumentCopilotProposalAdapter } from "../../modules/operatorCopilot/documentProposalAdapter.js";
import { createIngestionSettingsCopilotProposalAdapter } from "../../modules/operatorCopilot/ingestionSettingsProposalAdapter.js";
import { createWebsiteCrawlCopilotProposalAdapter } from "../../modules/operatorCopilot/websiteCrawlProposalAdapter.js";
import type { EmbeddingCoverageReadPort } from "../../modules/embeddingProfiles/public.js";
import { QualityTurnsService, SkillCatalogOutcomeSource } from "../../modules/quality/composition.js";

export interface BuildDependenciesOptions {
  modules?: ApplicationModule[];
  realtimePublisherComposition?: RealtimePublisherComposition;
}

export const buildDependencies = (env: Env = getEnv(), options: BuildDependenciesOptions = {}): AppDependencies => {
  const logger = buildLogger();
  const realtimeConfig = parseRealtimeConfig(env as Record<string, unknown>);
  const realtimeRolloutPolicy = createRealtimeRolloutPolicy(realtimeConfig.rollout);
  const realtimePublisherComposition = options.realtimePublisherComposition ?? createRealtimePublisherComposition({
    config: realtimeConfig,
    redisCredentialsProvider: realtimeConfig.redis.iam
      ? resolveGcpRedisCredentialsProvider(true)
      : undefined,
  });
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
    workspaceInvalidationPublisher: realtimePublisherComposition.publisher,
    workspaceProviderCredentialsService,
  });
  const {
    agentRetrievalScope,
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
  // Field suggestions for metadata rules are the catalog's declarations unioned
  // with the keys already observed on document metadata; the advisory reference
  // list is the same rules read the other way round.
  const metadataFieldSuggestionProvider = new MetadataFieldSuggestionService(
    settings.documentTypeCatalogService,
    repositories.documentRepository,
  );
  const metadataRuleFieldReferenceProvider = new MetadataRuleFieldReferenceService(agentSkillRepository);
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
    agentRetrievalScope,
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
    workspaceInvalidationPublisher: realtimePublisherComposition.publisher,
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
  const contextVariableService = new ContextVariableService({
    repository: contextVariableRepository,
    agentReader: { get: agentService.get.bind(agentService) },
    agentSkillsReader: { list: agentSkillsService.list.bind(agentSkillsService) },
  });

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
    contextVariableReader: contextVariableService,
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
    workspaceInvalidationPublisher: realtimePublisherComposition.publisher,
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
    realtimePublisherComposition.publisher,
  );
  // Per-message facet extraction (topic census). This same durable worker serves
  // the local poll loop, task recovery, and an operator-requested Pulse refresh.
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
  const facetExtractionWorkspaceDrain = new FacetExtractionWorkspaceDrainService(
    repositories.facetExtractionJobRepository,
    createDefaultFacetExtractionDrainDispatcher(env, logger),
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
    facetDrain: facetExtractionWorkspaceDrain,
  });
  const copilotProposalAdapters = [
    createDirectiveCopilotProposalAdapter({ authoredDirectiveService, directiveAuthorService, agentService }),
    createAgentSettingCopilotProposalAdapter({ agentService }),
    createRoutineCopilotProposalAdapter({ agentService, routineDraftAssistService, routineDefinitionService, logger }),
    createAgentSkillCopilotProposalAdapter({ agentService, agentSkillsService, skillCapabilityRegistry }),
    createContextVariableCopilotProposalAdapter({ contextVariables: contextVariableService }),
    createDocumentCopilotProposalAdapter({
      documentAuthoring: createCopilotDocumentAuthoringPort(documents.documentIngestionService),
      documentDeletion: documents.documentDeletionService,
      workspaceAccount: createCopilotWorkspaceAccountResolver({ workspaceRepository: repositories.workspaceRepository }),
    }),
    createIngestionSettingsCopilotProposalAdapter({ ingestionSettings: settings.ingestionSettingsService }),
    createWebsiteCrawlCopilotProposalAdapter({
      websiteCrawl: { assertCrawlUrlAllowed: assertPublicWebsiteUrl, normalizeCrawlUrl: normalizeBaseUrl, enqueue: documents.websiteCrawlJobService.enqueue.bind(documents.websiteCrawlJobService) },
      workspaceAccount: createCopilotWorkspaceAccountResolver({ workspaceRepository: repositories.workspaceRepository }),
      crawlPolicy: () => {
        const config = resolveWebsiteCrawlerConfig();
        return { enabled: env.WEBSITE_CRAWLER_ENABLED, defaultLimit: config.defaultLimit, maxLimit: config.maxLimit };
      },
    }),
  ] as const;
  const retrievalProbeService = new RetrievalProbeService({
    retrievalSearch: retrieval.retrievalSearchService,
    abuseControl: chat.abuseControlService,
    audit: infrastructure.auditService,
    abusePolicy: {
      limit: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS,
    },
  });
  const agentTurnProbeService = new AgentTurnProbeService({
    conversationReader: new ProbeConversationReader(repositories.conversationRepository),
    agentReader: {
      findAgentForProbe: (agentId, workspaceId) => agentService.resolve(workspaceId, agentId),
    },
    routineReader: new ProbeRoutineReader(routineDefinitionService),
    abuseControl: chat.abuseControlService,
    audit: infrastructure.auditService,
    abusePolicy: {
      limit: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS,
    },
    turnRunner: {
      run: async (turnInput) => {
        const receipt = await chat.chatService.answerWithReceipt({
          ...turnInput,
          stream: false,
          executionMode: "safe_test",
        });
        return {
          conversationId: receipt.response.conversationId,
          userMessageId: receipt.userMessageId,
          assistantMessageId: receipt.response.assistantMessageId,
          agentId: receipt.response.agentId ?? turnInput.agentId,
          answer: receipt.response.answer,
          citations: receipt.response.citations ?? [],
          skillOutcome: receipt.response.skillOutcome,
          answerOutcome: receipt.response.answerOutcome,
          activitySummary: receipt.response.activitySummary,
          activityTrace: receipt.response.activityTrace,
          turnTrace: receipt.response.turnTrace,
        };
      },
    },
  });
  const evalCaseCaptureService = new EvalCaseCaptureService({
    messageCases: evalMessageCaseService,
    audit: infrastructure.auditService,
  });
  const evalSuiteProbeService = new EvalSuiteProbeService({
    suite: evalSuiteService,
    abuseControl: chat.abuseControlService,
    audit: infrastructure.auditService,
    abusePolicy: {
      limit: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS,
    },
  });
  const copilotReplayEvidenceRepository = new CopilotReplayEvidenceRepository(infrastructure.database.kysely);
  const copilotAgentVersion = { get: (workspaceId: string, agentId: string) => agentService.get(workspaceId, agentId) };
  // Shared by the replay service (dates a run's baseline) and proposal-evidence resolution (reads
  // an agent_skill proposal's captured baseline skill config) — both need the case's frozen
  // snapshot, never the live agent.
  const copilotEvalCaseReader = {
    findCase: (workspaceId: string, caseId: string) => evalCaseService.findCaseWithSourceAgent(workspaceId, caseId),
  };
  // The live counterpart copilotEvalCaseReader's captured snapshot is compared against: an
  // agent_skill proposal's evidence is stale when this drifts from what a cited case captured.
  // A skill edit persists through agent_skills, a table agents.updated_at never reflects, so this
  // reads the skill directly rather than leaning on copilotAgentVersion.
  const copilotAgentSkillConfig = {
    getDefaultAnswerSkill: async (workspaceId: string, agentId: string) => {
      const skill = await agentSkillRepository.findDefaultAnswer(workspaceId, agentId);
      return skill ? { enabled: skill.enabled, config: skill.config ?? {} } : null;
    },
  };
  // Directive removal evidence needs a directive's real id and content from the live agent, never
  // from a model-supplied replay override, so this reads through the same resolver the agent's
  // own config serialization uses rather than trusting anything the copilot sends.
  const copilotAgentDirectives = {
    listDirectives: async (workspaceId: string, agentId: string) => {
      const agent = await agentService.resolve(workspaceId, agentId);
      // The port takes an opaque record — Ray's replay tool schema does too — so the widening from
      // the agents module's typed config to that shape belongs at this composition boundary.
      return serializeAuthoredDirectivesWithIds(agent).map((directive) => ({
        id: directive.id,
        config: directive.config as unknown as Record<string, unknown>,
      }));
    },
  };
  const evalCaseReplayService = new EvalCaseReplayService({
    cases: copilotEvalCaseReader,
    evidence: copilotReplayEvidenceRepository,
    agentDirectives: copilotAgentDirectives,
    runs: {
      // Ray offers a narrowed, behavior-only view of the eval override set, so widening it back to
      // the module's own type belongs here — the same widening the eval route performs on a
      // validated request body.
      execute: (input) => evalRunService.execute({
        ...input,
        overrides: input.overrides as EvalRunOverrides | undefined,
      }),
    },
    abuseControl: chat.abuseControlService,
    audit: infrastructure.auditService,
    abusePolicy: {
      limit: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: env.EXPENSIVE_AUTHENTICATED_RATE_LIMIT_WINDOW_MS,
    },
  });
  const copilotWorkspaceRouteKeyResolver = createCopilotWorkspaceRouteKeyResolver({ workspaceRepository: repositories.workspaceRepository });
  // One embedding-profiles-owned read port is shared by REST and Ray; neither surface reaches
  // into the job repository through an ad-hoc query shape.
  const embeddingCoverageReport: EmbeddingCoverageReadPort = repositories.documentProcessingJobRepository;
  const copilotCapabilityRunner = new AgenticCapabilityRunner({ runtime: new DefaultAgentRuntime({ gateway: llmRegistry.createToolCallingGateway(infrastructure.usageEventRecorder) }) });
  const copilotPrompt = loadPromptTemplate("copilot/system.md");
  // Named rather than inlined so the copilot's behavioural eval suite can drive a real turn through
  // the same catalog, prompt, and runner the dashboard uses. A suite that assembled its own would
  // measure a copilot nobody talks to.
  // Resolved here rather than at registration time so a contributing module receives the same
  // constructed infrastructure every other application-module provider does.
  const copilotToolContributions = composition.copilotToolRegistrations.map((registration) =>
    typeof registration === "function"
      ? registration({ database: infrastructure.database, logger, auditService: infrastructure.auditService })
      : registration);
  const copilotToolCatalog = createCopilotToolCatalog({
    toolContributions: copilotToolContributions,
    agentService: {
      get: agentService.get.bind(agentService),
      listExisting: agentService.listExisting.bind(agentService),
      resolve: agentService.resolve.bind(agentService),
    },
    routineDefinitionService: {
      get: routineDefinitionService.get.bind(routineDefinitionService),
      list: routineDefinitionService.list.bind(routineDefinitionService),
      validate: routineDefinitionService.validate.bind(routineDefinitionService),
    },
    chatHistoryService: chat.chatHistoryService,
    agentTurnProbe: agentTurnProbeService,
    documentSearchService: retrieval.documentSearchService,
    documentChunks: repositories.chunkRepository,
    documentMaintenance: {
      reprocessDocument: documents.documentIngestionService.reprocessEligible.bind(documents.documentIngestionService),
      reprocessSource: (input) => documents.documentSourceReprocessService.reprocessSource(input),
      recrawlSource: documents.documentSourceRecrawlService.recrawlSource.bind(documents.documentSourceRecrawlService),
    },
    evalResultsService: evalCaseService,
    pendingApprovals: chat.approvalDecisionService,
    evalCaseCapture: evalCaseCaptureService,
    evalSuiteProbe: evalSuiteProbeService,
    evalCaseReplay: evalCaseReplayService,
    retrievalProbe: retrievalProbeService,
    proposalEvidence: {
      evidence: copilotReplayEvidenceRepository,
      agentVersion: copilotAgentVersion,
      agentSkillConfig: copilotAgentSkillConfig,
      cases: copilotEvalCaseReader,
    },
    qualitySignalsService,
    audiencePulseService,
    documentStatusService: documents.documentIngestionService,
    documentSourceStatusService: documents.documentIngestionService,
    agentSkillsService,
    skillCapabilityRegistry,
    contextVariables: contextVariableService,
    workspaceRouteKeyResolver: copilotWorkspaceRouteKeyResolver,
    workspaceSettings: {
      async getRetrievalDefaults(workspaceId) {
        return retrievalDefaultsProvider.getDefaults(workspaceId);
      },
      async getIngestionSettings(workspaceId) {
        return settings.ingestionSettingsService.getForWorkspace(workspaceId);
      },
      async getEmbeddingCoverage(workspaceId) {
        return embeddingCoverageReport.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);
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
    logger,
  });
  const operatorCopilotService = new OperatorCopilotService({
    repository: repositories.copilotRepository,
    capabilityRunner: copilotCapabilityRunner,
    usageLimitPolicy: infrastructure.usageLimitPolicy,
    auditService: infrastructure.auditService,
    workspaceRouteKeyResolver: copilotWorkspaceRouteKeyResolver,
    proposalAdapters: copilotProposalAdapters,
    prompt: copilotPrompt,
    tools: copilotToolCatalog,
    probeBudgetPerTurn: env.COPILOT_PROBE_BUDGET_PER_TURN,
    currentAuthorization: {
      hasAllPermissions: ({ workspaceId, accountId, operatorUserId, requiredPermissions }) =>
        access.accountAccessService.hasAllWorkspacePermissions({
          accountId,
          userId: operatorUserId,
          principal: { type: "session_user", userId: operatorUserId },
          workspaceId,
          permissions: requiredPermissions,
        }),
    },
  });
  // Retention runs in the worker process: it is periodic maintenance with no request behind it,
  // and the HTTP process must not do it once per replica.
  const copilotRetentionWorker = new CopilotRetentionWorker({
    retention: repositories.copilotRepository,
    audit: infrastructure.auditService,
    logger,
    retentionDays: env.COPILOT_CONVERSATION_RETENTION_DAYS,
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
    workspaceInvalidationPublisher: realtimePublisherComposition.publisher,
    realtimePublisherLifecycle: realtimePublisherComposition,
    realtimeRolloutPolicy,
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
    documentTypeCatalogService: settings.documentTypeCatalogService,
    metadataFieldSuggestionProvider,
    metadataRuleFieldReferenceProvider,
    // Coverage counts share the job repository's definition of a projected chunk,
    // because the number is read against the backlog that repository enqueues.
    embeddingCoverageReport,
    chunkRepository: repositories.chunkRepository,
    documentRepository: repositories.documentRepository,
    documentIngestionService: documents.documentIngestionService,
    documentSourceRepository: repositories.documentSourceRepository,
    documentImportService: documents.documentImportService,
    documentSearchService: retrieval.documentSearchService,
    documentSearchHistoryService: documents.documentSearchHistoryService,
    workspaceIngestionReprocessService: documents.workspaceIngestionReprocessService,
    embeddingBindingResolver,
    documentSourceRecrawlService: documents.documentSourceRecrawlService,
    documentSourceReprocessService: documents.documentSourceReprocessService,
    documentProcessingWorker: documents.documentProcessingWorker,
    documentJobConsumer: documents.documentJobConsumer,
    facetExtractionWorker,
    facetExtractionWorkspaceDrain,
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
    contextVariableService,
    contextVariableResolutionReader: chat.contextVariableResolutionReader,
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
    copilotRetentionWorker,
    copilotToolCatalog,
    copilotCapabilityRunner,
    copilotPrompt,
    copilotWorkspaceRouteKeyResolver,
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
