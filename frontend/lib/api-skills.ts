import { request } from './api-client'

export type SkillOutcomeStatus =
  | 'active'
  | 'paused'
  | 'awaiting_confirmation'
  | 'awaiting_tool'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed'

export type SkillOutcomeTone = 'positive' | 'neutral' | 'info' | 'warning' | 'muted'

export interface SkillOutcomeDefinition {
  name: string
  displayName: string
  description?: string
  status: SkillOutcomeStatus
  groundedAnswer?: boolean
  tone?: SkillOutcomeTone
}

export interface SkillCatalogEntry {
  name: string
  displayName: string
  description: string
  outcomes?: SkillOutcomeDefinition[]
}

export interface SkillCatalogResponse {
  skills: SkillCatalogEntry[]
}

export const skillsApi = {
  async list(): Promise<SkillCatalogResponse> {
    return request<SkillCatalogResponse>('/skills', { method: 'GET' }, { withApiToken: true })
  },
}
