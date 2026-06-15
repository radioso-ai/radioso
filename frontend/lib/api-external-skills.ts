import { request } from './api-client'
import type { DiscoveredMcpTool } from './external-skills'

export type McpConnectionStatus = 'unconfigured' | 'authorized' | 'needs_reauth' | 'error' | string
export type McpAuthMethod = 'access_token' | 'oauth'

export type McpConnection = {
  id: string
  displayName: string
  serverUrl: string
  authMethod: string
  status: McpConnectionStatus
  hasCredential: boolean
  createdAt: string
  updatedAt: string
}

export type ExternalSkillDefinition = {
  id: string
  connectionId: string
  skillName: string
  toolName: string
  boundParams: Record<string, unknown>
  exposedParams: Record<string, unknown>
  declaredOutcomes: string[] | null
  outcomeMap: Record<string, string> | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type CreateMcpConnectionInput = {
  displayName: string
  serverUrl: string
  authMethod: McpAuthMethod
  accessToken?: string
}

export type CreateExternalSkillInput = {
  skillName: string
  connectionId: string
  toolName: string
  boundParams?: Record<string, unknown>
  exposedParams?: Record<string, { description?: string; slotBinding?: string }>
  declaredOutcomes?: string[]
  enabled?: boolean
}

export const externalSkillsApi = {
  async listConnections(agentId: string): Promise<{ connections: McpConnection[] }> {
    return request<{ connections: McpConnection[] }>(`/agents/${agentId}/mcp-connections`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async createConnection(agentId: string, data: CreateMcpConnectionInput): Promise<McpConnection> {
    return request<McpConnection>(`/agents/${agentId}/mcp-connections`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async updateConnection(agentId: string, connectionId: string, data: {
    displayName?: string
    accessToken?: string
  }): Promise<McpConnection> {
    return request<McpConnection>(`/agents/${agentId}/mcp-connections/${connectionId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async deleteConnection(agentId: string, connectionId: string): Promise<void> {
    await request<void>(`/agents/${agentId}/mcp-connections/${connectionId}`, {
      method: 'DELETE',
    }, { withApiToken: true })
  },

  async discoverTools(agentId: string, connectionId: string): Promise<{ tools: DiscoveredMcpTool[] }> {
    return request<{ tools: DiscoveredMcpTool[] }>(`/agents/${agentId}/mcp-connections/${connectionId}/discover`, {
      method: 'POST',
    }, { withApiToken: true })
  },

  async listSkills(agentId: string): Promise<{ skills: ExternalSkillDefinition[] }> {
    return request<{ skills: ExternalSkillDefinition[] }>(`/agents/${agentId}/external-skills`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async createSkill(agentId: string, data: CreateExternalSkillInput): Promise<ExternalSkillDefinition> {
    return request<ExternalSkillDefinition>(`/agents/${agentId}/external-skills`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async updateSkill(agentId: string, skillId: string, data: {
    boundParams?: Record<string, unknown>
    exposedParams?: Record<string, { description?: string; slotBinding?: string }>
    declaredOutcomes?: string[]
    enabled?: boolean
  }): Promise<ExternalSkillDefinition> {
    return request<ExternalSkillDefinition>(`/agents/${agentId}/external-skills/${skillId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async deleteSkill(agentId: string, skillId: string): Promise<void> {
    await request<void>(`/agents/${agentId}/external-skills/${skillId}`, {
      method: 'DELETE',
    }, { withApiToken: true })
  },
}
