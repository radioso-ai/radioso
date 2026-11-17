/** Readable summaries of a revision's scoped changes, so the review dialog never prints raw JSON. */

const DIFF_FIELDS = ['name', 'source', 'surfacing', 'enabled', 'resolverSkillId', 'maxAgeSeconds', 'resolverTimeoutMs', 'action', 'condition', 'priority', 'version', 'activation', 'slots', 'steps', 'transitions', 'terminals', 'completionExport', 'excludes', 'routes', 'tags'] as const

export const changeFieldLabels: Record<string, string> = {
  name: 'Name', source: 'Source', surfacing: 'Surfacing', enabled: 'Enabled', resolverSkillId: 'Resolver skill', maxAgeSeconds: 'Maximum age', resolverTimeoutMs: 'Resolver timeout', action: 'Action', condition: 'Condition', priority: 'Priority', version: 'Version', activation: 'Activation', slots: 'Slots', steps: 'Steps', transitions: 'Transitions', terminals: 'Terminal states', completionExport: 'Completion export', excludes: 'Excludes', routes: 'Routes', tags: 'Tags',
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Descriptions read as themselves; other plain fields read as "name: value". */
const DESCRIPTION_KEYS = new Set(['description', 'triggerDescription'])

const summarizeObject = (value: Record<string, unknown>): string => {
  const entries = Object.entries(value).filter(([, entry]) => isScalar(entry) && entry !== '')
  const hasDescription = entries.some(([key]) => DESCRIPTION_KEYS.has(key))
  const parts = entries
    .filter(([key]) => !(hasDescription && key === 'kind'))
    .map(([key, entry]) => (DESCRIPTION_KEYS.has(key) ? String(entry) : entries.length === 1 ? capitalize(String(entry)) : `${key}: ${String(entry)}`))
  return parts.length ? parts.join(', ') : 'Set'
}

const isScalarList = (value: unknown[]): value is Array<string | number | boolean> => value.every(isScalar)

const itemIdentity = (item: unknown): string => {
  const record = asRecord(item)
  for (const key of ['id', 'key', 'name']) {
    if (isScalar(record[key])) return `${key}:${String(record[key])}`
  }
  return JSON.stringify(item)
}

const countLabel = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`

/** Compares two lists of items by identity: how many are new, reworded, or gone. */
const describeListChange = (before: unknown[], after: unknown[]): string => {
  const beforeById = new Map(before.map((item) => [itemIdentity(item), JSON.stringify(item)]))
  const afterById = new Map(after.map((item) => [itemIdentity(item), JSON.stringify(item)]))
  const added = [...afterById.keys()].filter((id) => !beforeById.has(id)).length
  const removed = [...beforeById.keys()].filter((id) => !afterById.has(id)).length
  const edited = [...afterById].filter(([id, json]) => beforeById.has(id) && beforeById.get(id) !== json).length
  const parts = [
    added ? `${added} added` : null,
    edited ? `${edited} edited` : null,
    removed ? `${removed} removed` : null,
  ].filter((part): part is string => part !== null)
  return parts.length ? `${countLabel(after.length)}: ${parts.join(', ')}` : countLabel(after.length)
}

const summarizeValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'None'
  if (isScalar(value)) return String(value)
  if (Array.isArray(value)) return value.length === 0 ? 'None' : isScalarList(value) ? value.join(', ') : countLabel(value.length)
  return summarizeObject(asRecord(value))
}

/** The before and after text of one changed field. */
export const summarizeChange = (before: unknown, after: unknown): { before: string; after: string } => {
  if (Array.isArray(after) && !isScalarList(after)) {
    return { before: summarizeValue(before), after: describeListChange(Array.isArray(before) ? before : [], after) }
  }
  return { before: summarizeValue(before), after: summarizeValue(after) }
}

export const changedFields = (before: unknown, after: unknown): string[] => {
  const beforeRecord = asRecord(before)
  const afterRecord = asRecord(after)
  return DIFF_FIELDS
    .filter((field) => field in beforeRecord || field in afterRecord)
    .filter((field) => JSON.stringify(beforeRecord[field]) !== JSON.stringify(afterRecord[field]))
}
