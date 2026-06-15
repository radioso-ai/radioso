import { request } from './api-client'

export type CustomerEmailConnectionStatus =
  | 'authorized'
  | 'disabled'
  | 'needs_reauth'
  | 'error'
  | 'unconfigured'

export type CustomerEmailConnection = {
  id: string
  workspaceId: string
  oauthConnectionId: string
  displayName: string
  provider: string
  senderEmail: string
  senderName?: string | null
  replyToEmail?: string | null
  status: CustomerEmailConnectionStatus
  lastHealthStatus?: 'ok' | 'failed' | 'unknown' | null
  lastHealthCheckedAt?: string | null
  lastErrorCode?: string | null
  updatedAt: string
}

export type CustomerEmailOauthProviderId = 'google_mail' | 'microsoft_graph_mail'

export type WorkspaceOauthConnectionStatus =
  | 'pending'
  | 'authorized'
  | 'needs_reauth'
  | 'disabled'
  | 'error'

export type WorkspaceOauthConnection = {
  id: string
  provider: string
  displayName: string
  status: WorkspaceOauthConnectionStatus
  grantedScopes: string[]
  providerAccountId: string | null
  updatedAt: string
}

export type CreateWorkspaceOauthConnectionInput = {
  provider: CustomerEmailOauthProviderId
  displayName: string
  requestedScopes?: string[]
}

export type WorkspaceOauthAuthorization = {
  connectionId: string
  authorizationUrl: string
  status: 'pending'
}

export type CreateCustomerEmailConnectionInput = {
  oauthConnectionId: string
  displayName: string
  senderEmail: string
  senderName?: string | null
  replyToEmail?: string | null
}

export type UpdateCustomerEmailConnectionInput = {
  displayName?: string
  senderEmail?: string
  senderName?: string | null
  replyToEmail?: string | null
  disabled?: boolean
}

export const customerEmailApi = {
  async startOauth(
    workspaceId: string,
    input: CreateWorkspaceOauthConnectionInput,
  ): Promise<WorkspaceOauthAuthorization> {
    return request<WorkspaceOauthAuthorization>(
      `/workspaces/${workspaceId}/oauth-connections`,
      { method: 'POST', body: JSON.stringify(input) },
      { withApiToken: true },
    )
  },

  async getOauthConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ connection: WorkspaceOauthConnection }> {
    return request<{ connection: WorkspaceOauthConnection }>(
      `/workspaces/${workspaceId}/oauth-connections/${connectionId}`,
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async listOauthConnections(workspaceId: string): Promise<{ connections: WorkspaceOauthConnection[] }> {
    return request<{ connections: WorkspaceOauthConnection[] }>(
      `/workspaces/${workspaceId}/oauth-connections`,
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async reauthorizeOauth(
    workspaceId: string,
    connectionId: string,
  ): Promise<WorkspaceOauthAuthorization> {
    return request<WorkspaceOauthAuthorization>(
      `/workspaces/${workspaceId}/oauth-connections/${connectionId}/reauthorize`,
      { method: 'POST' },
      { withApiToken: true },
    )
  },

  async listEmailConnections(workspaceId: string): Promise<{ connections: CustomerEmailConnection[] }> {
    return request<{ connections: CustomerEmailConnection[] }>(
      `/workspaces/${workspaceId}/email-connections`,
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async createEmailConnection(
    workspaceId: string,
    input: CreateCustomerEmailConnectionInput,
  ): Promise<{ connection: CustomerEmailConnection }> {
    return request<{ connection: CustomerEmailConnection }>(
      `/workspaces/${workspaceId}/email-connections`,
      { method: 'POST', body: JSON.stringify(input) },
      { withApiToken: true },
    )
  },

  async updateEmailConnection(
    workspaceId: string,
    connectionId: string,
    input: UpdateCustomerEmailConnectionInput,
  ): Promise<{ connection: CustomerEmailConnection }> {
    return request<{ connection: CustomerEmailConnection }>(
      `/workspaces/${workspaceId}/email-connections/${connectionId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      { withApiToken: true },
    )
  },

  async checkEmailConnectionHealth(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ connection: CustomerEmailConnection }> {
    return request<{ connection: CustomerEmailConnection }>(
      `/workspaces/${workspaceId}/email-connections/${connectionId}/health-check`,
      { method: 'POST' },
      { withApiToken: true },
    )
  },

  async deleteEmailConnection(workspaceId: string, connectionId: string): Promise<void> {
    await request<void>(
      `/workspaces/${workspaceId}/email-connections/${connectionId}`,
      { method: 'DELETE' },
      { withApiToken: true },
    )
  },
}
