import { ProposalValue } from '@/components/dashboard/copilot-proposal-value'
import { displayPath, type CopilotProposalDiffRow } from '@/lib/copilot-proposal-diff'

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
