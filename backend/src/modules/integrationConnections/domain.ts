export const integrationConnectionStatuses = ["authorized", "disabled", "needs_reauth", "error"] as const;
export type IntegrationConnectionStatus = (typeof integrationConnectionStatuses)[number];

export const integrationConnectionHealthStatuses = ["ok", "failed", "unknown"] as const;
export type IntegrationConnectionHealthStatus = (typeof integrationConnectionHealthStatuses)[number];

export interface IntegrationConnectionRecord {
  id: string;
  workspaceId: string;
  oauthConnectionId: string;
  provider: string;
  displayName: string;
  status: IntegrationConnectionStatus;
  lastHealthStatus: IntegrationConnectionHealthStatus | null;
  lastHealthCheckedAt: Date | null;
  lastErrorCode: string | null;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIntegrationConnectionInput {
  workspaceId: string;
  oauthConnectionId: string;
  provider: string;
  displayName: string;
  status?: IntegrationConnectionStatus;
  lastHealthStatus?: IntegrationConnectionHealthStatus | null;
  lastHealthCheckedAt?: Date | null;
  lastErrorCode?: string | null;
  config?: Record<string, unknown>;
}

export interface UpdateIntegrationConnectionInput {
  displayName?: string;
  status?: IntegrationConnectionStatus;
  lastHealthStatus?: IntegrationConnectionHealthStatus | null;
  lastHealthCheckedAt?: Date | null;
  lastErrorCode?: string | null;
  config?: Record<string, unknown>;
}
