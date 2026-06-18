import { request } from './api-client'

export type SlackInstallStatus = 'connected' | 'needs_reauth' | 'disabled' | 'not_configured'

export type SlackInstallStartResponse = {
  authorizationUrl: string
  connectionId: string
  status: 'pending'
}

export type SlackInstallStatusResponse = {
  status: SlackInstallStatus
  teamName?: string
  answeringAgentId?: string
}

export type SlackBinding = {
  answeringAgentId: string | null
  escalationChannelId: string | null
}

export type SlackBindingUpdate = {
  answeringAgentId: string
  escalationChannelId?: string | null
}

const agentSlackPath = (workspaceId: string, agentId: string, suffix: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/slack/${suffix}`

export const slackApi = {
  async startInstall(workspaceId: string, agentId: string): Promise<SlackInstallStartResponse> {
    return request<SlackInstallStartResponse>(
      agentSlackPath(workspaceId, agentId, 'install/start'),
      { method: 'POST' },
      { withApiToken: true },
    )
  },

  async getInstallStatus(workspaceId: string, agentId: string): Promise<SlackInstallStatusResponse> {
    return request<SlackInstallStatusResponse>(
      agentSlackPath(workspaceId, agentId, 'install/status'),
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async getBinding(workspaceId: string, agentId: string): Promise<SlackBinding> {
    return request<SlackBinding>(
      agentSlackPath(workspaceId, agentId, 'binding'),
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async updateBinding(workspaceId: string, agentId: string, input: SlackBindingUpdate): Promise<SlackBinding> {
    return request<SlackBinding>(
      agentSlackPath(workspaceId, agentId, 'binding'),
      { method: 'PUT', body: JSON.stringify(input) },
      { withApiToken: true },
    )
  },

  async disconnect(workspaceId: string, agentId: string): Promise<void> {
    await request<void>(
      agentSlackPath(workspaceId, agentId, 'installation'),
      { method: 'DELETE' },
      { withApiToken: true },
    )
  },
}
