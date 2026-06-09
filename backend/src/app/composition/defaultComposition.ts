import type { Env } from "../config/env.js";
import { registerBuiltInConnectors } from "../../modules/connectors/plugins/index.js";
import { ConnectorRegistry } from "../../modules/connectors/services/connectorRegistry.js";
import {
  AmqpDocumentJobConsumer,
  AmqpDocumentJobDispatcher,
  CloudTasksDocumentJobDispatcher,
  GcsDocumentStorage,
  LocalDocumentStorage,
  NoopDocumentJobDispatcher,
  type DocumentJobDispatcherPort,
  type DocumentProcessingWorker,
  type DocumentStoragePort,
} from "../../modules/documents/composition.js";
import {
  ChonkieChunkingProvider,
  ChunkingStrategyRegistry,
  FixedWindowChunkingStrategy,
  RecursiveTextChunkingStrategy,
  StructuredSemanticChunkingStrategy,
  type EmbeddingService,
  type TextChunkingProviderPort,
} from "../../modules/retrieval/composition.js";
import { buildAnalyticsSinks } from "../../shared/analytics/buildAnalyticsSinks.js";
import type { ProductAnalyticsSink } from "../../shared/analytics/productAnalyticsSink.js";
import { buildErrorSinks } from "../../shared/errors/buildErrorSinks.js";
import type { ErrorSink } from "../../shared/errors/errorSink.js";
import type { AuditService } from "../../modules/audit/contracts/index.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { buildTelemetrySinks, type TelemetrySinkBundle } from "../../shared/observability/telemetry/buildTelemetrySinks.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { JobConsumerPort } from "../../shared/domain/jobConsumer.js";
import { DefaultAllowCapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import { StaticActionCapabilityMap, type ActionCapabilityMap } from "../../shared/domain/actionCapabilities.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import { DefaultTurnSelectionStrategy, type TurnSelectionStrategy } from "../../modules/chat/composition.js";
import type { DirectiveMatcherPort } from "../../modules/directives/public.js";
import type { DirectiveMatchGatewayFactory } from "../../shared/infra/llm/contextualGateways.js";
import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
  type ApplicationDirectiveRegistration,
  type ApplicationModule,
} from "./applicationModule.js";
import { createAnswerFeedbackApplicationModule } from "./builtIn/answerFeedbackModule.js";
import { createWebsiteEmbedApplicationModule } from "./builtIn/websiteEmbedModule.js";
import { createAgentWizardApplicationModule } from "./builtIn/agentWizardModule.js";
import { createQualityApplicationModule } from "./builtIn/qualityModule.js";
import { createUsageReportingApplicationModule } from "./builtIn/usageReportingModule.js";
import { createAnswerDirectivesApplicationModule } from "./builtIn/answerDirectivesModule.js";
import { createContactRoutineApplicationModule } from "./builtIn/contactRoutineModule.js";
import {
  createDefaultSkillCatalogRegistry,
  SkillExecutorRegistry,
  type SkillCatalogEntryDefinition,
  type SkillCatalogRegistry,
} from "../../modules/skills/composition.js";
import {
  AmqpWebsiteCrawlJobConsumer,
  AmqpWebsiteCrawlJobDispatcher,
  CloudTasksWebsiteCrawlJobDispatcher,
} from "../../modules/websiteCrawler/jobQueue.js";
import {
  NoopWebsiteCrawlJobDispatcher,
  type WebsiteCrawlJobDispatcherPort,
} from "../../modules/websiteCrawler/jobDispatcher.js";

export interface ApplicationComposition {
  capabilityPolicy: CapabilityPolicy;
  actionCapabilityMap: ActionCapabilityMap;
  connectors: ReturnType<typeof createApplicationExtensionRegistry>["connectors"];
  telemetrySinks: ReturnType<typeof createApplicationExtensionRegistry>["telemetrySinks"];
  productAnalyticsSinks: ReturnType<typeof createApplicationExtensionRegistry>["productAnalyticsSinks"];
  errorSinks: ReturnType<typeof createApplicationExtensionRegistry>["errorSinks"];
  routeMounts: ReturnType<typeof createApplicationExtensionRegistry>["routeMounts"];
  accountCreatedHooks: ReturnType<typeof createApplicationExtensionRegistry>["accountCreatedHooks"];
  documentStorage?: ReturnType<typeof createApplicationExtensionRegistry>["documentStorage"];
  documentJobDispatcher?: ReturnType<typeof createApplicationExtensionRegistry>["documentJobDispatcher"];
  documentJobConsumer?: ReturnType<typeof createApplicationExtensionRegistry>["documentJobConsumer"];
  websiteCrawlerProvider?: ReturnType<typeof createApplicationExtensionRegistry>["websiteCrawlerProvider"];
  chunkingProvider?: ReturnType<typeof createApplicationExtensionRegistry>["chunkingProvider"];
  websiteEmbedIntegration?: ReturnType<typeof createApplicationExtensionRegistry>["websiteEmbedIntegration"];
  usageLimitPolicyRegistration?: ReturnType<typeof createApplicationExtensionRegistry>["usageLimitPolicyRegistration"];
  organizationCreationGuardRegistration?: ReturnType<typeof createApplicationExtensionRegistry>["organizationCreationGuardRegistration"];
  usageEventRecorderRegistration?: ReturnType<typeof createApplicationExtensionRegistry>["usageEventRecorderRegistration"];
  publicChatActionAdvertiserRegistrations: ReturnType<typeof createApplicationExtensionRegistry>["publicChatActionAdvertiserRegistrations"];
  routineRegistrations: ReturnType<typeof createApplicationExtensionRegistry>["routineRegistrations"];
  publishedRoutineRegistrationSource: ReturnType<typeof createApplicationExtensionRegistry>["publishedRoutineRegistrationSource"];
  actionHandlerRegistrations: ReturnType<typeof createApplicationExtensionRegistry>["actionHandlerRegistrations"];
  contactHistoryProviderRegistration?: ReturnType<typeof createApplicationExtensionRegistry>["contactHistoryProviderRegistration"];
  answerFeedbackHistoryProviderRegistration?: ReturnType<typeof createApplicationExtensionRegistry>["answerFeedbackHistoryProviderRegistration"];
  agentSurfaceExtensions: ReturnType<typeof createApplicationExtensionRegistry>["agentSurfaceExtensions"];
  directiveRegistrations: ApplicationDirectiveRegistration[];
  selectionStrategy: TurnSelectionStrategy;
  directiveMatcher?: DirectiveMatcherPort;
  directiveMatchGatewayFactory?: DirectiveMatchGatewayFactory;
  skillCatalogRegistry: SkillCatalogRegistry<SkillCatalogEntryDefinition>;
  skillExecutorRegistry: SkillExecutorRegistry;
  chatActionSuggestionProviders: ReturnType<typeof createApplicationExtensionRegistry>["chatActionSuggestionProviders"];
  lifecycle: ApplicationModuleCoordinator;
  modules: ApplicationModule[];
}

export const createDefaultApplicationComposition = (options: {
  logger: Pick<AppLogger, "error">;
  modules?: ApplicationModule[];
  widgetOrigin?: string;
}): ApplicationComposition => {
  const registry = createApplicationExtensionRegistry();
  const coordinator = new ApplicationModuleCoordinator({
    logger: options.logger,
    registry,
  });
  // Built-in OSS modules first; user-supplied modules can override their
  // registrations (e.g. a custom website-embed integration provider).
  coordinator.apply([
    createAnswerDirectivesApplicationModule(),
    createAnswerFeedbackApplicationModule(),
    createWebsiteEmbedApplicationModule({ widgetOrigin: options.widgetOrigin }),
    createAgentWizardApplicationModule(),
    createUsageReportingApplicationModule(),
    createQualityApplicationModule(),
    createContactRoutineApplicationModule(),
    ...(options.modules ?? []),
  ]);

  return {
    capabilityPolicy: registry.capabilityPolicy ?? new DefaultAllowCapabilityPolicy(),
    actionCapabilityMap: new StaticActionCapabilityMap(registry.actionHandlerRegistrations),
    connectors: registry.connectors,
    telemetrySinks: registry.telemetrySinks,
    productAnalyticsSinks: registry.productAnalyticsSinks,
    errorSinks: registry.errorSinks,
    routeMounts: registry.routeMounts,
    documentStorage: registry.documentStorage,
    accountCreatedHooks: registry.accountCreatedHooks,
    documentJobDispatcher: registry.documentJobDispatcher,
    documentJobConsumer: registry.documentJobConsumer,
    websiteCrawlerProvider: registry.websiteCrawlerProvider,
    chunkingProvider: registry.chunkingProvider,
    websiteEmbedIntegration: registry.websiteEmbedIntegration,
    usageLimitPolicyRegistration: registry.usageLimitPolicyRegistration,
    organizationCreationGuardRegistration: registry.organizationCreationGuardRegistration,
    usageEventRecorderRegistration: registry.usageEventRecorderRegistration,
    publicChatActionAdvertiserRegistrations: registry.publicChatActionAdvertiserRegistrations,
    routineRegistrations: registry.routineRegistrations,
    publishedRoutineRegistrationSource: registry.publishedRoutineRegistrationSource,
    actionHandlerRegistrations: registry.actionHandlerRegistrations,
    contactHistoryProviderRegistration: registry.contactHistoryProviderRegistration,
    answerFeedbackHistoryProviderRegistration: registry.answerFeedbackHistoryProviderRegistration,
    agentSurfaceExtensions: registry.agentSurfaceExtensions,
    directiveRegistrations: registry.directiveRegistrations,
    selectionStrategy: registry.selectionStrategy ?? new DefaultTurnSelectionStrategy(),
    directiveMatcher: registry.directiveMatcher,
    directiveMatchGatewayFactory: registry.directiveMatchGatewayFactory,
    skillCatalogRegistry: createDefaultSkillCatalogRegistry([
      ...registry.skillCatalogEntries,
      ...registry.skillDefinitions,
    ]),
    skillExecutorRegistry: new SkillExecutorRegistry(registry.skillExecutors),
    chatActionSuggestionProviders: registry.chatActionSuggestionProviders,
    lifecycle: coordinator,
    modules: coordinator.registeredModules,
  };
};

export const createDefaultConnectorRegistry = (connectors: ApplicationComposition["connectors"] = []): ConnectorRegistry => {
  const registry = new ConnectorRegistry();
  registerBuiltInConnectors(registry);
  for (const connector of connectors) {
    registry.register(connector);
  }
  return registry;
};

export const createDefaultTelemetrySinks = (env: Pick<Env, "METRICS_ENABLED">): TelemetrySinkBundle =>
  buildTelemetrySinks(env);

export const createDefaultAnalyticsSinks = (input: {
  auditService: AuditService;
  env: Pick<Env, "PRODUCT_ANALYTICS_SINKS">;
  metricsRegistry: MetricsRegistry | null;
}): ProductAnalyticsSink[] => buildAnalyticsSinks(input);

export const createDefaultErrorSinks = (input: {
  auditService: AuditService;
  env: Pick<Env, "ERROR_SINKS">;
  metricsRegistry: MetricsRegistry | null;
}): ErrorSink[] => buildErrorSinks(input);

export const createDefaultDocumentStorage = (env: Pick<Env,
  "DOCUMENT_STORAGE_DRIVER" | "DOCUMENT_STORAGE_BUCKET" | "DOCUMENT_STORAGE_LOCAL_PATH"
>): DocumentStoragePort =>
  env.DOCUMENT_STORAGE_DRIVER === "gcs"
    ? new GcsDocumentStorage(env.DOCUMENT_STORAGE_BUCKET!)
    : new LocalDocumentStorage(env.DOCUMENT_STORAGE_LOCAL_PATH);

export const createDefaultDocumentJobDispatcher = (
  env: Pick<Env,
    | "WORKER_DISPATCH_DRIVER"
    | "GOOGLE_CLOUD_PROJECT"
    | "WORKER_TASKS_QUEUE_LOCATION"
    | "WORKER_TASKS_QUEUE_NAME"
    | "WORKER_TASKS_SERVICE_URL"
    | "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"
    | "WORKER_AMQP_URL"
    | "WORKER_AMQP_QUEUE_NAME"
    | "WORKER_AMQP_DLQ_NAME"
    | "WORKER_AMQP_PREFETCH"
  >,
  logger: AppLogger,
): DocumentJobDispatcherPort =>
  env.WORKER_DISPATCH_DRIVER === "cloud-tasks"
    ? new CloudTasksDocumentJobDispatcher({
        projectId: env.GOOGLE_CLOUD_PROJECT!,
        location: env.WORKER_TASKS_QUEUE_LOCATION!,
        queueName: env.WORKER_TASKS_QUEUE_NAME!,
        workerServiceUrl: env.WORKER_TASKS_SERVICE_URL!,
        invokerServiceAccountEmail: env.WORKER_TASKS_INVOKER_SERVICE_ACCOUNT!,
        logger,
      })
    : env.WORKER_DISPATCH_DRIVER === "amqp"
      ? new AmqpDocumentJobDispatcher({
          amqpUrl: env.WORKER_AMQP_URL!,
          queueName: env.WORKER_AMQP_QUEUE_NAME!,
          deadLetterQueueName: env.WORKER_AMQP_DLQ_NAME,
          logger,
        })
    : new NoopDocumentJobDispatcher();

export const createDefaultDocumentJobConsumer = (
  env: Pick<Env,
    | "WORKER_DISPATCH_DRIVER"
    | "WORKER_AMQP_URL"
    | "WORKER_AMQP_QUEUE_NAME"
    | "WORKER_AMQP_DLQ_NAME"
    | "WORKER_AMQP_PREFETCH"
  >,
  logger: AppLogger,
  worker: Pick<DocumentProcessingWorker, "runJobById">,
): JobConsumerPort | undefined =>
  env.WORKER_DISPATCH_DRIVER === "amqp"
    ? new AmqpDocumentJobConsumer({
        amqpUrl: env.WORKER_AMQP_URL!,
        queueName: env.WORKER_AMQP_QUEUE_NAME!,
        deadLetterQueueName: env.WORKER_AMQP_DLQ_NAME,
        prefetch: env.WORKER_AMQP_PREFETCH,
        logger,
        worker,
      })
    : undefined;

export const createDefaultWebsiteCrawlJobDispatcher = (
  env: Pick<Env,
    | "WORKER_DISPATCH_DRIVER"
    | "GOOGLE_CLOUD_PROJECT"
    | "WORKER_TASKS_QUEUE_LOCATION"
    | "WORKER_TASKS_QUEUE_NAME"
    | "WORKER_TASKS_CRAWL_QUEUE_NAME"
    | "WORKER_TASKS_SERVICE_URL"
    | "WORKER_TASKS_CRAWL_SERVICE_URL"
    | "WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"
    | "WORKER_AMQP_URL"
    | "WORKER_AMQP_QUEUE_NAME"
    | "WORKER_AMQP_CRAWL_QUEUE_NAME"
    | "WORKER_AMQP_DLQ_NAME"
    | "WORKER_AMQP_CRAWL_DLQ_NAME"
  >,
  logger: AppLogger,
): WebsiteCrawlJobDispatcherPort =>
  env.WORKER_DISPATCH_DRIVER === "cloud-tasks"
    ? new CloudTasksWebsiteCrawlJobDispatcher({
        projectId: env.GOOGLE_CLOUD_PROJECT!,
        location: env.WORKER_TASKS_QUEUE_LOCATION!,
        queueName: env.WORKER_TASKS_CRAWL_QUEUE_NAME ?? env.WORKER_TASKS_QUEUE_NAME!,
        workerServiceUrl: env.WORKER_TASKS_CRAWL_SERVICE_URL ?? env.WORKER_TASKS_SERVICE_URL!,
        invokerServiceAccountEmail: env.WORKER_TASKS_INVOKER_SERVICE_ACCOUNT!,
        logger,
      })
    : env.WORKER_DISPATCH_DRIVER === "amqp"
      ? new AmqpWebsiteCrawlJobDispatcher({
          amqpUrl: env.WORKER_AMQP_URL!,
          queueName: env.WORKER_AMQP_CRAWL_QUEUE_NAME ?? env.WORKER_AMQP_QUEUE_NAME!,
          deadLetterQueueName: env.WORKER_AMQP_CRAWL_DLQ_NAME ?? env.WORKER_AMQP_DLQ_NAME,
          logger,
        })
      : new NoopWebsiteCrawlJobDispatcher();

export const createDefaultWebsiteCrawlJobConsumer = (
  env: Pick<Env,
    | "WORKER_DISPATCH_DRIVER"
    | "WORKER_AMQP_URL"
    | "WORKER_AMQP_CRAWL_QUEUE_NAME"
    | "WORKER_AMQP_QUEUE_NAME"
    | "WORKER_AMQP_CRAWL_DLQ_NAME"
    | "WORKER_AMQP_DLQ_NAME"
  >,
  logger: AppLogger,
  worker: { runJobById(jobId: string): Promise<"processed" | "noop" | "busy"> },
): JobConsumerPort | undefined =>
  env.WORKER_DISPATCH_DRIVER === "amqp"
    ? new AmqpWebsiteCrawlJobConsumer({
        amqpUrl: env.WORKER_AMQP_URL!,
        queueName: env.WORKER_AMQP_CRAWL_QUEUE_NAME ?? env.WORKER_AMQP_QUEUE_NAME!,
        deadLetterQueueName: env.WORKER_AMQP_CRAWL_DLQ_NAME ?? env.WORKER_AMQP_DLQ_NAME,
        logger,
        worker,
      })
    : undefined;

export const createDefaultChunkingStrategyRegistry = (
  embeddingService: EmbeddingService,
  chunkingProvider: TextChunkingProviderPort = new ChonkieChunkingProvider(embeddingService),
): ChunkingStrategyRegistry =>
  new ChunkingStrategyRegistry([
    new FixedWindowChunkingStrategy(chunkingProvider),
    new StructuredSemanticChunkingStrategy(chunkingProvider),
    new RecursiveTextChunkingStrategy(chunkingProvider),
  ]);
