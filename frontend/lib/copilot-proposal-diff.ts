/** Pure comparison of a proposal's current and proposed values, shared by every surface that shows a proposal. */
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
)

export interface CopilotProposalDiffRow {
  path: string
  current: unknown
  proposed: unknown
  kind: 'added' | 'changed' | 'removed'
}

export const displayPath = (path: string) => {
  if (path === '$') return 'Value'
  if (path === '$.excludes') return 'Replaces'
  if (path === '$.priority') return 'Priority'
  return path.replace(/^\$\./, '')
}

const valuesEqual = (left: unknown, right: unknown) => {
  if (Object.is(left, right)) return true
  // Absent and null both mean "no value", so a create does not list a null as a change.
  if ((left === undefined || left === null) && (right === undefined || right === null)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

const appendDiff = (rows: CopilotProposalDiffRow[], path: string, current: unknown, proposed: unknown) => {
  if (valuesEqual(current, proposed)) return
  if ((current === null || current === undefined) && isRecord(proposed)) {
    const keys = Object.keys(proposed).sort()
    for (const key of keys) appendDiff(rows, `${path}.${key}`, undefined, proposed[key])
    return
  }
  if (isRecord(current) && (proposed === null || proposed === undefined)) {
    for (const key of Object.keys(current).sort()) appendDiff(rows, `${path}.${key}`, current[key], undefined)
    return
  }
  if (isRecord(current) && isRecord(proposed)) {
    const keys = [...new Set([...Object.keys(current), ...Object.keys(proposed)])].sort()
    for (const key of keys) appendDiff(rows, `${path}.${key}`, current[key], proposed[key])
    return
  }
  rows.push({
    path,
    current,
    proposed,
    kind: current === undefined ? 'added' : proposed === undefined ? 'removed' : 'changed',
  })
}

export const buildCopilotProposalDiff = (preview: { current: unknown; proposed: unknown }): CopilotProposalDiffRow[] => {
  const rows: CopilotProposalDiffRow[] = []
  appendDiff(rows, '$', preview.current, preview.proposed)
  return rows
}
