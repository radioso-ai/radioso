import { request } from './api-client'

export type McpConverseGrant = {
  id: string
  label: string | null
  tokenPrefix: string
  enabled: boolean
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type McpConverseGrantWithToken = {
  grant: Omit<McpConverseGrant, 'enabled' | 'lastUsedAt' | 'revokedAt'> & Partial<Pick<McpConverseGrant, 'enabled' | 'lastUsedAt' | 'revokedAt'>>
  token: string
}

export const mcpConverseGrantsApi = {
  async list(agentId: string): Promise<{ grants: McpConverseGrant[] }> {
    return request<{ grants: McpConverseGrant[] }>(
      `/agents/${agentId}/mcp-converse-grants`,
      { method: 'GET' },
      { withSession: true },
    )
  },

  async create(agentId: string, data: { label?: string }): Promise<McpConverseGrantWithToken> {
    return request<McpConverseGrantWithToken>(
      `/agents/${agentId}/mcp-converse-grants`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
      { withSession: true },
    )
  },

  async rotate(agentId: string, grantId: string): Promise<McpConverseGrantWithToken> {
    return request<McpConverseGrantWithToken>(
      `/agents/${agentId}/mcp-converse-grants/${grantId}/rotate`,
      { method: 'POST' },
      { withSession: true },
    )
  },

  async revoke(agentId: string, grantId: string): Promise<void> {
    await request<void>(
      `/agents/${agentId}/mcp-converse-grants/${grantId}`,
      { method: 'DELETE' },
      { withSession: true },
    )
  },
}
