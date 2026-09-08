import { request } from './api-client'
import type { AgentBundle, AgentBundleImportResponse } from './agent-bundle'

export const agentBundleApi = {
  async exportBundle(agentId: string): Promise<AgentBundle> {
    return request<AgentBundle>(`/agents/${agentId}/bundle`, { method: 'GET' }, { withSession: true })
  },

  async importBundle(bundle: AgentBundle): Promise<AgentBundleImportResponse> {
    return request<AgentBundleImportResponse>('/agents/bundle', {
      method: 'POST',
      body: JSON.stringify(bundle),
    }, { withSession: true })
  },
}
