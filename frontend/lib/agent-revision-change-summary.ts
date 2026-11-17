/** Readable summaries of a revision's scoped changes, so the review dialog never prints raw JSON. */

const DIFF_FIELDS = ['source', 'surfacing', 'enabled', 'resolverSkillId', 'maxAgeSeconds', 'resolverTimeoutMs', 'action', 'condition', 'priority', 'version', 'activation', 'steps', 'transitions', 'terminals', 'completionExport'] as const

export const changeFieldLabels: Record<string, string> = {
  source: 'Source', surfacing: 'Surfacing', enabled: 'Enabled', resolverSkillId: 'Resolver skill', maxAgeSeconds: 'Maximum age', resolverTimeoutMs: 'Resolver timeout', action: 'Action', condition: 'Condition', priority: 'Priority', version: 'Version', activation: 'Activation', steps: 'Steps', transitions: 'Transitions', terminals: 'Terminal states', completionExport: 'Completion export',
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** Scalars print as-is; structured values collapse to a count or a presence word. */
export const summarizeChangeValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  return 'Set'
}

export const changedFields = (before: unknown, after: unknown): string[] => {
  const beforeRecord = asRecord(before)
  const afterRecord = asRecord(after)
  return DIFF_FIELDS
    .filter((field) => field in beforeRecord || field in afterRecord)
    .filter((field) => JSON.stringify(beforeRecord[field]) !== JSON.stringify(afterRecord[field]))
}

/** Candidate labels embed a creation timestamp; show it the way the rest of the dashboard does. */
const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export const revisionDisplayLabel = (revision: { kind: 'candidate' | 'published'; label: string; createdAt: string }): string => {
  if (revision.kind === 'published') return revision.label
  const created = new Date(revision.createdAt)
  if (Number.isNaN(created.getTime())) return 'Draft'
  return `Draft · ${timestampFormatter.format(created)}`
}
