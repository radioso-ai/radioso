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

export type CustomerEmailSkillMode = 'draft' | 'send'
export type CustomerEmailSkillOutcome =
  | 'drafted'
  | 'sent'
  | 'missing_input'
  | 'disabled_connection'
  | 'needs_reauth'
  | 'provider_rejected'
  | 'failed'

export type CustomerEmailExposedInput = {
  description?: string
  slotBinding?: string
}

export type CustomerEmailSkillDefinition = {
  id: string
  workspaceId: string
  agentId: string
  connectionId: string
  skillName: string
  mode: CustomerEmailSkillMode
  boundInputs: Record<string, unknown>
  exposedInputs: Record<string, CustomerEmailExposedInput>
  enabled: boolean
  outcomes: CustomerEmailSkillOutcome[]
  createdAt: string
  updatedAt: string
}

export type CustomerEmailRecipientSummary = {
  toCount: number
  ccCount: number
  domains: string[]
  redactedRecipients: string[]
}

export type CustomerEmailActivity = {
  id: string
  workspaceId: string
  agentId: string
  routineId: string | null
  conversationId: string | null
  skillDefinitionId: string
  connectionId: string
  skillName: string
  mode: CustomerEmailSkillMode
  outcome: CustomerEmailSkillOutcome
  recipientSummary: CustomerEmailRecipientSummary
  providerMessageId: string | null
  errorCode: string | null
  createdAt: string
}

export type CustomerEmailActivityQuery = {
  agentId?: string
  connectionId?: string
  skillDefinitionId?: string
  outcome?: CustomerEmailSkillOutcome
  createdFrom?: string
  createdTo?: string
  limit?: number
}

export type CreateCustomerEmailSkillInput = {
  skillName: string
  connectionId: string
  mode: CustomerEmailSkillMode
  boundInputs: Record<string, unknown>
  exposedInputs: Record<string, CustomerEmailExposedInput>
  enabled?: boolean
}

export type UpdateCustomerEmailSkillInput = {
  mode?: CustomerEmailSkillMode
  boundInputs?: Record<string, unknown>
  exposedInputs?: Record<string, CustomerEmailExposedInput>
  enabled?: boolean
}

export const customerEmailApi = {
  async startOauth(
    workspaceId: string,
    input: CreateWorkspaceOauthConnectionInput,
  ): Promise<WorkspaceOauthAuthorization> {
    return request<WorkspaceOauthAuthorization>(
      `/workspaces/${workspaceId}/oauth-connections`,
      { method: 'POST', body: JSON.stringify(input) },
      { withSession: true },
    )
  },

  async getOauthConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ connection: WorkspaceOauthConnection }> {
    return request<{ connection: WorkspaceOauthConnection }>(
      `/workspaces/${workspaceId}/oauth-connections/${connectionId}`,
      { method: 'GET' },
      { withSession: true },
    )
  },

  // OAuth connections eligible to back a customer email connection. The backend
  // owns which providers count as email, so this never enumerates provider IDs.
  async listOauthConnections(workspaceId: string): Promise<{ connections: WorkspaceOauthConnection[] }> {
    return request<{ connections: WorkspaceOauthConnection[] }>(
      `/workspaces/${workspaceId}/email-oauth-connections`,
      { method: 'GET' },
      { withSession: true },
    )
  },

  async reauthorizeOauth(
    workspaceId: string,
    connectionId: string,
  ): Promise<WorkspaceOauthAuthorization> {
    return request<WorkspaceOauthAuthorization>(
      `/workspaces/${workspaceId}/oauth-connections/${connectionId}/reauthorize`,
      { method: 'POST' },
      { withSession: true },
    )
  },

  async listEmailConnections(workspaceId: string): Promise<{ connections: CustomerEmailConnection[] }> {
    return request<{ connections: CustomerEmailConnection[] }>(
      `/workspaces/${workspaceId}/email-connections`,
      { method: 'GET' },
      { withSession: true },
    )
  },

  async createEmailConnection(
    workspaceId: string,
    input: CreateCustomerEmailConnectionInput,
  ): Promise<{ connection: CustomerEmailConnection }> {
    return request<{ connection: CustomerEmailConnection }>(
      `/workspaces/${workspaceId}/email-connections`,
      { method: 'POST', body: JSON.stringify(input) },
      { withSession: true },
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
      { withSession: true },
    )
  },

  async checkEmailConnectionHealth(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ connection: CustomerEmailConnection }> {
    return request<{ connection: CustomerEmailConnection }>(
      `/workspaces/${workspaceId}/email-connections/${connectionId}/health-check`,
      { method: 'POST' },
      { withSession: true },
    )
  },

  async deleteEmailConnection(workspaceId: string, connectionId: string): Promise<void> {
    await request<void>(
      `/workspaces/${workspaceId}/email-connections/${connectionId}`,
      { method: 'DELETE' },
      { withSession: true },
    )
  },

  async listEmailSkills(agentId: string): Promise<{ skills: CustomerEmailSkillDefinition[] }> {
    return request<{ skills: CustomerEmailSkillDefinition[] }>(
      `/agents/${agentId}/email-skills`,
      { method: 'GET' },
      { withSession: true },
    )
  },

  async createEmailSkill(
    agentId: string,
    input: CreateCustomerEmailSkillInput,
  ): Promise<{ skill: CustomerEmailSkillDefinition }> {
    return request<{ skill: CustomerEmailSkillDefinition }>(
      `/agents/${agentId}/email-skills`,
      { method: 'POST', body: JSON.stringify(input) },
      { withSession: true },
    )
  },

  async updateEmailSkill(
    agentId: string,
    skillId: string,
    input: UpdateCustomerEmailSkillInput,
  ): Promise<{ skill: CustomerEmailSkillDefinition }> {
    return request<{ skill: CustomerEmailSkillDefinition }>(
      `/agents/${agentId}/email-skills/${skillId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      { withSession: true },
    )
  },

  async deleteEmailSkill(agentId: string, skillId: string): Promise<void> {
    await request<void>(
      `/agents/${agentId}/email-skills/${skillId}`,
      { method: 'DELETE' },
      { withSession: true },
    )
  },

  async listEmailActivity(
    workspaceId: string,
    query: CustomerEmailActivityQuery = {},
  ): Promise<{ activities: CustomerEmailActivity[] }> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value))
      }
    }
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return request<{ activities: CustomerEmailActivity[] }>(
      `/workspaces/${workspaceId}/email-skill-activity${suffix}`,
      { method: 'GET' },
      { withSession: true },
    )
  },
}
