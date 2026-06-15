export type ToolInputFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown'

export type ToolInputField = {
  name: string
  type: ToolInputFieldType
  description: string | null
  required: boolean
}

export type DiscoveredMcpTool = {
  name: string
  description?: string
  inputSchema?: unknown
}

export type ParamMode = 'bind' | 'expose' | 'ignore'

export type ParamModeMap = Record<string, ParamMode>
export type BoundValueMap = Record<string, string>
export type ExposedParamDraftMap = Record<string, { description: string; slotBinding: string }>

type JsonSchemaProperty = {
  type?: unknown
  description?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const propertyType = (property: JsonSchemaProperty | undefined): ToolInputFieldType => {
  const type = Array.isArray(property?.type) ? property.type.find((entry) => entry !== 'null') : property?.type
  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'object':
    case 'array':
      return type
    case 'integer':
      return 'number'
    default:
      return 'unknown'
  }
}

export function getToolInputFields(inputSchema: unknown): ToolInputField[] {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) {
    return []
  }

  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  )

  return Object.entries(inputSchema.properties)
    .map(([name, rawProperty]) => {
      const property = isRecord(rawProperty) ? rawProperty : undefined
      return {
        name,
        type: propertyType(property),
        description: typeof property?.description === 'string' ? property.description : null,
        required: required.has(name),
      }
    })
    .sort((left, right) => {
      if (left.required !== right.required) return left.required ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

export function defaultParamModes(fields: readonly ToolInputField[]): ParamModeMap {
  return Object.fromEntries(fields.map((field) => [field.name, field.required ? 'expose' : 'ignore']))
}

export function normalizeSkillName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
  if (!normalized) return ''
  return /^[a-z]/.test(normalized) ? normalized : `skill_${normalized}`
}

export function defaultSkillName(toolName: string): string {
  return normalizeSkillName(toolName)
}

export function parseBoundParamValue(rawValue: string, field: ToolInputField): unknown {
  const trimmed = rawValue.trim()
  if (field.type === 'number') {
    return trimmed === '' ? null : Number(trimmed)
  }
  if (field.type === 'boolean') {
    return trimmed === 'true'
  }
  if (field.type === 'object' || field.type === 'array') {
    return trimmed === '' ? (field.type === 'array' ? [] : {}) : JSON.parse(trimmed)
  }
  return rawValue
}

export function buildExternalSkillDraft(input: {
  skillName: string
  connectionId: string
  tool: DiscoveredMcpTool
  paramModes: ParamModeMap
  boundValues: BoundValueMap
  exposedParams: ExposedParamDraftMap
}): {
  skillName: string
  connectionId: string
  toolName: string
  boundParams: Record<string, unknown>
  exposedParams: Record<string, { description?: string; slotBinding?: string }>
  enabled: boolean
} {
  const fieldsByName = new Map(getToolInputFields(input.tool.inputSchema).map((field) => [field.name, field]))
  const boundParams: Record<string, unknown> = {}
  const exposedParams: Record<string, { description?: string; slotBinding?: string }> = {}

  for (const [name, mode] of Object.entries(input.paramModes)) {
    const field = fieldsByName.get(name) ?? { name, type: 'unknown', description: null, required: false }
    if (mode === 'bind') {
      boundParams[name] = parseBoundParamValue(input.boundValues[name] ?? '', field)
    }
    if (mode === 'expose') {
      const draft = input.exposedParams[name] ?? { description: '', slotBinding: '' }
      exposedParams[name] = {
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        ...(draft.slotBinding.trim() ? { slotBinding: normalizeSkillName(draft.slotBinding) } : {}),
      }
    }
  }

  return {
    skillName: normalizeSkillName(input.skillName),
    connectionId: input.connectionId,
    toolName: input.tool.name,
    boundParams,
    exposedParams,
    enabled: true,
  }
}
