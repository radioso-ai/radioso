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
  answeringAgentId: string | null
  escalationChannelId: string | null
  gapEscalationEnabled: boolean
}

export type SlackBindingUpdate = {
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
    return request<SlackInstallStartResponse>(
      workspaceSlackPath(workspaceId, 'install/start'),
      { method: 'POST' },
      { withApiToken: true },
    )
  },

  async getInstallStatus(workspaceId: string, _agentId: string): Promise<SlackInstallStatusResponse> {
    return request<SlackInstallStatusResponse>(
      workspaceSlackPath(workspaceId, 'install/status'),
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async getBinding(workspaceId: string, _agentId: string): Promise<SlackBinding> {
    return request<SlackBinding>(
      workspaceSlackPath(workspaceId, 'binding'),
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async getManifest(workspaceId: string, _agentId: string): Promise<SlackManifestResponse> {
    return request<SlackManifestResponse>(
      workspaceSlackPath(workspaceId, 'manifest'),
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async updateBinding(workspaceId: string, _agentId: string, input: SlackBindingUpdate): Promise<SlackBinding> {
    return request<SlackBinding>(
      workspaceSlackPath(workspaceId, 'binding'),
      { method: 'PUT', body: JSON.stringify(input) },
      { withApiToken: true },
    )
  },

  async disconnect(workspaceId: string, _agentId: string): Promise<void> {
    await request<void>(
      workspaceSlackPath(workspaceId, 'installation'),
      { method: 'DELETE' },
      { withApiToken: true },
    )
  },
}
