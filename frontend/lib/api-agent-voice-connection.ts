import { request } from './api-client'
import type { AgentVoiceConnection, AgentVoiceDisconnection } from './api-types'

const connectionPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/voice/connection`

/**
 * The vendor agent Radioso creates and maintains for an agent's voice channel, and the switch that
 * turns the channel on or off. Connect, Disconnect and switching on (which connects when nothing is
 * bound) issue or revoke an access grant, so each carries the CSRF header.
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

  /** Turns voice on or off; on with no runtime bound, the backend connects first, in the same write. */
  switchChannel(agentId: string, enabled: boolean): Promise<AgentVoiceConnection> {
    return request<AgentVoiceConnection>(
      `/agents/${encodeURIComponent(agentId)}/voice/channel`,
      { method: 'PUT', headers: { 'X-Radioso-CSRF': '1' }, body: JSON.stringify({ enabled }) },
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
