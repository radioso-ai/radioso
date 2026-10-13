import { request } from './api-client'
import type {
  Workspace,
  WorkspaceRouteResolutionResponse,
  WorkspaceSummaryResponse as WorkspaceSummaryResponseApi,
} from './api-types'

type WorkspaceSetupStep = 'purpose' | 'documents' | 'conversation' | 'directives_or_routines' | 'notify_destination' | 'credential'

interface WorkspaceSetupState {
  purpose: string | null
  dismissed: boolean
  skippedSteps: WorkspaceSetupStep[]
  shouldShowFirstRun: boolean
  hasDirectivesOrRoutines: boolean
  hasNotifyDestination: boolean
  hasNotifyDeliveryConfirmed: boolean
  hasCredential: boolean
}

type WorkspaceSummaryResponse = WorkspaceSummaryResponseApi & { setup?: WorkspaceSetupState }

export const workspaceApi = {
  async list(): Promise<Workspace[]> {
    const response = await request<{ workspaces: Workspace[] }>("/workspace", {
      method: "GET",
    }, { withSession: true })
    return response.workspaces
  },

  async create(name: string): Promise<Workspace> {
    return request<Workspace>("/workspace", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, { withSession: true })
  },

  async rename(workspaceId: string, name: string): Promise<Workspace> {
    return request<Workspace>(`/workspace/${workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }, { withSession: true })
  },

  async delete(workspaceId: string): Promise<void> {
    await request<void>(`/workspace/${workspaceId}`, {
      method: "DELETE",
    }, { withSession: true })
  },

  async resolve(workspaceKey: string): Promise<WorkspaceRouteResolutionResponse> {
    return request<WorkspaceRouteResolutionResponse>(`/workspace/resolve/${encodeURIComponent(workspaceKey)}`, {
      method: "GET",
    }, { withSession: true })
  },

  async getSummary(): Promise<WorkspaceSummaryResponse> {
    return request<WorkspaceSummaryResponse>("/workspace/summary", {
      method: "GET",
    }, { withSession: true })
  },

  async getSetupState(): Promise<WorkspaceSetupState> {
    return request<WorkspaceSetupState>("/workspace/setup-state", { method: "GET" }, { withSession: true })
  },

  async updateSetupState(input: Partial<Pick<WorkspaceSetupState, 'purpose' | 'dismissed' | 'skippedSteps'>>): Promise<WorkspaceSetupState> {
    return request<WorkspaceSetupState>("/workspace/setup-state", {
      method: "PATCH",
      body: JSON.stringify(input),
    }, { withSession: true })
  },
}
