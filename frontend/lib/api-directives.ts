import { request } from './api-client'
import type {
  DirectiveCreateRequest,
  DirectiveDraftRequest,
  DirectiveDraftResponse,
  DirectiveListResponse,
  DirectiveMutationResponse,
  DirectiveUpdateRequest,
} from './api-types'

export const directivesApi = {
  async listDirectives(agentId: string): Promise<DirectiveListResponse> {
    return request<DirectiveListResponse>(`/agents/${agentId}/directives`, {
      method: 'GET',
    }, { withSession: true })
  },

  async createDirective(agentId: string, data: DirectiveCreateRequest): Promise<DirectiveMutationResponse> {
    return request<DirectiveMutationResponse>(`/agents/${agentId}/directives`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async draftDirective(agentId: string, data: DirectiveDraftRequest): Promise<DirectiveDraftResponse> {
    return request<DirectiveDraftResponse>(`/agents/${agentId}/directives/draft`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async updateDirective(
    agentId: string,
    directiveId: string,
    data: DirectiveUpdateRequest,
  ): Promise<DirectiveMutationResponse> {
    return request<DirectiveMutationResponse>(`/agents/${agentId}/directives/${directiveId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async deleteDirective(agentId: string, directiveId: string): Promise<void> {
    await request<void>(`/agents/${agentId}/directives/${directiveId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },
}
