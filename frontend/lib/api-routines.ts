import {
  API_BASE,
  buildError,
  getStoredActiveWorkspaceId,
  request,
} from './api-client'
import type {
  RoutineDefinitionDraft,
  RoutineDefinitionGetResponse,
  RoutineDefinitionListResponse,
  RoutineDefinitionPublishRejectedResponse,
  RoutineDefinitionSaveResponse,
  RoutineDefinitionValidateResponse,
  RoutineDraftAssistRequest,
  RoutineDraftAssistResponse,
} from './api-types'

export class RoutinePublishRejectedError extends Error {
  constructor(readonly response: RoutineDefinitionPublishRejectedResponse) {
    super(response.error)
    this.name = 'RoutinePublishRejectedError'
  }
}

const requestRoutinePublish = async (agentId: string, routineId: string): Promise<RoutineDefinitionSaveResponse> => {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('X-Forwarded-Prefix', '/backend')
  const workspaceId = getStoredActiveWorkspaceId()
  if (workspaceId) headers.set('X-Workspace-Id', workspaceId)

  const executeFetch = () => fetch(`${API_BASE}/agents/${agentId}/routines/${routineId}/publish`, {
    method: 'POST',
    cache: 'no-store',
    headers,
    credentials: 'include',
  })

  const response = await executeFetch()

  if (response.status === 422) {
    throw new RoutinePublishRejectedError(await response.json() as RoutineDefinitionPublishRejectedResponse)
  }
  if (!response.ok) {
    throw await buildError(response)
  }
  return response.json() as Promise<RoutineDefinitionSaveResponse>
}

export const routinesApi = {
  async listRoutines(agentId: string): Promise<RoutineDefinitionListResponse> {
    return request<RoutineDefinitionListResponse>(`/agents/${agentId}/routines`, {
      method: 'GET',
    }, { withSession: true })
  },

  async getRoutine(agentId: string, routineId: string): Promise<RoutineDefinitionGetResponse> {
    return request<RoutineDefinitionGetResponse>(`/agents/${agentId}/routines/${routineId}`, {
      method: 'GET',
    }, { withSession: true })
  },

  async createRoutine(agentId: string, data: RoutineDefinitionDraft): Promise<RoutineDefinitionSaveResponse> {
    return request<RoutineDefinitionSaveResponse>(`/agents/${agentId}/routines`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async draftRoutineFromProcedure(
    agentId: string,
    data: RoutineDraftAssistRequest,
  ): Promise<RoutineDraftAssistResponse> {
    return request<RoutineDraftAssistResponse>(`/agents/${agentId}/routines/draft-assist`, {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async updateRoutine(
    agentId: string,
    routineId: string,
    data: RoutineDefinitionDraft,
  ): Promise<RoutineDefinitionSaveResponse> {
    return request<RoutineDefinitionSaveResponse>(`/agents/${agentId}/routines/${routineId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }, { withSession: true })
  },

  async validateRoutine(agentId: string, routineId: string): Promise<RoutineDefinitionValidateResponse> {
    return request<RoutineDefinitionValidateResponse>(`/agents/${agentId}/routines/${routineId}/validate`, {
      method: 'POST',
    }, { withSession: true })
  },

  async publishRoutine(agentId: string, routineId: string): Promise<RoutineDefinitionSaveResponse> {
    return requestRoutinePublish(agentId, routineId)
  },

  async reviseRoutine(agentId: string, routineId: string): Promise<RoutineDefinitionGetResponse> {
    return request<RoutineDefinitionGetResponse>(`/agents/${agentId}/routines/${routineId}/revise`, {
      method: 'POST',
    }, { withSession: true })
  },

  async archiveRoutine(agentId: string, routineId: string): Promise<RoutineDefinitionGetResponse> {
    return request<RoutineDefinitionGetResponse>(`/agents/${agentId}/routines/${routineId}/archive`, {
      method: 'POST',
    }, { withSession: true })
  },

  async restoreRoutine(agentId: string, routineId: string): Promise<RoutineDefinitionGetResponse> {
    return request<RoutineDefinitionGetResponse>(`/agents/${agentId}/routines/${routineId}/restore`, {
      method: 'POST',
    }, { withSession: true })
  },

  async deleteRoutine(agentId: string, routineId: string): Promise<void> {
    await request<void>(`/agents/${agentId}/routines/${routineId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },
}
