import type { ApiListField, ApiListOutput, ApiScalarOutput, ApiValueType } from '@/lib/api-connections'

export type JsonPathSegment = string | number

// Structural format checks mirroring the backend's value coercion, not product vocabulary.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/iu
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The declared type a sample value fits, or null for a value that is not a scalar. */
export const inferValueType = (value: unknown): ApiValueType | null => {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : null
  if (typeof value !== 'string') return null
  if (EMAIL_PATTERN.test(value)) return 'email'
  if (ISO_DATE_PATTERN.test(value)) return 'date'
  return 'text'
}

/** The dot path a response position is addressed by: numeric segments index arrays. */
export const formatJsonPath = (segments: readonly JsonPathSegment[]): string => segments.join('.')

/** Whether the backend can address this key: dots split a path, so a key holding one cannot be named. */
const isAddressableKey = (key: string): boolean => key.length > 0 && !key.includes('.') && !/\s/u.test(key)

const snakeCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase()

/** A variable-safe name from the last named segment of a path, made unique among `taken`. */
export const suggestOutputName = (segments: readonly JsonPathSegment[], taken: ReadonlySet<string>): string => {
  const named = [...segments].reverse().find((segment) => typeof segment === 'string')
  let base = typeof named === 'string' ? snakeCase(named) : ''
  if (!NAME_PATTERN.test(base)) base = base ? `field_${base}` : 'value'
  if (!taken.has(base)) return base
  let suffix = 2
  while (taken.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

export const scalarOutputFor = (segments: readonly JsonPathSegment[], value: unknown): ApiScalarOutput | null => {
  const type = inferValueType(value)
  return type ? { path: formatJsonPath(segments), type, required: false } : null
}

/**
 * A list output for an array in the response: one field per scalar key of the first record, paths
 * relative to the item. The operator trims and names roles afterwards.
 */
export const listOutputFor = (segments: readonly JsonPathSegment[], items: readonly unknown[]): ApiListOutput | null => {
  const sample = items.find(isJsonRecord)
  if (!sample) return null
  const fields: Record<string, ApiListField> = {}
  for (const [key, value] of Object.entries(sample)) {
    const type = inferValueType(value)
    if (!type || !isAddressableKey(key)) continue
    fields[suggestOutputName([key], new Set(Object.keys(fields)))] = { path: key, type }
  }
  return { path: formatJsonPath(segments), type: 'list', required: false, maxItems: 10, fields }
}

export const describeNode = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.length}]`
  if (isJsonRecord(value)) return `{${Object.keys(value).length}}`
  return typeof value === 'string' ? `"${value}"` : String(value)
}
