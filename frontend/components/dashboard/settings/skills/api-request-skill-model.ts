import type {
  ApiListField,
  ApiOutputDeclaration,
  ApiOutputFieldRole,
  ApiRequestMethod,
  ApiRequestTestInput,
  ApiValueType,
} from '@/lib/api-connections'
import { coerceApiTestSample } from './api-test-sample-values'
import {
  isJsonRecord,
  listOutputFor,
  scalarOutputFor,
  suggestOutputName,
  type JsonPathSegment,
} from './api-response-tree'

export const API_REQUEST_METHODS: readonly ApiRequestMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
export const API_VALUE_TYPES: readonly ApiValueType[] = ['text', 'number', 'boolean', 'date', 'email']
export const API_FIELD_ROLES: readonly ApiOutputFieldRole[] = ['key', 'title', 'subtitle', 'image', 'link']
export const MAX_LIST_ITEMS = 20

export type ApiInputDraft = {
  id: string
  key: string
  type: ApiValueType
  description: string
  slotBinding: string
  required: boolean
  verifiedOnly: boolean
}

export type ApiFixedParamDraft = { id: string; key: string; value: string }

export type ApiOutputFieldDraft = {
  id: string
  name: string
  path: string
  type: ApiValueType
  description: string
  role: ApiOutputFieldRole | ''
}

export type ApiOutputDraft = {
  id: string
  name: string
  kind: 'scalar' | 'list'
  path: string
  type: ApiValueType
  description: string
  required: boolean
  maxItems: number
  fields: ApiOutputFieldDraft[]
}

export type ApiRequestDraft = {
  method: ApiRequestMethod
  path: string
  fixedParams: ApiFixedParamDraft[]
  inputs: ApiInputDraft[]
  outputs: ApiOutputDraft[]
}

let idCounter = 0
const nextId = (): string => `api-draft-${idCounter += 1}`

export const emptyApiInput = (): ApiInputDraft => ({
  id: nextId(), key: '', type: 'text', description: '', slotBinding: '', required: true, verifiedOnly: false,
})

export const emptyApiFixedParam = (): ApiFixedParamDraft => ({ id: nextId(), key: '', value: '' })

export const emptyApiOutputField = (): ApiOutputFieldDraft => ({
  id: nextId(), name: '', path: '', type: 'text', description: '', role: '',
})

export const emptyApiOutput = (kind: 'scalar' | 'list' = 'scalar'): ApiOutputDraft => ({
  id: nextId(), name: '', kind, path: '', type: 'text', description: '', required: false, maxItems: 10, fields: [],
})

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
const asType = (value: unknown): ApiValueType =>
  API_VALUE_TYPES.includes(value as ApiValueType) ? (value as ApiValueType) : 'text'

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/**
 * The typed value a fixed parameter's text stands for. A number counts only when it reads back
 * exactly, so an identifier too long for a double stays the text it was typed as.
 */
export const fixedValueFromText = (text: string): unknown => {
  const trimmed = text.trim()
  if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null') return JSON.parse(trimmed)
  if (/^[{["]/u.test(trimmed)) {
    const parsed = parseJson(trimmed)
    return parsed.ok ? parsed.value : text
  }
  const number = Number(trimmed)
  const isExact = trimmed !== '' && Number.isFinite(number) && String(number) === trimmed
  return isExact && (!Number.isInteger(number) || Number.isSafeInteger(number)) ? number : text
}

// A string that would read back as another type is shown quoted, so editing keeps it a string.
const fixedValueToText = (value: unknown): string => {
  if (typeof value !== 'string') return JSON.stringify(value)
  return fixedValueFromText(value) === value ? value : JSON.stringify(value)
}

const fieldFromConfig = (name: string, value: unknown): ApiOutputFieldDraft => {
  const field = isJsonRecord(value) ? value : {}
  return {
    id: nextId(),
    name,
    path: asString(field.path),
    type: asType(field.type),
    description: asString(field.description),
    role: API_FIELD_ROLES.includes(field.role as ApiOutputFieldRole) ? (field.role as ApiOutputFieldRole) : '',
  }
}

const outputDraftFromDeclaration = (name: string, declaration: ApiOutputDeclaration): ApiOutputDraft => {
  const isList = declaration.type === 'list'
  return {
    id: nextId(),
    name,
    kind: isList ? 'list' : 'scalar',
    path: declaration.path,
    type: isList ? 'text' : declaration.type,
    description: declaration.description ?? '',
    required: declaration.required,
    maxItems: isList ? declaration.maxItems : 10,
    fields: isList ? Object.entries(declaration.fields).map(([fieldName, field]) => fieldFromConfig(fieldName, field)) : [],
  }
}

/** The form's state for a saved skill's config, or an empty request for a new skill. */
export const createApiRequestDraft = (config?: Record<string, unknown>): ApiRequestDraft => {
  const bound = isJsonRecord(config?.boundParams) ? config.boundParams : {}
  const exposed = isJsonRecord(config?.exposedParams) ? config.exposedParams : {}
  const outputs = isJsonRecord(config?.outputs) ? config.outputs : {}
  return {
    method: API_REQUEST_METHODS.includes(config?.method as ApiRequestMethod) ? (config?.method as ApiRequestMethod) : 'GET',
    path: asString(config?.path),
    fixedParams: Object.entries(bound).map(([key, value]) => ({ id: nextId(), key, value: fixedValueToText(value) })),
    inputs: Object.entries(exposed).map(([key, value]) => {
      const param = isJsonRecord(value) ? value : {}
      return {
        id: nextId(),
        key,
        type: asType(param.type),
        description: asString(param.description),
        slotBinding: asString(param.slotBinding),
        required: param.required !== false,
        verifiedOnly: param.verifiedOnly === true,
      }
    }),
    outputs: Object.entries(outputs).map(([name, value]) =>
      outputDraftFromDeclaration(name, value as ApiOutputDeclaration)),
  }
}

// A list's fields are never required: only a top-level output can fail the skill when absent.
const fieldToDeclaration = (field: ApiOutputFieldDraft): ApiListField => ({
  path: field.path.trim(),
  type: field.type,
  ...(field.description.trim() ? { description: field.description.trim() } : {}),
  ...(field.role ? { role: field.role } : {}),
})

const outputToDeclaration = (output: ApiOutputDraft): ApiOutputDeclaration => {
  const common = {
    path: output.path.trim(),
    ...(output.description.trim() ? { description: output.description.trim() } : {}),
    required: output.required,
  }
  if (output.kind === 'scalar') return { ...common, type: output.type }
  return {
    ...common,
    type: 'list',
    maxItems: Math.min(MAX_LIST_ITEMS, Math.max(1, Math.trunc(output.maxItems) || 10)),
    fields: Object.fromEntries(output.fields.map((field) => [field.name.trim(), fieldToDeclaration(field)])),
  }
}

const requireUnique = (names: readonly string[], what: string): void => {
  const seen = new Set<string>()
  for (const name of names) {
    if (!name) throw new Error(`Every ${what} needs a name.`)
    if (seen.has(name)) throw new Error(`The ${what} "${name}" is listed twice.`)
    seen.add(name)
  }
}

const buildApiOutputs = (outputs: readonly ApiOutputDraft[]): Record<string, ApiOutputDeclaration> => {
  requireUnique(outputs.map((output) => output.name.trim()), 'output')
  for (const output of outputs) {
    if (!output.path.trim()) throw new Error(`The output "${output.name.trim()}" needs a path.`)
    requireUnique(output.fields.map((field) => field.name.trim()), `field of "${output.name.trim()}"`)
    for (const field of output.fields) {
      if (!field.path.trim()) throw new Error(`The field "${field.name.trim()}" needs a path.`)
    }
  }
  return Object.fromEntries(outputs.map((output) => [output.name.trim(), outputToDeclaration(output)]))
}

const buildApiBoundParams = (fixedParams: readonly ApiFixedParamDraft[]): Record<string, unknown> => {
  requireUnique(fixedParams.map((param) => param.key.trim()), 'fixed param')
  return Object.fromEntries(fixedParams.map((param) => [param.key.trim(), fixedValueFromText(param.value)]))
}

const buildApiExposedParams = (inputs: readonly ApiInputDraft[]): Record<string, unknown> => {
  requireUnique(inputs.map((input) => input.key.trim()), 'input')
  return Object.fromEntries(inputs.map((input) => [input.key.trim(), {
    type: input.type,
    ...(input.description.trim() ? { description: input.description.trim() } : {}),
    ...(input.slotBinding.trim() ? { slotBinding: input.slotBinding.trim() } : {}),
    required: input.required,
    verifiedOnly: input.verifiedOnly,
  }]))
}

/** The skill config the backend stores. Throws a message for a draft that cannot be named or addressed. */
export const buildApiRequestConfig = (draft: ApiRequestDraft): Record<string, unknown> => {
  if (!draft.path.trim()) throw new Error('Enter the request path.')
  return {
    method: draft.method,
    path: draft.path.trim(),
    boundParams: buildApiBoundParams(draft.fixedParams),
    exposedParams: buildApiExposedParams(draft.inputs),
    outputs: buildApiOutputs(draft.outputs),
  }
}

/** The test request for the draft as it stands, with the operator's sample value for each input. */
export const buildApiTestInput = (
  draft: ApiRequestDraft,
  samples: Readonly<Record<string, string>>,
): ApiRequestTestInput => {
  const config = buildApiRequestConfig(draft)
  const exposedSampleValues = Object.fromEntries(
    draft.inputs
      .map((input) => [input.key.trim(), samples[input.id] ?? '', input.type] as const)
      .filter(([, value]) => value !== '')
      .map(([key, value, type]) => [key, coerceApiTestSample(type, value)] as const),
  )
  return {
    method: draft.method,
    path: config.path as string,
    boundParams: config.boundParams as Record<string, unknown>,
    exposedSampleValues,
    outputs: config.outputs as Record<string, ApiOutputDeclaration>,
  }
}

/** The outputs a declared type may carry as a list field's `image` or `link` role. */
export const fieldTypeAllowsRole = (type: ApiValueType, role: ApiOutputFieldRole | ''): boolean =>
  (role !== 'image' && role !== 'link') || type === 'text'

const outputPaths = (outputs: readonly ApiOutputDraft[]): Set<string> => new Set(outputs.map((output) => output.path.trim()))
const outputNames = (outputs: readonly ApiOutputDraft[]): Set<string> => new Set(outputs.map((output) => output.name.trim()))

/** The outputs with the clicked response value added: its path, its inferred type, a name from its key. */
export const withOutputFromValue = (
  outputs: readonly ApiOutputDraft[],
  segments: readonly JsonPathSegment[],
  value: unknown,
): ApiOutputDraft[] => {
  const declaration = Array.isArray(value) ? listOutputFor(segments, value) : scalarOutputFor(segments, value)
  if (!declaration || outputPaths(outputs).has(declaration.path)) return [...outputs]
  const name = suggestOutputName(segments, outputNames(outputs))
  return [...outputs, outputDraftFromDeclaration(name, declaration)]
}

/** Whether a response value can become an output: a scalar, or an array of records. */
export const valueCanBeOutput = (value: unknown): boolean =>
  Array.isArray(value) ? value.some(isJsonRecord) : scalarOutputFor([], value) !== null
