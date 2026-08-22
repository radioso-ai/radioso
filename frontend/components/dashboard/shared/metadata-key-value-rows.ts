/**
 * Pure rows <-> record transform and validation for hand-authored document
 * metadata tags. Kept free of React so the rules are unit-testable without
 * rendering, and so the editor component stays presentational.
 */

export type MetadataScalar = string | number | boolean | null
export type MetadataRecord = Record<string, MetadataScalar>
/** What the API hands back: the backend also permits null tag values. */
export type MetadataReadRecord = Record<string, unknown>

export type MetadataValueType = 'string' | 'number' | 'boolean' | 'null'

export type MetadataRow = {
  id: string
  key: string
  valueType: MetadataValueType
  /** Raw editor text. Booleans hold "true"/"false"; numbers hold the typed text. */
  value: string
}

export type MetadataRowIssue = 'empty_key' | 'duplicate_key' | 'invalid_number'

export type MetadataRowsValidation = {
  issuesByRowId: Record<string, MetadataRowIssue[]>
  hasEmptyKey: boolean
  hasDuplicateKey: boolean
  hasInvalidNumber: boolean
  /** False only for issues that must block a save. Empty keys are dropped, not blocking. */
  isValid: boolean
}

/**
 * Tag keys the metadata-extraction pipeline owns. Hand-authored values under
 * these keys survive until the next processing run, which may rewrite or drop
 * them, so the editor warns without blocking. This mirrors the extraction
 * contract's reserved keys rather than any user-facing vocabulary.
 */
export const EXTRACTION_MANAGED_METADATA_KEYS = ['dateFrom', 'dateTo'] as const

export const isExtractionManagedKey = (key: string): boolean =>
  (EXTRACTION_MANAGED_METADATA_KEYS as readonly string[]).includes(key.trim())

let rowIdCounter = 0
const nextRowId = (): string => {
  rowIdCounter += 1
  return `metadata-row-${rowIdCounter}`
}

export const createMetadataRow = (
  overrides?: Partial<Omit<MetadataRow, 'id'>>,
): MetadataRow => ({
  id: nextRowId(),
  key: overrides?.key ?? '',
  valueType: overrides?.valueType ?? 'string',
  value: overrides?.value ?? '',
})

const isMetadataScalar = (value: unknown): value is MetadataScalar =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/**
 * Parses editor text as a metadata number. Blank text and non-finite results
 * (including NaN and Infinity) are rejected so an invalid entry surfaces as a
 * validation issue instead of a silent NaN in the payload.
 */
export const parseMetadataNumber = (text: string): number | null => {
  const trimmed = text.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Seeds editor rows from a stored record. Non-scalar values are dropped: the
 * editor authors flat scalars only, and rendering objects as text would
 * round-trip "[object Object]" back into the document.
 */
export const toRows = (record: MetadataReadRecord | null | undefined): MetadataRow[] => {
  if (!record) return []
  return Object.entries(record).flatMap(([key, value]) => {
    if (!isMetadataScalar(value)) return []
    return [
      createMetadataRow({
        key,
        valueType: value === null ? 'null' : typeof value as MetadataValueType,
        value: value === null ? '' : String(value),
      }),
    ]
  })
}

/**
 * Projects rows back to the payload record. Rows with a blank key or an
 * unparseable number are omitted; on a duplicate key the last row wins.
 */
export const toRecord = (rows: MetadataRow[]): MetadataRecord => {
  const record: MetadataRecord = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue

    if (row.valueType === 'number') {
      const parsed = parseMetadataNumber(row.value)
      if (parsed === null) continue
      record[key] = parsed
      continue
    }

    if (row.valueType === 'boolean') {
      record[key] = row.value.trim().toLowerCase() === 'true'
      continue
    }

    if (row.valueType === 'null') {
      record[key] = null
      continue
    }

    record[key] = row.value
  }
  return record
}

export const validateRows = (rows: MetadataRow[]): MetadataRowsValidation => {
  const keyCounts = new Map<string, number>()
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
  }

  const issuesByRowId: Record<string, MetadataRowIssue[]> = {}
  let hasEmptyKey = false
  let hasDuplicateKey = false
  let hasInvalidNumber = false

  for (const row of rows) {
    const key = row.key.trim()
    const issues: MetadataRowIssue[] = []

    // A wholly blank row is a pending row, not a mistake. Only a value stranded
    // without a key is flagged, because that value is silently dropped on save.
    if (!key && row.value.trim().length > 0) {
      issues.push('empty_key')
      hasEmptyKey = true
    }

    if (key && (keyCounts.get(key) ?? 0) > 1) {
      issues.push('duplicate_key')
      hasDuplicateKey = true
    }

    if (row.valueType === 'number' && parseMetadataNumber(row.value) === null) {
      issues.push('invalid_number')
      hasInvalidNumber = true
    }

    if (issues.length > 0) {
      issuesByRowId[row.id] = issues
    }
  }

  return {
    issuesByRowId,
    hasEmptyKey,
    hasDuplicateKey,
    hasInvalidNumber,
    isValid: !hasDuplicateKey && !hasInvalidNumber,
  }
}

/** Re-types a row, coercing its text so the new type has a usable starting value. */
export const changeRowType = (row: MetadataRow, valueType: MetadataValueType): MetadataRow => {
  if (row.valueType === valueType) return row

  if (valueType === 'boolean') {
    return { ...row, valueType, value: row.value.trim().toLowerCase() === 'true' ? 'true' : 'false' }
  }

  if (valueType === 'null') {
    return { ...row, valueType, value: '' }
  }

  return { ...row, valueType, value: row.value }
}

export const areRecordsEqual = (a: MetadataRecord, b: MetadataRecord): boolean => {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key])
}
