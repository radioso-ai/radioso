import { request } from './api-client'
import type { AgentVoiceConnection, AgentVoiceDisconnection } from './api-types'

const connectionPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/voice/connection`

/**
 * The vendor agent Radioso creates and maintains for an agent's voice channel. Connect and
 * Disconnect issue and revoke an access grant, so both carry the CSRF header.
 */
export const agentVoiceConnectionApi = {
  status(agentId: string): Promise<AgentVoiceConnection> {
    return request<AgentVoiceConnection>(connectionPath(agentId), { method: 'GET' }, { withSession: true })
  },

  connect(agentId: string): Promise<AgentVoiceConnection> {
    return request<AgentVoiceConnection>(
      connectionPath(agentId),
      { method: 'POST', headers: { 'X-Radioso-CSRF': '1' } },
      { withSession: true },
    )
  },

  disconnect(agentId: string): Promise<AgentVoiceDisconnection> {
    return request<AgentVoiceDisconnection>(
      connectionPath(agentId),
      { method: 'DELETE', headers: { 'X-Radioso-CSRF': '1' } },
      { withSession: true },
    )
  },
}
