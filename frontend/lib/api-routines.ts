import { request } from './api-client'
import type {
  RoutineDefinitionDraft,
  RoutineDefinitionGetResponse,
  RoutineDefinitionListResponse,
  RoutineDefinitionSaveResponse,
  RoutineDefinitionUpdate,
  RoutineDefinitionValidateResponse,
  RoutineDraftAssistRequest,
  RoutineDraftAssistResponse,
} from './api-types'

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
    data: RoutineDefinitionUpdate,
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

  async deleteRoutine(agentId: string, routineId: string): Promise<void> {
    await request<void>(`/agents/${agentId}/routines/${routineId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },
}
