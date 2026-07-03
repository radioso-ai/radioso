import { request } from './api-client'
import type { components } from '../../typescript-sdk/src/generated/types'

type ApiSchemas = components['schemas']

export type SkillCatalogEntry = ApiSchemas['SkillCatalogEntry']
export type SkillCatalogResponse = ApiSchemas['SkillCatalogResponse']
export type SkillDisplayMetadata = NonNullable<SkillCatalogEntry['display']>
export type SkillOwner = SkillCatalogEntry['owner']
export type SkillOutcomeDefinition = NonNullable<SkillCatalogEntry['outcomes']>[number]
export type SkillOutcomeStatus = SkillOutcomeDefinition['status']
export type SkillOutcomeTone = NonNullable<SkillOutcomeDefinition['tone']>

export const skillsApi = {
  async list(): Promise<SkillCatalogResponse> {
    return request<SkillCatalogResponse>('/skills', { method: 'GET' }, { withApiToken: true })
  },
}

export type AgentSkillInvocationMode = 'default_answer' | 'routine_named' | 'agent_selectable'
export type AgentSkillCapabilityId =
  | 'retrieve'
  | 'mcp_tool'
  | 'email'
  | 'slack_post'
  | 'webhook_call'
  | 'notify'

export type AgentSkillTarget = {
  kind: string
  id: string | null
}

export type AgentSkill = {
  id: string
  workspaceId: string
  agentId: string
  name: string
  capability: AgentSkillCapabilityId
  storedKind: string
  target: AgentSkillTarget
  config: Record<string, unknown>
  invocationMode: AgentSkillInvocationMode
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type SkillCapabilityInputSchema =
  | { source: 'discovered' }
  | { source: 'static'; schema: Record<string, unknown> }

export type SkillCapabilityTarget = {
  id: string
  label: string
  status?: string
}

export type SkillCapabilitySettingsField = {
  key: string
  label: string
  type: 'boolean' | 'number' | 'text' | 'textarea' | 'select' | 'string_list' | 'source_scope'
  help?: string
  defaultValue?: boolean | number | string
  dependsOnKey?: string
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  group?: string
  advanced?: boolean
}

export type SkillCapabilityDescriptor = {
  id: AgentSkillCapabilityId
  storedKind: string
  targetKind: string
  requiresTarget: boolean
  inputSchema: SkillCapabilityInputSchema
  settingsFields: SkillCapabilitySettingsField[]
  outcomeVocabulary: string[]
  supportedInvocationModes: AgentSkillInvocationMode[]
  defaultInvocationMode?: AgentSkillInvocationMode
  executorAdapter: string
  targets: SkillCapabilityTarget[]
  available: boolean
  unavailableReason: 'no_connection' | string | null
}

export type AgentSkillCreateInput = {
  name: string
  capability: AgentSkillCapabilityId
  target: AgentSkillTarget
  config: Record<string, unknown>
  invocationMode: AgentSkillInvocationMode
  enabled: boolean
}

export type AgentSkillUpdateInput = {
  target?: AgentSkillTarget
  config?: Record<string, unknown>
  replaceConfig?: Record<string, unknown>
  invocationMode?: AgentSkillInvocationMode
  enabled?: boolean
}

export const agentSkillsApi = {
  async getSkillCapabilities(agentId: string): Promise<{ capabilities: SkillCapabilityDescriptor[] }> {
    return request<{ capabilities: SkillCapabilityDescriptor[] }>(
      `/agents/${agentId}/skill-capabilities`,
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async listSkills(agentId: string): Promise<{ skills: AgentSkill[] }> {
    return request<{ skills: AgentSkill[] }>(
      `/agents/${agentId}/skills`,
      { method: 'GET' },
      { withApiToken: true },
    )
  },

  async createSkill(agentId: string, input: AgentSkillCreateInput): Promise<{ skill: AgentSkill }> {
    return request<{ skill: AgentSkill }>(
      `/agents/${agentId}/skills`,
      { method: 'POST', body: JSON.stringify(input) },
      { withApiToken: true },
    )
  },

  async updateSkill(agentId: string, skillId: string, input: AgentSkillUpdateInput): Promise<{ skill: AgentSkill }> {
    return request<{ skill: AgentSkill }>(
      `/agents/${agentId}/skills/${skillId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      { withApiToken: true },
    )
  },

  async deleteSkill(agentId: string, skillId: string): Promise<void> {
    await request<void>(
      `/agents/${agentId}/skills/${skillId}`,
      { method: 'DELETE' },
      { withApiToken: true },
    )
  },
}
