import { request } from './api-client'

export type CustomerEmailConnectionStatus =
  | 'authorized'
  | 'disabled'
  | 'needs_reauth'
  | 'error'
  | 'unconfigured'

export type CustomerEmailConnection = {
  id: string
  displayName: string
  provider: string
  senderEmail: string
  senderName?: string | null
  replyToEmail?: string | null
  status: CustomerEmailConnectionStatus
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
}
