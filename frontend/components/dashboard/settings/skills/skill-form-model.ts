import type {
  AgentSkill,
  AgentSkillCapabilityId,
  AgentSkillCreateInput,
  AgentSkillInvocationMode,
  SkillCapabilityDescriptor,
} from '@/lib/api-skills'
import { getToolInputFields, normalizeSkillName, parseBoundParamValue, type ToolInputField } from '@/lib/external-skills'

export type SkillInputMode = 'bind' | 'expose' | 'ignore'

export type SkillInputDraft = {
  mode: SkillInputMode
  boundValue: string
  description: string
  slotBinding: string
}

export type SkillFormDraft = {
  capabilityId: AgentSkillCapabilityId | ''
  targetId: string
  name: string
  invocationMode: AgentSkillInvocationMode
  enabled: boolean
  toolName: string
  inputDrafts: Record<string, SkillInputDraft>
  selectedOutcomes: string[]
  extraConfigJson: string
}

export type DerivedSkillField = ToolInputField

const DEFAULT_OUTCOMES = ['completed', 'failed']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const stringFieldsFromDescriptor = (capability: SkillCapabilityDescriptor): string[] => {
  if (capability.inputSchema.source !== 'static') {
    return []
  }
  const rawFields = capability.inputSchema.schema.fields
  return Array.isArray(rawFields) ? rawFields.filter((field): field is string => typeof field === 'string') : []
}

export const deriveSkillFields = (capability: SkillCapabilityDescriptor, discoveredSchema?: unknown): DerivedSkillField[] => {
  if (capability.inputSchema.source === 'discovered') {
    return getToolInputFields(discoveredSchema)
  }

  return stringFieldsFromDescriptor(capability).map((name) => ({
    name,
    type: 'string',
    description: null,
    required: true,
  }))
}

export const createInputDrafts = (
  fields: readonly DerivedSkillField[],
  existingConfig?: Record<string, unknown>,
): Record<string, SkillInputDraft> => {
  const bound = findFirstRecord(existingConfig, ['boundInputs', 'boundParams', 'boundPayload'])
  const exposed = findFirstRecord(existingConfig, ['exposedInputs', 'exposedParams', 'exposedPayload'])

  return Object.fromEntries(fields.map((field) => {
    const exposedValue = exposed[field.name]
    const exposedRecord = isRecord(exposedValue) ? exposedValue : {}
    const hasBound = Object.prototype.hasOwnProperty.call(bound, field.name)
    const hasExposed = Object.prototype.hasOwnProperty.call(exposed, field.name)

    return [field.name, {
      mode: hasBound ? 'bind' : hasExposed || field.required ? 'expose' : 'ignore',
      boundValue: hasBound ? stringifyBoundValue(bound[field.name]) : defaultBoundValue(field),
      description: typeof exposedRecord.description === 'string' ? exposedRecord.description : '',
      slotBinding: typeof exposedRecord.slotBinding === 'string' ? exposedRecord.slotBinding : field.name,
    }]
  }))
}

export const createInitialSkillDraft = (
  capabilities: readonly SkillCapabilityDescriptor[],
  existingSkill?: AgentSkill | null,
): SkillFormDraft => {
  const availableCapability = capabilities.find((capability) => capability.available) ?? capabilities[0]
  const capability = existingSkill
    ? capabilities.find((candidate) => candidate.id === existingSkill.capability) ?? availableCapability
    : availableCapability

  const fields = capability ? deriveSkillFields(capability) : []
  const targetId = existingSkill?.target.id ?? capability?.targets[0]?.id ?? ''

  return {
    capabilityId: capability?.id ?? '',
    targetId,
    name: existingSkill?.name ?? '',
    invocationMode: existingSkill?.invocationMode ?? capability?.supportedInvocationModes[0] ?? 'routine_named',
    enabled: existingSkill?.enabled ?? true,
    toolName: typeof existingSkill?.config.toolName === 'string' ? existingSkill.config.toolName : '',
    inputDrafts: createInputDrafts(fields, existingSkill?.config),
    selectedOutcomes: readOutcomeList(existingSkill?.config, capability?.outcomeVocabulary ?? DEFAULT_OUTCOMES),
    extraConfigJson: existingSkill ? JSON.stringify(stripDerivedConfig(existingSkill.config), null, 2) : '{}',
  }
}

export const validateSkillName = (
  name: string,
  existingSkills: readonly AgentSkill[],
  editingSkillId?: string | null,
): string | null => {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'Enter a skill name.'
  }
  if (!/^[a-z][a-z0-9_]{1,79}$/u.test(trimmed)) {
    return 'Use a lowercase routine identifier: letters, numbers, underscores, starting with a letter.'
  }
  const duplicate = existingSkills.some((skill) => skill.id !== editingSkillId && skill.name === trimmed)
  return duplicate ? `@${trimmed} is already used by this agent.` : null
}

export const buildAgentSkillInput = (
  capability: SkillCapabilityDescriptor,
  draft: SkillFormDraft,
  fields: readonly DerivedSkillField[],
): AgentSkillCreateInput => {
  const extraConfig = parseExtraConfig(draft.extraConfigJson)
  const inputConfig = buildInputConfig(capability, draft, fields)
  const outcomes = buildOutcomeConfig(capability, draft.selectedOutcomes)

  return {
    name: normalizeSkillName(draft.name),
    capability: capability.id,
    target: {
      kind: capability.targetKind,
      id: draft.targetId || null,
    },
    config: {
      ...defaultConfigForTargetKind(capability),
      ...extraConfig,
      ...inputConfig,
      ...outcomes,
    },
    invocationMode: draft.invocationMode,
    enabled: draft.enabled,
  }
}

export const formatCapabilityLabel = (value: string): string =>
  value.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')

export const formatInvocationMode = (value: AgentSkillInvocationMode): string =>
  value.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')

const findFirstRecord = (config: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> => {
  for (const key of keys) {
    const value = config?.[key]
    if (isRecord(value)) {
      return value
    }
  }
  return {}
}

const stringifyBoundValue = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

const defaultBoundValue = (field: DerivedSkillField): string => {
  if (field.type === 'boolean') return 'false'
  if (field.type === 'number') return '0'
  if (field.type === 'array') return '[]'
  if (field.type === 'object') return '{}'
  return ''
}

const readOutcomeList = (
  config: Record<string, unknown> | undefined,
  fallback: readonly string[],
): string[] => {
  const candidates = [config?.declaredOutcomes, config?.outcomes]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((value): value is string => typeof value === 'string')
    }
  }
  return [...fallback]
}

const stripDerivedConfig = (config: Record<string, unknown>): Record<string, unknown> => {
  const derivedKeys = new Set([
    'toolName',
    'boundInputs',
    'exposedInputs',
    'boundParams',
    'exposedParams',
    'boundPayload',
    'exposedPayload',
    'declaredOutcomes',
    'outcomes',
  ])
  return Object.fromEntries(Object.entries(config).filter(([key]) => !derivedKeys.has(key)))
}

const parseExtraConfig = (value: string): Record<string, unknown> => {
  const trimmed = value.trim()
  if (!trimmed) {
    return {}
  }
  const parsed = JSON.parse(trimmed) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Additional settings must be a JSON object.')
  }
  return parsed
}

const buildInputMaps = (draft: SkillFormDraft, fields: readonly DerivedSkillField[]) => {
  const bound: Record<string, unknown> = {}
  const exposed: Record<string, { description?: string; slotBinding?: string; required?: boolean }> = {}

  for (const field of fields) {
    const input = draft.inputDrafts[field.name]
    if (!input || input.mode === 'ignore') {
      continue
    }
    if (input.mode === 'bind') {
      bound[field.name] = parseBoundParamValue(input.boundValue, field)
      continue
    }
    exposed[field.name] = {
      ...(input.description.trim() ? { description: input.description.trim() } : {}),
      ...(input.slotBinding.trim() ? { slotBinding: normalizeSkillName(input.slotBinding) } : {}),
      ...(field.required ? { required: true } : {}),
    }
  }

  return { bound, exposed }
}

const buildInputConfig = (
  capability: SkillCapabilityDescriptor,
  draft: SkillFormDraft,
  fields: readonly DerivedSkillField[],
): Record<string, unknown> => {
  const { bound, exposed } = buildInputMaps(draft, fields)
  if (capability.targetKind === 'source_scope' || capability.targetKind === 'notify_delivery') {
    return {
      exposedInputs: Object.fromEntries(Object.keys(exposed).map((key) => [key, true])),
    }
  }
  const targetShape = capability.inputSchema.source === 'discovered'
    ? 'params'
    : capability.targetKind === 'webhook_destination'
      ? 'payload'
      : 'inputs'

  if (targetShape === 'params') {
    return {
      toolName: draft.toolName.trim(),
      boundParams: bound,
      exposedParams: exposed,
    }
  }
  if (targetShape === 'payload') {
    return {
      boundPayload: bound,
      exposedPayload: exposed,
    }
  }

  return {
    boundInputs: bound,
    exposedInputs: exposed,
  }
}

const buildOutcomeConfig = (
  capability: SkillCapabilityDescriptor,
  selectedOutcomes: readonly string[],
): Record<string, unknown> => {
  const outcomes = selectedOutcomes.filter((outcome) => capability.outcomeVocabulary.includes(outcome))
  if (capability.inputSchema.source === 'discovered') {
    return { declaredOutcomes: outcomes }
  }
  return {}
}

const defaultConfigForTargetKind = (capability: SkillCapabilityDescriptor): Record<string, unknown> => {
  if (capability.targetKind === 'notify_delivery') {
    return { delivery: { recipientEmails: [], webhook: null } }
  }
  if (capability.targetKind === 'source_scope') {
    return { sourceScope: 'all' }
  }
  return {}
}
