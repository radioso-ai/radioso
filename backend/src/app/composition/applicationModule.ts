import type { ConnectorPlugin } from "@radioso/connector-api";

import type { ProductAnalyticsSink } from "../../shared/analytics/productAnalyticsSink.js";
import type { IncidentSink } from "../../shared/incidents/incidentSink.js";
import type { TelemetrySink } from "../../shared/observability/telemetry/telemetrySink.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { DocumentStoragePort } from "../../modules/documents/infra/gcsDocumentStorage.js";
import type { DocumentJobDispatcherPort } from "../../modules/documents/services/documentJobDispatcher.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import type { WebsiteEmbedIntegrationProvider } from "../../modules/settings/domain/websiteEmbedIntegration.js";

export interface ApplicationExtensionRegistry {
  connectors: ConnectorPlugin[];
  telemetrySinks: TelemetrySink[];
  productAnalyticsSinks: ProductAnalyticsSink[];
  incidentSinks: IncidentSink[];
  capabilityPolicy?: CapabilityPolicy;
  documentStorage?: DocumentStoragePort;
  documentJobDispatcher?: DocumentJobDispatcherPort;
  websiteEmbedIntegration?: WebsiteEmbedIntegrationProvider;
}

export interface ApplicationModuleRegistrationContext {
  registerConnector(plugin: ConnectorPlugin): void;
  registerTelemetrySink(sink: TelemetrySink): void;
  registerProductAnalyticsSink(sink: ProductAnalyticsSink): void;
  registerIncidentSink(sink: IncidentSink): void;
  registerCapabilityPolicy(policy: CapabilityPolicy): void;
  registerDocumentStorage(storage: DocumentStoragePort): void;
  registerDocumentJobDispatcher(dispatcher: DocumentJobDispatcherPort): void;
  registerWebsiteEmbedIntegration(provider: WebsiteEmbedIntegrationProvider): void;
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
  registerCapabilityPolicy(policy) {
    registry.capabilityPolicy = policy;
  },
  registerDocumentStorage(storage) {
    registry.documentStorage = storage;
  },
  registerDocumentJobDispatcher(dispatcher) {
    registry.documentJobDispatcher = dispatcher;
  },
  registerWebsiteEmbedIntegration(provider) {
    registry.websiteEmbedIntegration = provider;
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
