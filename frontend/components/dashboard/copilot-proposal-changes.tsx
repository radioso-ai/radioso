import { ProposalValue } from '@/components/dashboard/copilot-proposal-value'

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
)

interface CopilotProposalDiffRow {
  path: string
  current: unknown
  proposed: unknown
  kind: 'added' | 'changed' | 'removed'
}

const displayPath = (path: string) => {
  if (path === '$') return 'Value'
  if (path === '$.excludes') return 'Replaces'
  if (path === '$.priority') return 'Priority'
  return path.replace(/^\$\./, '')
}

const valuesEqual = (left: unknown, right: unknown) => {
  if (Object.is(left, right)) return true
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


/** The Field / Current / Proposed grid every proposal surface shows for a change. */
export function ProposalChangesTable({ rows }: { rows: CopilotProposalDiffRow[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border/70 text-xs" aria-label="Proposal changes">
      <div className="grid grid-cols-[minmax(5rem,.7fr)_minmax(0,1fr)_minmax(0,1fr)] border-b border-border/70 bg-muted/30 px-3 py-2 font-medium">
        <span>Field</span><span>Current</span><span>Proposed</span>
      </div>
      {rows.map((row) => (
        <div className="grid grid-cols-[minmax(5rem,.7fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-border/50 px-3 py-2 last:border-b-0" key={row.path}>
          <span className="font-medium text-muted-foreground">{displayPath(row.path)}</span>
          <span className="break-words text-muted-foreground"><ProposalValue value={row.current} /></span>
          <span className="break-words"><ProposalValue value={row.proposed} /></span>
        </div>
      ))}
    </div>
  )
}
