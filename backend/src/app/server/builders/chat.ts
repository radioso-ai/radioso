import { ActionRequestRepository } from "../../../db/repositories/actionRequestRepository.js";
import { ContextVariableRepository } from "../../../db/repositories/contextVariableRepository.js";
import { RoutineDefinitionRepository } from "../../../db/repositories/routineDefinitionRepository.js";
import { RoutineStateRepository } from "../../../db/repositories/routineStateRepository.js";
import { DirectiveStateRepository } from "../../../db/repositories/directiveStateRepository.js";
import { ConversationSummaryRepository } from "../../../db/repositories/conversationSummaryRepository.js";
import { ConversationSummaryService, ModelConversationSummaryGenerator } from "../../../modules/chat/composition.js";
import { PendingDecisionRepository } from "../../../db/repositories/pendingDecisionRepository.js";
import { ClarificationStateRepository } from "../../../db/repositories/clarificationStateRepository.js";
import { createConversationEngine } from "@radioso/conversation-engine";
import { AuditEventRepository } from "../../../db/repositories/auditEventRepository.js";
import { BootstrapGreetingCacheRepository } from "../../../db/repositories/bootstrapGreetingCacheRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { HistoryItemsRepository } from "../../../db/repositories/historyItemsRepository.js";
import { MessageRepository } from "../../../db/repositories/messageRepository.js";
import { WorkspaceRepository } from "../../../db/repositories/workspaceRepository.js";
import { LlmResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import { LlmHandoffWaitingMessageGenerator } from "../../../shared/services/handoffWaitingMessageGenerator.js";
import { PostgresAssistantTurnPersistence } from "../../../modules/chat/infra/postgresAssistantTurnPersistence.js";
import { AccountAccessService } from "../../../modules/account/public.js";
import { AgentService } from "../../../modules/agents/public.js";
import { AuditService } from "../../../modules/audit/composition.js";
import { ApprovalDecisionService } from "../../../modules/approvals/public.js";
import {
  ActionDispatcher,
  ActionDispatchWorker,
  ActionHandlerRegistry,
  DrainTriggeringActionOutbox,
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
import { type ApplicationComposition } from "../../composition/index.js";
import { createDefaultActionDrainDispatcher } from "../../composition/defaultComposition.js";
import { DocumentSourceContentService, AgentConverseResourceService } from "../../../modules/documents/composition.js";
import {
  ModelSenseLabelGateway,
  PostgresSenseEmbeddingReader,
  RetrievalAnswerService,
  SenseGroupingService,
  AgentConverseGroundedAnswerService,
  type RetrievalSensePolicy,
  type RetrievalPipelinePort,
} from "../../../modules/retrieval/composition.js";
import type { ClusteringEmbeddingPort } from "../../../modules/embeddingProfiles/contracts/embeddingConsumers.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { AbuseControlRepository } from "../../../db/repositories/abuseControlRepository.js";
import { AbuseControlService } from "../../../modules/security/services/abuseControlService.js";
import { CustomerEmailConnectionRepository } from "../../../db/repositories/customerEmailConnectionRepository.js";
import { EmailSkillDefinitionRepository } from "../../../db/repositories/emailSkillDefinitionRepository.js";
import { EmailSkillActivityRepository } from "../../../db/repositories/emailSkillActivityRepository.js";
import { WebhookSkillDefinitionRepository } from "../../../db/repositories/webhookSkillDefinitionRepository.js";
import { OauthConnectionRepository } from "../../../db/repositories/oauthConnectionRepository.js";
import { FetchWebhookHttpClient, type WebhookDestinationRuntimePort } from "../../../modules/webhooks/public.js";
import type { LlmCapabilityResolver } from "../../../shared/infra/llm/capabilityResolver.js";
import { IngestionSettingsService, AgentConverseSessionService } from "../../../modules/settings/composition.js";
import { retrievalAnswerSkillDefinition, type RoutineInvocableSkillNames } from "../../../modules/skills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER, RetrievalAnswerSkillExecutor } from "../../../modules/retrieval/public.js";
import {
  EXTERNAL_SKILLS_ADAPTER,
  McpSkillExecutor,
} from "../../../modules/externalSkills/executor/mcpSkillExecutor.js";
import { buildExternalSkillsDeps } from "../../../modules/externalSkills/composition.js";
import {
  CUSTOMER_EMAIL_SKILLS_ADAPTER,
  CustomerEmailDeliveryService,
  EmailSkillExecutor,
  MockCustomerEmailProviderAdapter,
  StaticCustomerEmailProviderRegistry,
  customerEmailOauthProviderIds,
} from "../../../modules/customerEmail/public.js";
import { WEBHOOK_SKILLS_ADAPTER, WebhookSkillExecutor } from "../../../modules/webhookSkills/public.js";
import {
  SLACK_SKILLS_ADAPTER,
  SlackEscalationExecutor,
  SlackSkillDefinitionRepository,
} from "../../../modules/slackSkills/public.js";
import { NotifyExecutor, NOTIFY_SKILLS_ADAPTER } from "../../../modules/notify/notifyExecutor.js";
import { createRoutineTurnProvider, type RoutineTriggerEmbeddingService } from "../../../modules/routines/public.js";
import type { FacetExtractionJobStore } from "../../../modules/facets/contracts.js";
import type { RetrievalDefaultsProvider, SkillSettingsResolver } from "../../../modules/retrieval/public.js";
import { ProductAnalyticsService } from "../../../shared/analytics/productAnalyticsService.js";
import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import { Database } from "../../../shared/infra/database.js";
import { LlmProviderRegistry } from "../../../shared/infra/llm/providerRegistry.js";
import {
  ContextualDirectiveMatchGatewayFactory,
  ContextualTurnPlanGatewayFactory,
} from "../../../shared/infra/llm/contextualGateways.js";
import { TextGenerationClientCache } from "../../../shared/infra/llm/textClientFactory.js";
import { AgentSkillRepository } from "../../../modules/agentSkills/public.js";
import { ContextVariableResolverService } from "../../../modules/context-variables/public.js";
import { SkillBackedContextResolver } from "../../composition/builtIn/contextResolverModule.js";
import { RepositoryAgentSkillTurnSkillProvider } from "../../composition/builtIn/agentSkillTurnSkillProvider.js";
import { type AppLogger } from "../../../shared/observability/logger.js";
import { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import { createPublishedRoutineRegistrationSource } from "../../composition/routineDefinitionSource.js";
import { ChatAnswerSupport, recordClarificationDecision } from "../../../modules/chat/composition.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { Env } from "../../config/env.js";
import type { McpConverseRouteDependencies, McpConverseRouteServices } from "../../http/routes/mcpConverseRoutes.js";
import type { ChatTurnPlanHandle } from "../../../modules/chat/services/turnPlanCoordinator.js";
import { buildInfrastructure } from "./infra.js";
import { RoutineChatModelGateway } from "../../../modules/chat/services/routines/routineChatModelGateway.js";
import type { WorkspaceEventBus } from "../../../shared/events/workspaceEventBus.js";
import {
  withActionRequestPushEvents,
  withPendingDecisionPushEvents,
} from "../../composition/workspacePushRepositoryDecorators.js";


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

export const buildChatServices = (input: {
  accountAccessService: AccountAccessService;
  agentService: AgentService;
  agentSkillRepository: AgentSkillRepository;
  auditEventRepository: AuditEventRepository;
  auditService: AuditService;
  bootstrapGreetingCacheRepository: BootstrapGreetingCacheRepository;
  composition: ApplicationComposition;
  conversationOwnershipRepository: ConversationOwnershipRepository;
  conversationRepository: ConversationRepository;
  clusteringEmbeddings: ClusteringEmbeddingPort;
  database: Database;
  env: Env;
  historyItemsRepository: HistoryItemsRepository;
  llmRegistry: LlmProviderRegistry;
  llmCapabilityResolver: LlmCapabilityResolver;
  logger: AppLogger;
  messageRepository: MessageRepository;
  /** Optional: when wired, an eligible visitor message enqueues a facet extraction job (spec 956). */
  facetExtractionJobs?: Pick<FacetExtractionJobStore, "enqueue">;
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
  routineInvocableSkillNames: RoutineInvocableSkillNames;
  mailService: ReturnType<typeof buildInfrastructure>["mailService"];
  publicConversationEventBus: PublicConversationEventBus;
  workspaceEventBus: WorkspaceEventBus;
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
  const answerPresentationService = new AnswerPresentationService(input.metricsRegistry);
  const answerPresentation = {
    normalize: answerPresentationService.normalize.bind(answerPresentationService),
    present: answerPresentationService.present.bind(answerPresentationService),
  };
  const abuseControlService = new AbuseControlService(new AbuseControlRepository(input.database.kysely));
  // Conversation-action outbox drain push (contact-outbox fix): every current
  // producer of `routine_action_requests` rows requests a drain once its enqueue is
  // durable. Cloud Tasks under WORKER_DISPATCH_DRIVER=cloud-tasks + a configured
  // queue name; otherwise a no-op, so local dev and any not-yet-provisioned prod
  // deploy keep relying on the interval-loop poller / recovery sweep unchanged.
  const actionDrainDispatcher = createDefaultActionDrainDispatcher(input.env, input.logger);
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
        outbox: new DrainTriggeringActionOutbox(
          new ActionRequestRepository(input.database.kysely),
          actionDrainDispatcher,
          input.logger,
        ),
      }),
    });
  }
  if (!input.composition.skillExecutorRegistry.resolve({ kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER })) {
    input.composition.skillExecutorRegistry.register({
      kind: "internal",
      adapter: NOTIFY_SKILLS_ADAPTER,
      executor: new NotifyExecutor({
        skills: new AgentSkillRepository(input.database.kysely),
        outbox: new DrainTriggeringActionOutbox(
          new ActionRequestRepository(input.database.kysely),
          actionDrainDispatcher,
          input.logger,
        ),
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
          workspaceEventBus: input.workspaceEventBus,
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
  const actionOutbox = withActionRequestPushEvents(
    new ActionRequestRepository(input.database.kysely),
    input.workspaceEventBus,
  );
  // The fallback (non-transactional) enqueue path — see `ChatTurnLifecycle`'s
  // `assistantTurnPersistence`-absent branch — also requests a drain once durable.
  const pushingActionOutbox = new DrainTriggeringActionOutbox(actionOutbox, actionDrainDispatcher, input.logger);
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
              errorReporter: input.errorReporter,
            })
          : registration.handler,
    })),
  );
  const actionDispatchWorker = new ActionDispatchWorker(
    new ActionDispatcher(actionOutbox, actionHandlerRegistry),
    {
      logger: input.logger,
      errorReporter: input.errorReporter,
      // Outbox depth / oldest-pending-age — the operator-alertable signal for a
      // stuck outbox (the failure mode this worker exists to catch). Reported on
      // every drain, not just activity transitions: see the staleness note on
      // `ActionDispatchWorkerOptions.depthSnapshot`.
      depthSnapshot: actionOutbox,
      telemetryService: input.telemetryService,
    },
  );
// Routine machinery (spec 070 / #520). The owning routines module loads the
  // per-turn catalog, applies capability gates, and assembles the runtime ports.
  const publishedRoutineSource = input.composition.publishedRoutineRegistrationSource ??
    createPublishedRoutineRegistrationSource(input.routineDefinitionRepository, {
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
        const skill = await input.agentSkillRepository.findByAgentAndName(definition.agentId, "completion_export");
        if (!skill) {
          return null;
        }
        if (skill.kind !== "webhook" || !skill.enabled || !skill.targetId) {
          return { enabled: false, triggerKinds: [], destinationRef: "" };
        }
        return {
          enabled: true,
          triggerKinds: definition.completionExport?.triggerKinds?.length
            ? definition.completionExport.triggerKinds
            : ["complete", "handoff"],
          destinationRef: skill.targetId,
        };
      },
    });
  const routineProvider: ChatRoutineProvider = createRoutineTurnProvider({
    agentSkillRepository: input.agentSkillRepository,
    capabilityPolicy: input.composition.capabilityPolicy,
    clusteringEmbeddings: input.clusteringEmbeddings,
    embeddingModelForWorkspace: async (workspaceId) =>
      (await input.ingestionSettingsService.getForWorkspace(workspaceId)).embeddingModel,
    logger: input.logger,
    metricsRegistry: input.metricsRegistry,
    publishedRoutineSource,
    routineDefinitionRepository: input.routineDefinitionRepository,
    routineInvocableSkillNames: input.routineInvocableSkillNames,
    routineRegistrations: input.composition.routineRegistrations,
    routineTriggerEmbeddingService: input.routineTriggerEmbeddingService,
    skillExecutorRegistry: input.composition.skillExecutorRegistry,
    turnPlanAdapters: {
      activator: ({ handle, registry, fallback }) =>
        planAwareRoutineActivator({
          handle: handle as ChatTurnPlanHandle | undefined,
          registry,
          fallback,
        }),
      slotCorrection: ({ handle, fallback }) =>
        planAwareRoutineSlotCorrection({
          handle: handle as ChatTurnPlanHandle | undefined,
          fallback,
        }),
      reentryGate: ({ handle, fallback }) =>
        planAwareRoutineReentryGate({
          handle: handle as ChatTurnPlanHandle | undefined,
          fallback,
        }),
    },
  });
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
    metricsRegistry: input.metricsRegistry,
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
    facetExtractionJobs: input.facetExtractionJobs,
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
    // dispatched out of band by `actionDispatchWorker` in the worker process. Only
    // exercised by the `assistantTurnPersistence`-absent fallback path (tests /
    // non-DB hosts) — production writes actions through `assistantTurnPersistence`
    // below instead, transactionally with the rest of the turn.
    actionOutbox: pushingActionOutbox,
    assistantTurnPersistence: new PostgresAssistantTurnPersistence(
      input.database.kysely,
      undefined,
      input.conversationOwnershipRepository,
      actionDrainDispatcher,
      input.logger,
      input.workspaceEventBus,
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
    metrics: input.metricsRegistry,
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
    withPendingDecisionPushEvents(new PendingDecisionRepository(input.database.kysely), input.workspaceEventBus),
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
