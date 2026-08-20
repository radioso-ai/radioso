import type {
  ConnectorDatabasePort,
  ConnectorDetail,
  ConnectorSummary,
} from "@radioso/connector-api";

import type {
  ConnectorMutationResult,
  ConnectorRegistry,
  ConnectorSyncResult,
} from "./connectorRegistry.js";

/**
 * HTTP-facing connector management port. Composition binds a registry to its
 * database once; routes never receive either infrastructure dependency.
 */
export interface ConnectorManagementPort {
  list(workspaceId: string): Promise<ConnectorSummary[]>;
  detail(workspaceId: string, connectorId: string): Promise<ConnectorDetail | null>;
  exists(connectorId: string): boolean;
  saveConfig(
    workspaceId: string,
    connectorId: string,
    config: Record<string, unknown>,
  ): Promise<ConnectorMutationResult>;
  enable(workspaceId: string, connectorId: string): Promise<ConnectorMutationResult>;
  disable(workspaceId: string, connectorId: string): Promise<void>;
  sync(workspaceId: string, connectorId: string): Promise<ConnectorSyncResult>;
}

type ConnectorManagementRegistry = Pick<
  ConnectorRegistry,
  | "disableConnector"
  | "enableConnector"
  | "getConnectorDetail"
  | "getPlugin"
  | "listConnectors"
  | "saveConfig"
  | "syncConnector"
>;

export class ConnectorManagementService implements ConnectorManagementPort {
  constructor(private readonly dependencies: {
    database: ConnectorDatabasePort;
    registry: ConnectorManagementRegistry;
  }) {}

  list(workspaceId: string): Promise<ConnectorSummary[]> {
    return this.dependencies.registry.listConnectors(this.dependencies.database, workspaceId);
  }

  detail(workspaceId: string, connectorId: string): Promise<ConnectorDetail | null> {
    return this.dependencies.registry.getConnectorDetail(this.dependencies.database, workspaceId, connectorId);
  }

  exists(connectorId: string): boolean {
    return Boolean(this.dependencies.registry.getPlugin(connectorId));
  }

  saveConfig(
    workspaceId: string,
    connectorId: string,
    config: Record<string, unknown>,
  ): Promise<ConnectorMutationResult> {
    return this.dependencies.registry.saveConfig(
      this.dependencies.database,
      workspaceId,
      connectorId,
      config,
    );
  }

  enable(workspaceId: string, connectorId: string): Promise<ConnectorMutationResult> {
    return this.dependencies.registry.enableConnector(this.dependencies.database, workspaceId, connectorId);
  }

  disable(workspaceId: string, connectorId: string): Promise<void> {
    return this.dependencies.registry.disableConnector(this.dependencies.database, workspaceId, connectorId);
  }

  sync(workspaceId: string, connectorId: string): Promise<ConnectorSyncResult> {
    return this.dependencies.registry.syncConnector(this.dependencies.database, workspaceId, connectorId);
  }
}
