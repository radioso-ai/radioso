import type { Router } from "express";
import type { ConnectorPlugin } from "@radioso/connector-api";
import type { QueryResultRow } from "pg";

import type { ProductAnalyticsSink } from "../../shared/analytics/productAnalyticsSink.js";
import type { ErrorSink } from "../../shared/errors/errorSink.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import type { TelemetrySink } from "../../shared/observability/telemetry/telemetrySink.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type {
  DocumentJobDispatcherPort,
  DocumentStoragePort,
} from "../../modules/documents/contracts/index.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { Database } from "../../shared/infra/database.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { JobConsumerPort } from "../../shared/domain/jobConsumer.js";
import type { OrganizationCreationGuard } from "../../shared/domain/organizationCreationGuard.js";
import type { DocumentCapacityReadPort, UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type { ManagedModelPolicy } from "../../shared/domain/managedModelPolicy.js";
import type { UsageEventRecorder } from "../../shared/domain/usageEventRecorder.js";
import type { WebsiteEmbedIntegrationProvider } from "../../modules/settings/contracts/websiteEmbedIntegration.js";
import type { FacetExtractionPort } from "../../modules/facets/contracts.js";
import type {
  ChatGateway,
  PublicChatActionAdvertiserPort,
  ContactHistoryProviderPort,
} from "../../modules/chat/contracts/index.js";
import type {
  ActionHandler,
  AnswerFeedbackHistoryProviderPort,
  RoutineRegistration,
  TurnSelectionStrategy,
} from "../../modules/chat/composition.js";
import type { PublishedRoutineRegistrationSource } from "./routineDefinitionSource.js";
import type { DirectiveMatcherPort } from "../../modules/directives/public.js";
import type { DirectiveMatchGatewayFactory } from "../../shared/infra/llm/contextualGateways.js";
import type { AppDependencies } from "../server/types.js";
import type { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import type { AuditService } from "../../modules/audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type {
  SkillCatalogEntryDefinition,
  SkillDefinition,
  SkillExecutorRegistration,
  SkillExecutorRegistry,
} from "../../modules/skills/public.js";
import type { Directive } from "../../modules/directives/public.js";
import type { WebsiteCrawlerProvider } from "../../modules/websiteCrawler/provider.js";
import type { AgentService, AgentSurfaceExtension } from "../../modules/agents/public.js";
import type { TextChunkingProviderPort } from "../../modules/retrieval/public.js";
import type { ChatActionSuggestionProvider } from "../../modules/chat/contracts/index.js";
import type { WebhookDestinationRuntimePort } from "../../modules/webhooks/public.js";
import type { Env } from "../config/env.js";
import type { OauthProviderDefinition } from "../../modules/integrationOauth/public.js";
import type { CopilotToolContribution } from "../../modules/operatorCopilot/public.js";

type ApplicationChatActionSuggestionProviderRegistration =
  | ChatActionSuggestionProvider
  | ((context: {
      database: ApplicationDatabasePort;
      chatGateway: ChatGateway;
      logger: AppLogger;
      auditService: AuditService;
    }) => ChatActionSuggestionProvider);

interface ApplicationDatabasePort {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
}

interface ApplicationDatabaseMigrator {
  id: string;
  migrate(database: ApplicationDatabasePort): Promise<void>;
}

export interface ApplicationRouteMount {
  path: string;
  createRouter(dependencies: AppDependencies): Router;
}

type ApplicationUsageLimitPolicyRegistration =
  | UsageLimitPolicy
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => UsageLimitPolicy);

type ApplicationDocumentCapacityReaderRegistration =
  | DocumentCapacityReadPort
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => DocumentCapacityReadPort);

type ApplicationManagedModelPolicyRegistration =
  | ManagedModelPolicy
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => ManagedModelPolicy);

type ApplicationOrganizationCreationGuardRegistration =
  | OrganizationCreationGuard
  | ((context: {
      auditService: AuditService;
      database: Database;
      logger: AppLogger;
    }) => OrganizationCreationGuard);

type ApplicationUsageEventRecorderRegistration =
  | UsageEventRecorder
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => UsageEventRecorder);

interface WorkspaceContactInfoRepositoryPort {
  findById(workspaceId: string): Promise<{
    id: string;
    name: string;
    publicRouteKey: string;
  } | null>;
}

export interface MailTransportPort {
  send(message: {
    to: string;
    replyTo?: string | null;
    subject: string;
    text: string;
    html?: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string | null;
  }): Promise<{
    /**
     * True only when a mail provider accepted the message. Deployments without a configured
     * provider record the message instead of sending it, and report false.
     */
    dispatched: boolean;
  }>;
}

type ApplicationPublicChatActionAdvertiserRegistration =
  | PublicChatActionAdvertiserPort
  | ((context: {
      database: ApplicationDatabasePort;
      chatGateway: ChatGateway;
      logger: AppLogger;
      conversationRepository: ConversationRepositoryPort;
      messageRepository: MessageRepositoryPort;
      workspaceContactInfoRepository: WorkspaceContactInfoRepositoryPort;
      auditService: AuditService;
      abuseControlService: AbuseControlService;
      mailService: MailTransportPort;
      dashboardBaseUrl: string | null;
      assertPublicWebsiteUrl: (url: string) => Promise<void>;
      skillExecutorRegistry: SkillExecutorRegistry;
      agentService: Pick<AgentService, "resolve">;
    }) => PublicChatActionAdvertiserPort);

type ApplicationContactHistoryProviderRegistration =
  | ContactHistoryProviderPort
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => ContactHistoryProviderPort);

type ApplicationAnswerFeedbackHistoryProviderRegistration =
  | AnswerFeedbackHistoryProviderPort
  | ((context: {
      database: Db;
      logger: AppLogger;
      workspaceInvalidationPublisher?: import("@radioso/workspace-invalidation-contract").WorkspaceInvalidationPublisher;
    }) => AnswerFeedbackHistoryProviderPort);

export interface ApplicationDirectiveRegistration {
  directive: Directive;
  routes?: string[];
}

const ACTION_QUEUE_SOURCES = ["routine_action_step", "chat_turn", "outside_turn"] as const;
type ActionQueueSource = (typeof ACTION_QUEUE_SOURCES)[number];

/**
 * Registers an {@link ActionHandler} for one action `type`. Registering it lets host code queue
 * the action, under `requiredCapabilities`, and lets the worker dispatcher route outbox rows to
 * the handler by exact type match. The handler may be supplied directly or as a factory resolved
 * at dependency-build time with a minimal context, mirroring the other host-supplied provider
 * registrations.
 */
interface ApplicationActionHandlerRegistration {
  type: string;
  requiredCapabilities?: string[];
  /**
   * Where this action is queued from. Every registration says so explicitly, and the worker
   * dispatches every registered action.
   * - `routine_action_step`: an author writes it as a routine action step; routine authoring
   *   offers it, and the chat turn running the step queues it.
   * - `chat_turn`: host code queues it with a chat turn and builds its payload — a routine ending's
   *   operator notice or an approval step's request. Authoring never offers it; an action step
   *   naming it fails validation and publishing.
   * - `outside_turn`: host code queues it in its own transaction — a transfer notice written with
   *   its transfer. Neither authoring nor a chat turn admits it.
   */
  queuedFrom: ActionQueueSource;
  handler:
    | ActionHandler
    | ((context: {
        // Handlers run in the worker and may perform real persistence/lookups, so they
        // receive the full Database (not the query-only ApplicationDatabasePort) to
        // construct whatever repositories they need.
        database: Database;
        env: Env;
        logger: AppLogger;
        auditService: AuditService;
        telemetryService: TelemetryService;
        webhookDestinations: WebhookDestinationRuntimePort;
        mailService: MailTransportPort;
        assertPublicWebsiteUrl: (url: string) => Promise<void>;
        // Terminal (non-retryable) action-dispatch failures are alertable — a handler
        // that wants that signal (e.g. ContactSendActionHandler) reports through this.
        errorReporter: ErrorReporter;
      }) => ActionHandler);
}

/** The action handlers an author may write as a routine action step; see `queuedFrom`. */
export const routineAuthorableActionHandlers = (
  registrations: readonly ApplicationActionHandlerRegistration[],
): ApplicationActionHandlerRegistration[] =>
  registrations.filter((registration) => registration.queuedFrom === "routine_action_step");

/** The action handlers a chat turn may queue, whether authored or host-queued. */
export const chatTurnQueueableActionHandlers = (
  registrations: readonly ApplicationActionHandlerRegistration[],
): ApplicationActionHandlerRegistration[] =>
  registrations.filter((registration) => registration.queuedFrom !== "outside_turn");

/** Action types host code queues with a chat turn rather than from an authored action step. */
export const chatTurnQueuedActionTypes = (
  registrations: readonly ApplicationActionHandlerRegistration[],
): ReadonlySet<string> => new Set(
  registrations
    .filter((registration) => registration.queuedFrom === "chat_turn")
    .map((registration) => registration.type),
);

type ApplicationAccountCreatedHook = (context: {
  accountId: string;
  database: ApplicationDatabasePort;
  logger: AppLogger;
}) => Promise<void>;

/**
 * What a module gets when it builds copilot tools or proposal adapters. Deliberately narrow: a
 * contributed descriptor reads its own module's state and receives everything workspace-scoped
 * through the per-call {@link CopilotToolInvocationContext}, so it needs no application services
 * beyond persistence, logging, and the audit sink its own effects write to.
 */
interface ApplicationCopilotRegistrationContext {
  database: Database;
  logger: AppLogger;
  auditService: AuditService;
}

type ApplicationCopilotToolRegistration =
  | CopilotToolContribution
  | ((context: ApplicationCopilotRegistrationContext) => CopilotToolContribution);

/**
 * Branded transactional email content, structurally mirroring EE's `NoticeEmailContent`
 * (`ee/packages/backend-module/src/radiosoModuleTypes.ts`) and OSS's own `EmailContent`
 * (`backend/src/modules/mail/templates/layout.ts`). A module assembles this once per notice;
 * composition renders it with the shared brand layout and sends it with the Resend `kind` tag.
 */
export interface ApplicationNoticeEmailContent {
  preheader: string;
  heading: string;
  paragraphs: readonly string[];
  cta?: { href: string; label: string };
  metaRows?: readonly { label: string; value: string }[];
  footnote?: string;
}

/** Mirrors EE's `NoticeMailPort`. `kind` stays a literal per notice family so a typo cannot
 *  silently create an untagged Resend delivery lane. */
export interface ApplicationNoticeMailPort {
  send(input: {
    to: string;
    subject: string;
    kind: "usage_alert" | "billing_notice";
    content: ApplicationNoticeEmailContent;
    /** Forwarded to the provider (Resend's `Idempotency-Key`) so a retry that resends to
     *  every recipient — including ones a prior attempt already reached — dedupes at the
     *  provider rather than delivering twice. */
    idempotencyKey?: string;
  }): Promise<{
    /** True only when a mail provider accepted the message. A deployment without one
     *  configured (the log or noop driver) reports false, so a caller never reads "sent"
     *  as "actually delivered." */
    dispatched: boolean;
  }>;
}

export interface ApplicationAccountAdministratorContact {
  email: string;
  displayName: string | null;
}

/** Mirrors EE's `AccountAdministratorDirectoryPort`: active owner + admin members of an
 *  account, never disabled. */
export interface ApplicationAccountAdministratorDirectoryPort {
  list(accountId: string): Promise<ApplicationAccountAdministratorContact[]>;
}

interface ApplicationPeriodicTaskHandle {
  run(): Promise<void>;
}

/**
 * What a module gets to build a periodic background task. Narrower than a module's full
 * `initialize()` hook on purpose: `applicationModules.initializeAll()` runs in every runtime
 * (API, worker, migration), so a task that must run on a timer exactly once per deployment —
 * not once per process — cannot be wired through `initialize()`. Composition owns the actual
 * timer (`PeriodicTaskRunner` in `periodicTaskRunner.ts`), started only from the API runtime.
 */
interface ApplicationPeriodicTaskContext {
  database: ApplicationDatabasePort;
  logger: Pick<AppLogger, "warn" | "error">;
  audit: Pick<AuditService, "record">;
  noticeMail: ApplicationNoticeMailPort;
  accountAdministrators: ApplicationAccountAdministratorDirectoryPort;
  /** Null when `APP_BASE_URL` is unset; a task must omit any link it would otherwise build. */
  appBaseUrl: string | null;
}

interface ApplicationPeriodicTaskRegistration {
  id: string;
  intervalMs: number;
  create(context: ApplicationPeriodicTaskContext): ApplicationPeriodicTaskHandle;
}

interface ApplicationExtensionRegistry {
  connectors: ConnectorPlugin[];
  telemetrySinks: TelemetrySink[];
  productAnalyticsSinks: ProductAnalyticsSink[];
  errorSinks: ErrorSink[];
  databaseMigrators: ApplicationDatabaseMigrator[];
  routeMounts: ApplicationRouteMount[];
  accountCreatedHooks: ApplicationAccountCreatedHook[];
  capabilityPolicy?: CapabilityPolicy;
  usageLimitPolicyRegistration?: ApplicationUsageLimitPolicyRegistration;
  documentCapacityReaderRegistration?: ApplicationDocumentCapacityReaderRegistration;
  managedModelPolicyRegistration?: ApplicationManagedModelPolicyRegistration;
  organizationCreationGuardRegistration?: ApplicationOrganizationCreationGuardRegistration;
  usageEventRecorderRegistration?: ApplicationUsageEventRecorderRegistration;
  documentStorage?: DocumentStoragePort;
  documentJobDispatcher?: DocumentJobDispatcherPort;
  documentJobConsumer?: JobConsumerPort;
  websiteCrawlerProvider?: WebsiteCrawlerProvider;
  chunkingProvider?: TextChunkingProviderPort;
  websiteEmbedIntegration?: WebsiteEmbedIntegrationProvider;
  // Unregistered by default: with no extractor the facet worker is not built at all, so
  // queued jobs stay durable instead of being drained into nothing.
  facetExtraction?: FacetExtractionPort;
  publicChatActionAdvertiserRegistrations: ApplicationPublicChatActionAdvertiserRegistration[];
  routineRegistrations: RoutineRegistration[];
  publishedRoutineRegistrationSource?: PublishedRoutineRegistrationSource;
  actionHandlerRegistrations: ApplicationActionHandlerRegistration[];
  contactHistoryProviderRegistration?: ApplicationContactHistoryProviderRegistration;
  answerFeedbackHistoryProviderRegistration?: ApplicationAnswerFeedbackHistoryProviderRegistration;
  skillCatalogEntries: SkillCatalogEntryDefinition[];
  skillDefinitions: SkillDefinition[];
  skillExecutors: SkillExecutorRegistration[];
  directiveRegistrations: ApplicationDirectiveRegistration[];
  // Engine extension points (issue #482, part C). Both single-instance, last-wins.
  // `selectionStrategy` is defaulted by composition when unregistered (mirroring
  // `capabilityPolicy`). `directiveMatcher` stays optional through composition; its
  // default (always-match) is applied downstream in `createDirectiveSteering`, so a
  // missing registration flows through as `undefined`. Contextual directive model
  // matching is built per turn through `directiveMatchGatewayFactory` so usage
  // context never hides on a singleton matcher.
  selectionStrategy?: TurnSelectionStrategy;
  directiveMatcher?: DirectiveMatcherPort;
  directiveMatchGatewayFactory?: DirectiveMatchGatewayFactory;
  agentSurfaceExtensions: AgentSurfaceExtension[];
  chatActionSuggestionProviders: ApplicationChatActionSuggestionProviderRegistration[];
  oauthProviders: OauthProviderDefinition[];
  copilotToolRegistrations: ApplicationCopilotToolRegistration[];
  periodicTaskRegistrations: ApplicationPeriodicTaskRegistration[];
}

export interface ApplicationModuleRegistrationContext {
  registerConnector(plugin: ConnectorPlugin): void;
  registerTelemetrySink(sink: TelemetrySink): void;
  registerProductAnalyticsSink(sink: ProductAnalyticsSink): void;
  registerErrorSink(sink: ErrorSink): void;
  registerDatabaseMigrator(migrator: ApplicationDatabaseMigrator): void;
  registerRouteMount(mount: ApplicationRouteMount): void;
  registerAccountCreatedHandler(handler: ApplicationAccountCreatedHook): void;
  registerCapabilityPolicy(policy: CapabilityPolicy): void;
  registerUsageLimitPolicy(policy: ApplicationUsageLimitPolicyRegistration): void;
  /** Document capacity is a read only the documents reviewed-operation service consumes; kept off {@link UsageLimitPolicy} so its reservation fakes never need to stub it. */
  registerDocumentCapacityReader(reader: ApplicationDocumentCapacityReaderRegistration): void;
  registerManagedModelPolicy(policy: ApplicationManagedModelPolicyRegistration): void;
  registerOrganizationCreationGuard(guard: ApplicationOrganizationCreationGuardRegistration): void;
  registerUsageEventRecorder(recorder: ApplicationUsageEventRecorderRegistration): void;
  registerDocumentStorage(storage: DocumentStoragePort): void;
  registerDocumentJobDispatcher(dispatcher: DocumentJobDispatcherPort): void;
  registerDocumentJobConsumer(consumer: JobConsumerPort): void;
  registerWebsiteCrawlerProvider(provider: WebsiteCrawlerProvider): void;
  registerChunkingProvider(provider: TextChunkingProviderPort): void;
  registerWebsiteEmbedIntegration(provider: WebsiteEmbedIntegrationProvider): void;
  registerFacetExtraction(port: FacetExtractionPort): void;
  registerPublicChatActionAdvertiser(provider: ApplicationPublicChatActionAdvertiserRegistration): void;
  registerRoutine(registration: RoutineRegistration): void;
  registerPublishedRoutineSource(source: PublishedRoutineRegistrationSource): void;
  registerActionHandler(registration: ApplicationActionHandlerRegistration): void;
  registerContactHistoryProvider(provider: ApplicationContactHistoryProviderRegistration): void;
  registerAnswerFeedbackHistoryProvider(provider: ApplicationAnswerFeedbackHistoryProviderRegistration): void;
  registerSkillCatalogEntry(entry: SkillCatalogEntryDefinition): void;
  registerSkillDefinition(definition: SkillDefinition): void;
  registerSkillExecutor(registration: SkillExecutorRegistration): void;
  registerDirective(directive: Directive, options?: { routes?: string[] }): void;
  registerSelectionStrategy(strategy: TurnSelectionStrategy): void;
  registerDirectiveMatcher(matcher: DirectiveMatcherPort): void;
  registerDirectiveMatchGatewayFactory(factory: DirectiveMatchGatewayFactory): void;
  registerAgentSurfaceExtension(extension: AgentSurfaceExtension): void;
  registerChatActionSuggestionProvider(provider: ApplicationChatActionSuggestionProviderRegistration): void;
  registerOauthProvider(provider: OauthProviderDefinition): void;
  /**
   * Contributes catalog tools. Reads, probes, and acts only: a proposal needs an adapter for its
   * target type, and the target-type set is closed by an OpenAPI enum, repository narrowing, and
   * the dashboard's card presentation, so an extension-owned target type is its own change.
   */
  registerCopilotTools(registration: ApplicationCopilotToolRegistration): void;
  /** Schedules a recurring background task in the API runtime only (see
   *  {@link ApplicationPeriodicTaskRegistration}). */
  registerPeriodicTask(registration: ApplicationPeriodicTaskRegistration): void;
}

export interface ApplicationModule {
  id: string;
  name?: string;
  register?(context: ApplicationModuleRegistrationContext): void;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export const createApplicationExtensionRegistry = (): ApplicationExtensionRegistry => ({
  connectors: [],
  telemetrySinks: [],
  productAnalyticsSinks: [],
  errorSinks: [],
  databaseMigrators: [],
  routeMounts: [],
  accountCreatedHooks: [],
  publicChatActionAdvertiserRegistrations: [],
  routineRegistrations: [],
  actionHandlerRegistrations: [],
  skillCatalogEntries: [],
  skillDefinitions: [],
  skillExecutors: [],
  directiveRegistrations: [],
  agentSurfaceExtensions: [],
  chatActionSuggestionProviders: [],
  oauthProviders: [],
  copilotToolRegistrations: [],
  periodicTaskRegistrations: [],
});

const createRegistrationContext = (registry: ApplicationExtensionRegistry): ApplicationModuleRegistrationContext => ({
  registerConnector(plugin) {
    registry.connectors.push(plugin);
  },
  registerTelemetrySink(sink) {
    registry.telemetrySinks.push(sink);
  },
  registerProductAnalyticsSink(sink) {
    registry.productAnalyticsSinks.push(sink);
  },
  registerErrorSink(sink) {
    registry.errorSinks.push(sink);
  },
  registerDatabaseMigrator(migrator) {
    registry.databaseMigrators.push(migrator);
  },
  registerRouteMount(mount) {
    registry.routeMounts.push(mount);
  },
  registerAccountCreatedHandler(handler) {
    registry.accountCreatedHooks.push(handler);
  },
  registerCapabilityPolicy(policy) {
    registry.capabilityPolicy = policy;
  },
  registerUsageLimitPolicy(policy) {
    registry.usageLimitPolicyRegistration = policy;
  },
  registerDocumentCapacityReader(reader) {
    registry.documentCapacityReaderRegistration = reader;
  },
  registerManagedModelPolicy(policy) {
    registry.managedModelPolicyRegistration = policy;
  },
  registerOrganizationCreationGuard(guard) {
    registry.organizationCreationGuardRegistration = guard;
  },
  registerUsageEventRecorder(recorder) {
    registry.usageEventRecorderRegistration = recorder;
  },
  registerDocumentStorage(storage) {
    registry.documentStorage = storage;
  },
  registerDocumentJobDispatcher(dispatcher) {
    registry.documentJobDispatcher = dispatcher;
  },
  registerDocumentJobConsumer(consumer) {
    registry.documentJobConsumer = consumer;
  },
  registerWebsiteCrawlerProvider(provider) {
    registry.websiteCrawlerProvider = provider;
  },
  registerChunkingProvider(provider) {
    registry.chunkingProvider = provider;
  },
  registerWebsiteEmbedIntegration(provider) {
    registry.websiteEmbedIntegration = provider;
  },
  registerFacetExtraction(port) {
    registry.facetExtraction = port;
  },
  registerPublicChatActionAdvertiser(provider) {
    registry.publicChatActionAdvertiserRegistrations.push(provider);
  },
  registerRoutine(registration) {
    registry.routineRegistrations.push(registration);
  },
  registerPublishedRoutineSource(source) {
    registry.publishedRoutineRegistrationSource = source;
  },
  registerActionHandler(registration) {
    // A module built against an older registration contract must fail loudly, not drop out of authoring.
    if (!(ACTION_QUEUE_SOURCES as readonly unknown[]).includes(registration.queuedFrom)) {
      throw new Error(
        `Action handler "${registration.type}" needs queuedFrom set to one of: ${ACTION_QUEUE_SOURCES.join(", ")}`,
      );
    }
    registry.actionHandlerRegistrations.push(registration);
  },
  registerContactHistoryProvider(provider) {
    registry.contactHistoryProviderRegistration = provider;
  },
  registerAnswerFeedbackHistoryProvider(provider) {
    registry.answerFeedbackHistoryProviderRegistration = provider;
  },
  registerSkillCatalogEntry(entry) {
    registry.skillCatalogEntries.push(entry);
  },
  registerSkillDefinition(definition) {
    registry.skillDefinitions.push(definition);
  },
  registerSkillExecutor(registration) {
    registry.skillExecutors.push(registration);
  },
  registerDirective(directive, options) {
    registry.directiveRegistrations.push(
      options?.routes ? { directive, routes: [...options.routes] } : { directive },
    );
  },
  registerSelectionStrategy(strategy) {
    registry.selectionStrategy = strategy;
  },
  registerDirectiveMatcher(matcher) {
    registry.directiveMatcher = matcher;
  },
  registerDirectiveMatchGatewayFactory(factory) {
    registry.directiveMatchGatewayFactory = factory;
  },
  registerAgentSurfaceExtension(extension) {
    registry.agentSurfaceExtensions.push(extension);
  },
  registerChatActionSuggestionProvider(provider) {
    registry.chatActionSuggestionProviders.push(provider);
  },
  registerOauthProvider(provider) {
    registry.oauthProviders.push(provider);
  },
  registerCopilotTools(registration) {
    registry.copilotToolRegistrations.push(registration);
  },
  registerPeriodicTask(registration) {
    registry.periodicTaskRegistrations.push(registration);
  },
});

export class ApplicationModuleCoordinator {
  private readonly modules = new Map<string, ApplicationModule>();
  private readonly logger: Pick<AppLogger, "error">;
  private readonly registry: ApplicationExtensionRegistry;

  constructor(options: {
    logger: Pick<AppLogger, "error">;
    registry: ApplicationExtensionRegistry;
  }) {
    this.logger = options.logger;
    this.registry = options.registry;
  }

  get registeredModules(): ApplicationModule[] {
    return [...this.modules.values()];
  }

  apply(modules: ApplicationModule[]): void {
    const context = createRegistrationContext(this.registry);

    for (const module of modules) {
      if (this.modules.has(module.id)) {
        throw new Error(`Application module "${module.id}" is already registered`);
      }
      this.modules.set(module.id, module);
      module.register?.(context);
    }
  }

  async initializeAll(): Promise<void> {
    for (const module of this.modules.values()) {
      if (!module.initialize) {
        continue;
      }
      try {
        await module.initialize();
      } catch (error) {
        this.logger.error(
          {
            moduleId: module.id,
            err: error instanceof Error ? error.message : String(error),
          },
          "Application module failed to initialize",
        );
        throw error;
      }
    }
  }

  async migrateAll(database: ApplicationDatabasePort): Promise<void> {
    for (const migrator of this.registry.databaseMigrators) {
      try {
        await migrator.migrate(database);
      } catch (error) {
        this.logger.error(
          {
            migratorId: migrator.id,
            err: error instanceof Error ? error.message : String(error),
          },
          "Application module migrator failed",
        );
        throw error;
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const module of [...this.modules.values()].reverse()) {
      if (!module.shutdown) {
        continue;
      }
      try {
        await module.shutdown();
      } catch (error) {
        this.logger.error(
          {
            moduleId: module.id,
            err: error instanceof Error ? error.message : String(error),
          },
          "Application module failed to shut down",
        );
      }
    }
  }
}
