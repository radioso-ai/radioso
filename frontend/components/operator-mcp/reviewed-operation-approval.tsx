'use client'

import { useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Globe, Zap } from 'lucide-react'

import { ProposalChangesTable } from '@/components/dashboard/copilot-proposal-changes'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { copilotApi, type CopilotProposalDetail } from '@/lib/api-copilot'
import { buildReviewedOperationView } from '@/lib/reviewed-operation-view'

export function ReviewedOperationApproval({ proposal }: { proposal: CopilotProposalDetail }) {
  const operation = proposal.reviewedOperation!
  const [status, setStatus] = useState(operation.approvedAt ? 'approved' : 'pending')
  const [error, setError] = useState<string | null>(null)
  const [showFullReview, setShowFullReview] = useState(false)
  const clientName = operation.clientName ?? 'your MCP client'
  if (operation.requirement === 'conversation') return <p className="text-sm text-muted-foreground">Confirmed in your MCP conversation.</p>
  if (status === 'approved') return <p className="text-sm">Approved. Return to {clientName} to finish.</p>
  const view = buildReviewedOperationView(proposal)

  const approve = () => void copilotApi.approveProposal(proposal.id, operation.reviewDigest, proposal.workspaceId)
    .then((result) => { if (result.status === 'approved') setStatus('approved'); else setError('This review is no longer available.') })
    .catch(() => setError('Could not record approval.'))
  const decline = () => void copilotApi.dismissProposal(proposal.id, proposal.workspaceId, 'declined')
    .then(() => setStatus('declined'))
    .catch(() => setError('Could not decline this review.'))

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{view.label}</p>
        {view.summary ? <p className="text-sm text-muted-foreground">{view.summary}</p> : null}
        <p className="text-xs text-muted-foreground">Requested by {clientName}. Review code: {operation.reviewCode}</p>
      </div>
      <ul className="space-y-1 text-sm">
        {view.effects.map((effect) => (
          <li key={effect} className="flex items-center gap-2"><Zap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />{effect}</li>
        ))}
        {view.reach ? (
          <li className="flex items-center gap-2"><Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />Changes who can reach the agent.</li>
        ) : null}
        {view.agents.names.length > 0 ? (
          <li className="flex items-center gap-2"><Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />Affects {view.agents.names.join(', ')}{view.agents.hasMore ? ' and more' : ''}</li>
        ) : null}
      </ul>
      {view.rows.length > 0 ? <ProposalChangesTable rows={view.rows} /> : null}
      <Collapsible open={showFullReview} onOpenChange={setShowFullReview}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            {showFullReview ? <ChevronDown className="mr-1.5 h-4 w-4" aria-hidden /> : <ChevronRight className="mr-1.5 h-4 w-4" aria-hidden />}
            {showFullReview ? 'Hide full review' : 'Show full review'}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(operation.review, null, 2)}</pre>
        </CollapsibleContent>
      </Collapsible>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={approve}>Approve</Button>
        <Button type="button" variant="outline" size="sm" onClick={decline}>Decline</Button>
      </div>
      {status === 'declined' ? <p className="text-sm">Declined.</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
