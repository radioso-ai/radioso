import type { Router } from "express";
import type { ConnectorPlugin } from "@radioso/connector-api";
import type { QueryResultRow } from "pg";

import type { ProductAnalyticsSink } from "../../shared/analytics/productAnalyticsSink.js";
import type { ErrorSink } from "../../shared/errors/errorSink.js";
import type { TelemetrySink } from "../../shared/observability/telemetry/telemetrySink.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type {
  DocumentJobDispatcherPort,
  DocumentStoragePort,
} from "../../modules/documents/contracts/index.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { JobConsumerPort } from "../../shared/domain/jobConsumer.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type { UsageEventRecorder } from "../../shared/domain/usageEventRecorder.js";
import type { WebsiteEmbedIntegrationProvider } from "../../modules/settings/contracts/websiteEmbedIntegration.js";
import type {
  ChatGateway,
  ChatIntakeProviderPort,
  ContactHistoryProviderPort,
} from "../../modules/chat/contracts/index.js";
import type { AnswerFeedbackHistoryProviderPort } from "../../modules/chat/composition.js";
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
import type { WebsiteCrawlerProvider } from "../../modules/websiteCrawler/provider.js";
import type { AgentSurfaceExtension } from "../../modules/agents/public.js";
import type { TextChunkingProviderPort } from "../../modules/retrieval/public.js";
import type { ChatActionSuggestionProvider } from "../../modules/chat/services/actionSuggestions/chatActionSuggestionProvider.js";

export type ApplicationChatActionSuggestionProviderRegistration =
  | ChatActionSuggestionProvider
  | ((context: {
      database: ApplicationDatabasePort;
      chatGateway: ChatGateway;
      logger: AppLogger;
      auditService: AuditService;
    }) => ChatActionSuggestionProvider);

export interface ApplicationDatabasePort {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface ApplicationDatabaseMigrator {
  id: string;
  migrate(database: ApplicationDatabasePort): Promise<void>;
}

export interface ApplicationRouteMount {
  path: string;
  createRouter(dependencies: AppDependencies): Router;
}

export type ApplicationUsageLimitPolicyRegistration =
  | UsageLimitPolicy
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => UsageLimitPolicy);

export type ApplicationUsageEventRecorderRegistration =
  | UsageEventRecorder
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => UsageEventRecorder);

export interface WorkspaceContactInfoRepositoryPort {
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
  }): Promise<void>;
}

export type ApplicationChatIntakeProviderRegistration =
  | ChatIntakeProviderPort
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
    }) => ChatIntakeProviderPort);

export type ApplicationContactHistoryProviderRegistration =
  | ContactHistoryProviderPort
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => ContactHistoryProviderPort);

export type ApplicationAnswerFeedbackHistoryProviderRegistration =
  | AnswerFeedbackHistoryProviderPort
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => AnswerFeedbackHistoryProviderPort);

export type ApplicationAccountCreatedHook = (context: {
  accountId: string;
  database: ApplicationDatabasePort;
  logger: AppLogger;
}) => Promise<void>;

export interface ApplicationExtensionRegistry {
  connectors: ConnectorPlugin[];
  telemetrySinks: TelemetrySink[];
  productAnalyticsSinks: ProductAnalyticsSink[];
  errorSinks: ErrorSink[];
  databaseMigrators: ApplicationDatabaseMigrator[];
  routeMounts: ApplicationRouteMount[];
  accountCreatedHooks: ApplicationAccountCreatedHook[];
  capabilityPolicy?: CapabilityPolicy;
  usageLimitPolicyRegistration?: ApplicationUsageLimitPolicyRegistration;
  usageEventRecorderRegistration?: ApplicationUsageEventRecorderRegistration;
  documentStorage?: DocumentStoragePort;
  documentJobDispatcher?: DocumentJobDispatcherPort;
  documentJobConsumer?: JobConsumerPort;
  websiteCrawlerProvider?: WebsiteCrawlerProvider;
  chunkingProvider?: TextChunkingProviderPort;
  websiteEmbedIntegration?: WebsiteEmbedIntegrationProvider;
  chatIntakeProviderRegistrations: ApplicationChatIntakeProviderRegistration[];
  contactHistoryProviderRegistration?: ApplicationContactHistoryProviderRegistration;
  answerFeedbackHistoryProviderRegistration?: ApplicationAnswerFeedbackHistoryProviderRegistration;
  skillCatalogEntries: SkillCatalogEntryDefinition[];
  skillDefinitions: SkillDefinition[];
  skillExecutors: SkillExecutorRegistration[];
  agentSurfaceExtensions: AgentSurfaceExtension[];
  chatActionSuggestionProviders: ApplicationChatActionSuggestionProviderRegistration[];
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
  registerUsageEventRecorder(recorder: ApplicationUsageEventRecorderRegistration): void;
  registerDocumentStorage(storage: DocumentStoragePort): void;
  registerDocumentJobDispatcher(dispatcher: DocumentJobDispatcherPort): void;
  registerDocumentJobConsumer(consumer: JobConsumerPort): void;
  registerWebsiteCrawlerProvider(provider: WebsiteCrawlerProvider): void;
  registerChunkingProvider(provider: TextChunkingProviderPort): void;
  registerWebsiteEmbedIntegration(provider: WebsiteEmbedIntegrationProvider): void;
  registerChatIntakeProvider(provider: ApplicationChatIntakeProviderRegistration): void;
  registerContactHistoryProvider(provider: ApplicationContactHistoryProviderRegistration): void;
  registerAnswerFeedbackHistoryProvider(provider: ApplicationAnswerFeedbackHistoryProviderRegistration): void;
  registerSkillCatalogEntry(entry: SkillCatalogEntryDefinition): void;
  registerSkillDefinition(definition: SkillDefinition): void;
  registerSkillExecutor(registration: SkillExecutorRegistration): void;
  registerAgentSurfaceExtension(extension: AgentSurfaceExtension): void;
  registerChatActionSuggestionProvider(provider: ApplicationChatActionSuggestionProviderRegistration): void;
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
  chatIntakeProviderRegistrations: [],
  skillCatalogEntries: [],
  skillDefinitions: [],
  skillExecutors: [],
  agentSurfaceExtensions: [],
  chatActionSuggestionProviders: [],
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
  registerChatIntakeProvider(provider) {
    registry.chatIntakeProviderRegistrations.push(provider);
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
  registerAgentSurfaceExtension(extension) {
    registry.agentSurfaceExtensions.push(extension);
  },
  registerChatActionSuggestionProvider(provider) {
    registry.chatActionSuggestionProviders.push(provider);
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
