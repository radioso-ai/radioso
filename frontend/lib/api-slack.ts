import { request } from './api-client'

export type SlackInstallStatus = 'connected' | 'needs_reauth' | 'disabled' | 'not_configured'

export type SlackInstallStartResponse = {
  authorizationUrl: string
  connectionId: string
  status: 'pending'
}

export type SlackInstallStatusResponse = {
  status: SlackInstallStatus
  readiness: {
    configured: boolean
    missingEnvVars: string[]
  }
  installationId?: string
  teamName?: string
  answeringAgentId?: string
}

export type SlackBinding = {
  channelId: string | null
  answeringAgentId: string | null
  escalationChannelId: string | null
  gapEscalationEnabled: boolean
}

export type SlackBindingUpdate = {
  channelId?: string | null
  answeringAgentId: string
  escalationChannelId?: string | null
  gapEscalationEnabled?: boolean
}

export type SlackManifestResponse = {
  manifest: Record<string, unknown>
  requiredEnvVars: string[]
}

const workspaceSlackPath = (workspaceId: string, suffix: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/slack/${suffix}`

export const slackApi = {
  async startInstall(workspaceId: string, _agentId: string): Promise<SlackInstallStartResponse> {
    void _agentId
    return request<SlackInstallStartResponse>(
      workspaceSlackPath(workspaceId, 'install/start'),
      { method: 'POST' },
      { withSession: true },
    )
  },

  async getInstallStatus(workspaceId: string, _agentId: string): Promise<SlackInstallStatusResponse> {
    void _agentId
    return request<SlackInstallStatusResponse>(
      workspaceSlackPath(workspaceId, 'install/status'),
      { method: 'GET' },
      { withSession: true },
    )
  },

  async getBinding(workspaceId: string, _agentId: string): Promise<SlackBinding> {
    void _agentId
    return request<SlackBinding>(
      workspaceSlackPath(workspaceId, 'binding'),
      { method: 'GET' },
      { withSession: true },
    )
  },

  async listBindings(workspaceId: string, _agentId: string): Promise<{ bindings: SlackBinding[] }> {
    void _agentId
    return request<{ bindings: SlackBinding[] }>(
      workspaceSlackPath(workspaceId, 'bindings'),
      { method: 'GET' },
      { withSession: true },
    )
  },

  async getManifest(workspaceId: string, _agentId: string): Promise<SlackManifestResponse> {
    void _agentId
    return request<SlackManifestResponse>(
      workspaceSlackPath(workspaceId, 'manifest'),
      { method: 'GET' },
      { withSession: true },
    )
  },

  async updateBinding(workspaceId: string, _agentId: string, input: SlackBindingUpdate): Promise<SlackBinding> {
    void _agentId
    return request<SlackBinding>(
      workspaceSlackPath(workspaceId, 'binding'),
      { method: 'PUT', body: JSON.stringify(input) },
      { withSession: true },
    )
  },

  async removeChannelBinding(workspaceId: string, _agentId: string, channelId: string): Promise<void> {
    void _agentId
    await request<void>(
      `${workspaceSlackPath(workspaceId, 'binding')}?channelId=${encodeURIComponent(channelId)}`,
      { method: 'DELETE' },
      { withSession: true },
    )
  },

  async disconnect(workspaceId: string, _agentId: string): Promise<void> {
    void _agentId
    await request<void>(
      workspaceSlackPath(workspaceId, 'installation'),
      { method: 'DELETE' },
      { withSession: true },
    )
  },
}
