import type {
  AgentSkill,
  AgentSkillCapabilityId,
  AgentSkillCreateInput,
  AgentSkillInvocationMode,
  SkillCapabilityDescriptor,
  SkillCapabilitySettingsField,
} from '@/lib/api-skills'
import { getToolInputFields, normalizeSkillName, parseBoundParamValue, type ToolInputField, type ToolInputFieldType } from '@/lib/external-skills'
import type { AgentSourceScope } from '@/lib/api'

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
  settingDrafts: Record<string, SkillSettingDraftValue>
  selectedOutcomes: string[]
  extraConfigJson: string
}

export type DerivedSkillField = ToolInputField
export type SkillSettingDraftValue = string | number | boolean | string[] | AgentSourceScope | undefined

const DEFAULT_OUTCOMES = ['completed', 'failed']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const stringFieldsFromDescriptor = (capability: SkillCapabilityDescriptor): DerivedSkillField[] => {
  if (capability.inputSchema.source !== 'static') {
    return []
  }
  const schema = capability.inputSchema.schema
  const rawFields = schema.fields
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === 'string') : [])
  if (!Array.isArray(rawFields)) {
    return []
  }
  return rawFields.flatMap((field): DerivedSkillField[] => {
    if (typeof field === 'string') {
      return [{
        name: field,
        type: 'string',
        description: null,
        required: required.size > 0 ? required.has(field) : true,
      }]
    }
    if (isRecord(field) && typeof field.name === 'string') {
      return [{
        name: field.name,
        type: parseToolInputFieldType(field.type),
        description: typeof field.description === 'string' ? field.description : null,
        required: typeof field.required === 'boolean'
          ? field.required
          : required.size > 0 ? required.has(field.name) : true,
      }]
    }
    return []
  })
}

export const deriveSkillFields = (capability: SkillCapabilityDescriptor, discoveredSchema?: unknown): DerivedSkillField[] => {
  if (capability.inputSchema.source === 'discovered') {
    return getToolInputFields(discoveredSchema)
  }

  return stringFieldsFromDescriptor(capability)
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
      description: typeof exposedRecord.description === 'string' ? exposedRecord.description : field.description ?? formatFieldLabel(field.name),
      slotBinding: typeof exposedRecord.slotBinding === 'string' ? exposedRecord.slotBinding : field.name,
    }]
  }))
}

export const createInitialSkillDraft = (
  capabilities: readonly SkillCapabilityDescriptor[],
  existingSkill?: AgentSkill | null,
  existingSkills: readonly AgentSkill[] = [],
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
    name: existingSkill?.name ?? suggestSkillName(capability, targetId, existingSkills),
    invocationMode: existingSkill?.invocationMode ??
      capability?.defaultInvocationMode ??
      capability?.supportedInvocationModes[0] ??
      'routine_named',
    enabled: existingSkill?.enabled ?? true,
    toolName: typeof existingSkill?.config.toolName === 'string' ? existingSkill.config.toolName : '',
    inputDrafts: createInputDrafts(fields, existingSkill?.config),
    settingDrafts: createSettingDrafts(capability?.settingsFields ?? [], existingSkill?.config),
    selectedOutcomes: readOutcomeList(existingSkill?.config, capability?.outcomeVocabulary ?? DEFAULT_OUTCOMES),
    extraConfigJson: existingSkill ? JSON.stringify(stripDerivedConfig(existingSkill.config, capability?.settingsFields ?? []), null, 2) : '{}',
  }
}

export const createSettingDrafts = (
  settingsFields: readonly SkillCapabilitySettingsField[],
  existingConfig?: Record<string, unknown>,
): Record<string, SkillSettingDraftValue> =>
  Object.fromEntries(settingsFields.map((field) => [field.key, readSettingDraftValue(field, existingConfig)]))

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
  const settingsConfig = buildSettingsConfig(capability.settingsFields, draft.settingDrafts)
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
      ...settingsConfig,
      ...outcomes,
    },
    invocationMode: draft.invocationMode,
    enabled: draft.enabled,
  }
}

const capabilityLabels: Record<string, string> = {
  retrieve: 'Knowledge Retrieval',
  mcp_tool: 'MCP Tool',
  email: 'Email',
  slack_post: 'Slack Post',
  webhook_call: 'Webhook Call',
  notify: 'Notify Human',
}

export const formatCapabilityLabel = (value: string): string =>
  capabilityLabels[value] ?? value.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')

export const formatInvocationMode = (value: AgentSkillInvocationMode): string =>
  ({
    default_answer: 'Answer the user automatically',
    routine_named: 'Only when a routine calls it (@name)',
    agent_selectable: 'Agent decides when to use it',
  })[value]

export const formatInputMode = (value: SkillInputMode): string =>
  ({
    expose: 'Ask at runtime',
    bind: 'Use a fixed value',
    ignore: "Don't include",
  })[value]

const findFirstRecord = (config: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> => {
  for (const key of keys) {
    const value = config?.[key]
    if (isRecord(value)) {
      return value
    }
  }
  return {}
}

const parseToolInputFieldType = (value: unknown): ToolInputFieldType => {
  if (value === 'string' || value === 'number' || value === 'boolean' || value === 'object' || value === 'array' || value === 'unknown') {
    return value
  }
  return 'string'
}

const formatFieldLabel = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const suggestSkillName = (
  capability: SkillCapabilityDescriptor | undefined,
  targetId: string,
  existingSkills: readonly AgentSkill[],
): string => {
  if (!capability) {
    return ''
  }
  const base = normalizeSkillName(suggestSkillNameBase(capability.id, capability.targets.find((target) => target.id === targetId)?.label))
  const existingNames = new Set(existingSkills.map((skill) => skill.name))
  if (!existingNames.has(base)) {
    return base
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}_${suffix}`
    if (!existingNames.has(candidate)) {
      return candidate
    }
  }
  return `${base}_${Date.now()}`
}

const suggestSkillNameBase = (capabilityId: AgentSkillCapabilityId, targetLabel?: string): string => {
  const targetSlug = targetLabel ? normalizeSkillName(targetLabel) : ''
  if (capabilityId === 'email') {
    return targetSlug ? `send_${targetSlug}_email` : 'send_email'
  }
  if (capabilityId === 'slack_post') {
    return targetSlug ? `post_${targetSlug}` : 'post_slack'
  }
  if (capabilityId === 'webhook_call') {
    return targetSlug ? `call_${targetSlug}` : 'call_webhook'
  }
  if (capabilityId === 'notify') {
    // Canonical name the contact-request gate and built-in contact routine key on
    // (see backend agentService.resolve / contactSendActionHandler). Naming a fresh
    // notify skill anything else leaves "Talk to a human" disconnected.
    return 'contact_human'
  }
  if (capabilityId === 'retrieve') {
    return targetSlug && targetSlug !== 'all_sources' ? `retrieve_${targetSlug}` : 'retrieve_answer'
  }
  return targetSlug ? `${capabilityId}_${targetSlug}` : capabilityId
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

const stripDerivedConfig = (
  config: Record<string, unknown>,
  settingsFields: readonly SkillCapabilitySettingsField[],
): Record<string, unknown> => {
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
  let stripped = Object.fromEntries(Object.entries(config).filter(([key]) => !derivedKeys.has(key)))
  for (const field of settingsFields) {
    stripped = omitPath(stripped, field.key.split('.'))
  }
  return stripped
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

const readSettingDraftValue = (
  field: SkillCapabilitySettingsField,
  config: Record<string, unknown> | undefined,
): SkillSettingDraftValue => {
  const value = readPath(config ?? {}, field.key.split('.'))
  if (field.type === 'source_scope') {
    return configSourceScopeToDraft(value)
  }
  if (field.type === 'string_list') {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }
  if (field.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined
  }
  if (field.type === 'number') {
    return typeof value === 'number' ? value : undefined
  }
  if (field.type === 'select') {
    return typeof value === 'string' ? value : undefined
  }
  if (field.type === 'textarea') {
    // Tri-state: undefined means "inherit the default", a string is an override.
    return typeof value === 'string' ? value : undefined
  }
  return typeof value === 'string' ? value : ''
}

const buildSettingsConfig = (
  settingsFields: readonly SkillCapabilitySettingsField[],
  settingDrafts: Record<string, SkillSettingDraftValue>,
): Record<string, unknown> => {
  let config: Record<string, unknown> = {}
  for (const field of settingsFields) {
    const value = settingDraftValueToConfig(field, settingDrafts[field.key])
    if (value === undefined) {
      continue
    }
    config = setPath(config, field.key.split('.'), value)
  }
  return config
}

const settingDraftValueToConfig = (
  field: SkillCapabilitySettingsField,
  value: SkillSettingDraftValue,
): unknown => {
  if (field.type === 'source_scope') {
    return draftSourceScopeToConfig(value)
  }
  if (field.type === 'string_list') {
    return Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : []
  }
  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  if (field.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

const configSourceScopeToDraft = (value: unknown): AgentSourceScope => {
  if (value === 'all' || value === undefined) {
    return { mode: 'all' }
  }
  if (isRecord(value) && Array.isArray(value.sourceIds)) {
    return {
      mode: 'selected',
      sourceIds: value.sourceIds.filter((item): item is string => typeof item === 'string'),
    }
  }
  return { mode: 'all' }
}

const draftSourceScopeToConfig = (value: SkillSettingDraftValue): unknown => {
  if (isRecord(value) && value.mode === 'selected' && Array.isArray(value.sourceIds)) {
    return { sourceIds: value.sourceIds.filter((item): item is string => typeof item === 'string') }
  }
  return 'all'
}

const readPath = (record: Record<string, unknown>, path: readonly string[]): unknown => {
  let current: unknown = record
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

const setPath = (
  record: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> => {
  const [head, ...tail] = path
  if (!head) {
    return record
  }
  if (tail.length === 0) {
    return { ...record, [head]: value }
  }
  const child = isRecord(record[head]) ? record[head] : {}
  return { ...record, [head]: setPath(child, tail, value) }
}

const omitPath = (
  record: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> => {
  const [head, ...tail] = path
  if (!head || !Object.prototype.hasOwnProperty.call(record, head)) {
    return record
  }
  if (tail.length === 0) {
    const rest = { ...record }
    delete rest[head]
    return rest
  }
  const child = record[head]
  if (!isRecord(child)) {
    return record
  }
  const nextChild = omitPath(child, tail)
  if (Object.keys(nextChild).length === 0) {
    const rest = { ...record }
    delete rest[head]
    return rest
  }
  return { ...record, [head]: nextChild }
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
