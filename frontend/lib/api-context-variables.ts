import { request } from './api-client'
import type {
  AgentContextVariableEnablementListResponse,
  AgentContextVariableEnablementRequest,
  AgentContextVariableEnablementResponse,
  ContextVariableCreateRequest,
  ContextVariableListResponse,
  ContextVariableResponse,
  ContextVariableUpdateRequest,
} from './api-types'

export const contextVariablesApi = {
  async listCatalog(): Promise<ContextVariableListResponse> {
    return request<ContextVariableListResponse>('/context-variables', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async createCatalogVariable(data: ContextVariableCreateRequest): Promise<ContextVariableResponse> {
    return request<ContextVariableResponse>('/context-variables', {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async updateCatalogVariable(variableId: string, data: ContextVariableUpdateRequest): Promise<ContextVariableResponse> {
    return request<ContextVariableResponse>(`/context-variables/${encodeURIComponent(variableId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async deleteCatalogVariable(variableId: string): Promise<void> {
    await request<void>(`/context-variables/${encodeURIComponent(variableId)}`, {
      method: 'DELETE',
    }, { withApiToken: true })
  },

  async listAgentEnablements(agentId: string): Promise<AgentContextVariableEnablementListResponse> {
    return request<AgentContextVariableEnablementListResponse>(
      `/agents/${encodeURIComponent(agentId)}/context-variables`,
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async upsertAgentEnablement(
    agentId: string,
    variableId: string,
    data: AgentContextVariableEnablementRequest,
  ): Promise<AgentContextVariableEnablementResponse> {
    return request<AgentContextVariableEnablementResponse>(
      `/agents/${encodeURIComponent(agentId)}/context-variables/${encodeURIComponent(variableId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      },
      { withApiToken: true },
    )
  },

  async deleteAgentEnablement(agentId: string, variableId: string): Promise<void> {
    await request<void>(
      `/agents/${encodeURIComponent(agentId)}/context-variables/${encodeURIComponent(variableId)}`,
      { method: 'DELETE' },
      { withApiToken: true },
    )
  },
}
