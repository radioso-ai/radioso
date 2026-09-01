import { request } from './api-client'
import { withQuery } from './api-query'

export type AgentChannelCredentialAudience = 'mcp' | 'rest'

export interface AgentChannelCredential {
  id: string
  audience: AgentChannelCredentialAudience
  label: string
  prefix: string
  status: 'active' | 'expired' | 'revoked' | 'disabled'
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface IssuedAgentChannelCredential {
  credential: AgentChannelCredential
  secret: string
}

export interface AgentChannelCredentialPage {
  credentials: AgentChannelCredential[]
  nextCursor: string | null
}

const credentialPath = (agentId: string) =>
  `/agents/${encodeURIComponent(agentId)}/channel-credentials`

export const agentChannelCredentialsApi = {
  list(agentId: string, audience: AgentChannelCredentialAudience, options: { cursor?: string; limit?: number } = {}): Promise<AgentChannelCredentialPage> {
    return request<AgentChannelCredentialPage>(
      withQuery(credentialPath(agentId), { audience, ...options }),
      { method: 'GET' },
      { withSession: true },
    )
  },

  issue(
    agentId: string,
    input: { audience: AgentChannelCredentialAudience; label: string; expiresAt: string },
  ): Promise<IssuedAgentChannelCredential> {
    return request<IssuedAgentChannelCredential>(credentialPath(agentId), {
      method: 'POST',
      headers: { 'X-Radioso-CSRF': '1' },
      body: JSON.stringify(input),
    }, { withSession: true })
  },

  rotate(agentId: string, credentialId: string): Promise<IssuedAgentChannelCredential> {
    return request<IssuedAgentChannelCredential>(
      `${credentialPath(agentId)}/${encodeURIComponent(credentialId)}/rotate`,
      { method: 'POST', headers: { 'X-Radioso-CSRF': '1' } },
      { withSession: true },
    )
  },

  async revoke(agentId: string, credentialId: string): Promise<void> {
    await request<void>(
      `${credentialPath(agentId)}/${encodeURIComponent(credentialId)}/revoke`,
      { method: 'POST', headers: { 'X-Radioso-CSRF': '1' } },
      { withSession: true },
    )
  },
}
