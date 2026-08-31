import { request } from './api-client'

export type SkillAuthoringInputType = 'text' | 'number' | 'boolean' | 'email' | 'date' | 'phone' | 'enum'
export type RoutineSkillCategory = 'retrieval' | 'built_in' | 'external_mcp' | 'customer_email' | 'webhook' | 'slack' | 'notify'

export interface SkillAuthoringInput {
  key: string
  type: SkillAuthoringInputType
  required: boolean
  description?: string
  enumValues?: string[]
}

export interface SkillAuthoringOutcome {
  name: string
  displayName: string
  description?: string
  status: string
}

export interface SkillAuthoringDescriptor {
  skillName: string
  displayName: string
  category: RoutineSkillCategory
  description?: string
  inputs: SkillAuthoringInput[]
  outcomes: SkillAuthoringOutcome[]
  hasDataOutputs: boolean
}

interface SkillAuthoringCatalogResponse {
  skills: SkillAuthoringDescriptor[]
}

const inputTypes: readonly SkillAuthoringInputType[] = ['text', 'number', 'boolean', 'email', 'date', 'phone', 'enum']
const skillCategories: readonly RoutineSkillCategory[] = ['retrieval', 'built_in', 'external_mcp', 'customer_email', 'webhook', 'slack', 'notify']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined

const inferSkillCategory = (skillName: string): RoutineSkillCategory => {
  if (skillName.startsWith('retrieval.')) return 'retrieval'
  if (skillName.startsWith('customer_email.')) return 'customer_email'
  return 'external_mcp'
}

const parseSkillCategory = (value: unknown, skillName: string): RoutineSkillCategory => {
  if (skillCategories.includes(value as RoutineSkillCategory)) {
    return value as RoutineSkillCategory
  }
  return inferSkillCategory(skillName)
}

const parseInput = (value: unknown): SkillAuthoringInput => {
  if (!isRecord(value)) {
    throw new Error('Skill catalog input must be an object.')
  }
  if (typeof value.key !== 'string' || value.key.trim().length === 0) {
    throw new Error('Skill catalog input is missing key.')
  }
  if (!inputTypes.includes(value.type as SkillAuthoringInputType)) {
    throw new Error(`Skill catalog input "${value.key}" has an unsupported type.`)
  }
  if (typeof value.required !== 'boolean') {
    throw new Error(`Skill catalog input "${value.key}" is missing required.`)
  }
  const input: SkillAuthoringInput = {
    key: value.key,
    type: value.type as SkillAuthoringInputType,
    required: value.required,
  }
  const description = optionalString(value.description)
  if (description) input.description = description
  if (value.type === 'enum') {
    if (value.enumValues !== undefined && (!Array.isArray(value.enumValues) || !value.enumValues.every((item) => typeof item === 'string'))) {
      throw new Error(`Skill catalog input "${value.key}" has invalid enum values.`)
    }
    if (Array.isArray(value.enumValues)) input.enumValues = value.enumValues
  }
  return input
}

const parseOutcome = (value: unknown): SkillAuthoringOutcome => {
  if (!isRecord(value)) {
    throw new Error('Skill catalog outcome must be an object.')
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error('Skill catalog outcome is missing name.')
  }
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
    throw new Error(`Skill catalog outcome "${value.name}" is missing displayName.`)
  }
  if (typeof value.status !== 'string' || value.status.trim().length === 0) {
    throw new Error(`Skill catalog outcome "${value.name}" is missing status.`)
  }
  const outcome: SkillAuthoringOutcome = {
    name: value.name,
    displayName: value.displayName,
    status: value.status,
  }
  const description = optionalString(value.description)
  if (description) outcome.description = description
  return outcome
}

export const parseSkillAuthoringCatalogResponse = (payload: unknown): SkillAuthoringDescriptor[] => {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) {
    throw new Error('Skill catalog response must include skills.')
  }
  return payload.skills.map((value) => {
    if (!isRecord(value)) {
      throw new Error('Skill catalog descriptor must be an object.')
    }
    if (typeof value.skillName !== 'string' || value.skillName.trim().length === 0) {
      throw new Error('Skill catalog descriptor is missing skillName.')
    }
    if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
      throw new Error(`Skill catalog descriptor "${value.skillName}" is missing displayName.`)
    }
    const category = parseSkillCategory(value.category, value.skillName)
    if (!Array.isArray(value.inputs)) {
      throw new Error(`Skill catalog descriptor "${value.skillName}" is missing inputs.`)
    }
    if (!Array.isArray(value.outcomes)) {
      throw new Error(`Skill catalog descriptor "${value.skillName}" is missing outcomes.`)
    }
    if (typeof value.hasDataOutputs !== 'boolean') {
      throw new Error(`Skill catalog descriptor "${value.skillName}" is missing hasDataOutputs.`)
    }
    const description = optionalString(value.description)
    return {
      skillName: value.skillName,
      displayName: value.displayName,
      category,
      ...(description ? { description } : {}),
      inputs: value.inputs.map(parseInput),
      outcomes: value.outcomes.map(parseOutcome),
      hasDataOutputs: value.hasDataOutputs,
    }
  })
}

export const routineSkillCatalogApi = {
  async listRoutineSkillCatalog(agentId: string): Promise<SkillAuthoringDescriptor[]> {
    const payload = await request<SkillAuthoringCatalogResponse>(`/agents/${agentId}/routine-skill-catalog`, {
      method: 'GET',
    }, { withSession: true })
    return parseSkillAuthoringCatalogResponse(payload)
  },
}
