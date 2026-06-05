import { request } from './api-client'
import type {
  DirectiveCreateRequest,
  DirectiveListResponse,
  DirectiveMutationResponse,
  DirectiveUpdateRequest,
} from './api-types'

export const directivesApi = {
  async listDirectives(agentId: string): Promise<DirectiveListResponse> {
    return request<DirectiveListResponse>(`/agents/${agentId}/directives`, {
      method: 'GET',
    }, { withApiToken: true })
  },

  async createDirective(agentId: string, data: DirectiveCreateRequest): Promise<DirectiveMutationResponse> {
    return request<DirectiveMutationResponse>(`/agents/${agentId}/directives`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async updateDirective(
    agentId: string,
    directiveId: string,
    data: DirectiveUpdateRequest,
  ): Promise<DirectiveMutationResponse> {
    return request<DirectiveMutationResponse>(`/agents/${agentId}/directives/${directiveId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async deleteDirective(agentId: string, directiveId: string): Promise<void> {
    await request<void>(`/agents/${agentId}/directives/${directiveId}`, {
      method: 'DELETE',
    }, { withApiToken: true })
  },
}
