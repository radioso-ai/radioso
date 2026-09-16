import { request } from './api-client'
import type { AgentGreetingDraft, AgentGreetingDraftResponse } from './api-types'

/**
 * Exact greeting content (spec 1150 Slice A). Mirrors `directivesApi`'s draft-save shape:
 * a single PUT that always returns 200 with field-level `validation.issues` unless Exact
 * words is enabled and the content fails validation, in which case the backend responds
 * 400 and `request()` throws an `ApiError` whose `error.details` carries the same issues.
 */
export const agentGreetingApi = {
  async saveDraft(agentId: string, data: AgentGreetingDraft): Promise<AgentGreetingDraftResponse> {
    return request<AgentGreetingDraftResponse>(`/agents/${agentId}/greeting/draft`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }, { withSession: true })
  },
}
