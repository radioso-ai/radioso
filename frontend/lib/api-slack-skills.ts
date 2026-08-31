import { request } from './api-client'

export type SlackSkillInputKey = 'channelId' | 'text' | 'threadTs'
export type SlackSkillOutcome = 'enqueued' | 'missing_input' | 'failed'

export type SlackSkillExposedInput = {
  description?: string
  slotBinding?: string
  required?: boolean
}

export type SlackSkillDefinition = {
  id: string
  workspaceId: string
  agentId: string
  installationId: string
  skillName: string
  boundInputs: Partial<Record<SlackSkillInputKey, unknown>>
  exposedInputs: Partial<Record<SlackSkillInputKey, SlackSkillExposedInput>>
  enabled: boolean
  outcomes: SlackSkillOutcome[]
  createdAt: string
  updatedAt: string
}

export type CreateSlackSkillInput = {
  skillName: string
  installationId: string
  boundInputs: Partial<Record<SlackSkillInputKey, unknown>>
  exposedInputs: Partial<Record<SlackSkillInputKey, SlackSkillExposedInput>>
  enabled?: boolean
}

export type UpdateSlackSkillInput = {
  boundInputs?: Partial<Record<SlackSkillInputKey, unknown>>
  exposedInputs?: Partial<Record<SlackSkillInputKey, SlackSkillExposedInput>>
  enabled?: boolean
}

export const slackSkillsApi = {
  async list(agentId: string): Promise<{ skills: SlackSkillDefinition[] }> {
    return request<{ skills: SlackSkillDefinition[] }>(
      `/agents/${agentId}/slack-skills`,
      { method: 'GET' },
      { withSession: true },
    )
  },

  async create(agentId: string, input: CreateSlackSkillInput): Promise<{ skill: SlackSkillDefinition }> {
    return request<{ skill: SlackSkillDefinition }>(
      `/agents/${agentId}/slack-skills`,
      { method: 'POST', body: JSON.stringify(input) },
      { withSession: true },
    )
  },

  async update(agentId: string, skillId: string, input: UpdateSlackSkillInput): Promise<{ skill: SlackSkillDefinition }> {
    return request<{ skill: SlackSkillDefinition }>(
      `/agents/${agentId}/slack-skills/${skillId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      { withSession: true },
    )
  },

  async delete(agentId: string, skillId: string): Promise<void> {
    await request<void>(
      `/agents/${agentId}/slack-skills/${skillId}`,
      { method: 'DELETE' },
      { withSession: true },
    )
  },
}
