import type { Router } from "express";
import type { ConnectorPlugin } from "@radioso/connector-api";
import type { QueryResultRow } from "pg";

import type { ProductAnalyticsSink } from "../../shared/analytics/productAnalyticsSink.js";
import type { IncidentSink } from "../../shared/incidents/incidentSink.js";
import type { TelemetrySink } from "../../shared/observability/telemetry/telemetrySink.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { DocumentStoragePort } from "../../modules/documents/infra/gcsDocumentStorage.js";
import type { DocumentJobConsumerPort } from "../../modules/documents/services/documentJobConsumer.js";
import type { DocumentJobDispatcherPort } from "../../modules/documents/services/documentJobDispatcher.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type { WebsiteEmbedIntegrationProvider } from "../../modules/settings/domain/websiteEmbedIntegration.js";
import type { ChatActionProviderPort } from "../../modules/chat/services/chatActionProvider.js";
import type { AppDependencies } from "../server/types.js";
import type { AbuseControlService } from "../../modules/security/services/abuseControlService.js";
import type { AuditService } from "../../modules/audit/services/auditService.js";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { ContactHistoryProviderPort } from "../../modules/chat/services/contactHistoryProvider.js";

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

export type ApplicationChatActionProviderRegistration =
  | ChatActionProviderPort
  | ((context: {
      database: ApplicationDatabasePort;
      chatGateway?: unknown;
      logger: AppLogger;
      conversationRepository: ConversationRepositoryPort;
      messageRepository: MessageRepositoryPort;
      auditService: AuditService;
      abuseControlService: AbuseControlService;
    }) => ChatActionProviderPort);

export type ApplicationContactHistoryProviderRegistration =
  | ContactHistoryProviderPort
  | ((context: {
      database: ApplicationDatabasePort;
      logger: AppLogger;
    }) => ContactHistoryProviderPort);

export type ApplicationAccountCreatedHook = (context: {
  accountId: string;
  database: ApplicationDatabasePort;
  logger: AppLogger;
}) => Promise<void>;

export interface ApplicationExtensionRegistry {
  connectors: ConnectorPlugin[];
  telemetrySinks: TelemetrySink[];
  productAnalyticsSinks: ProductAnalyticsSink[];
  incidentSinks: IncidentSink[];
  databaseMigrators: ApplicationDatabaseMigrator[];
  routeMounts: ApplicationRouteMount[];
  accountCreatedHooks: ApplicationAccountCreatedHook[];
  capabilityPolicy?: CapabilityPolicy;
  usageLimitPolicyRegistration?: ApplicationUsageLimitPolicyRegistration;
  documentStorage?: DocumentStoragePort;
  documentJobDispatcher?: DocumentJobDispatcherPort;
  documentJobConsumer?: DocumentJobConsumerPort;
  websiteEmbedIntegration?: WebsiteEmbedIntegrationProvider;
  chatActionProviderRegistration?: ApplicationChatActionProviderRegistration;
  contactHistoryProviderRegistration?: ApplicationContactHistoryProviderRegistration;
}

export interface ApplicationModuleRegistrationContext {
  registerConnector(plugin: ConnectorPlugin): void;
  registerTelemetrySink(sink: TelemetrySink): void;
  registerProductAnalyticsSink(sink: ProductAnalyticsSink): void;
  registerIncidentSink(sink: IncidentSink): void;
  registerDatabaseMigrator(migrator: ApplicationDatabaseMigrator): void;
  registerRouteMount(mount: ApplicationRouteMount): void;
  registerAccountCreatedHandler(handler: ApplicationAccountCreatedHook): void;
  registerCapabilityPolicy(policy: CapabilityPolicy): void;
  registerUsageLimitPolicy(policy: ApplicationUsageLimitPolicyRegistration): void;
  registerDocumentStorage(storage: DocumentStoragePort): void;
  registerDocumentJobDispatcher(dispatcher: DocumentJobDispatcherPort): void;
  registerDocumentJobConsumer(consumer: DocumentJobConsumerPort): void;
  registerWebsiteEmbedIntegration(provider: WebsiteEmbedIntegrationProvider): void;
  registerChatActionProvider(provider: ApplicationChatActionProviderRegistration): void;
  registerContactHistoryProvider(provider: ApplicationContactHistoryProviderRegistration): void;
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
  incidentSinks: [],
  databaseMigrators: [],
  routeMounts: [],
  accountCreatedHooks: [],
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
  registerIncidentSink(sink) {
    registry.incidentSinks.push(sink);
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
  registerDocumentStorage(storage) {
    registry.documentStorage = storage;
  },
  registerDocumentJobDispatcher(dispatcher) {
    registry.documentJobDispatcher = dispatcher;
  },
  registerDocumentJobConsumer(consumer) {
    registry.documentJobConsumer = consumer;
  },
  registerWebsiteEmbedIntegration(provider) {
    registry.websiteEmbedIntegration = provider;
  },
  registerChatActionProvider(provider) {
    registry.chatActionProviderRegistration = provider;
  },
  registerContactHistoryProvider(provider) {
    registry.contactHistoryProviderRegistration = provider;
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
