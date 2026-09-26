'use client'

import { useState } from 'react'

import { copilotApi, type CopilotProposalDetail } from '@/lib/api-copilot'

export function ReviewedOperationApproval({ proposal }: { proposal: CopilotProposalDetail }) {
  const operation = proposal.reviewedOperation!
  const [status, setStatus] = useState(operation.approvedAt ? 'approved' : 'pending')
  const [error, setError] = useState<string | null>(null)
  if (operation.requirement === 'conversation') return <p className="text-sm text-muted-foreground">Confirmed in your MCP conversation.</p>
  const effect = [operation.effect.exposure === 'live' ? 'Goes live when applied' : null, operation.effect.reversibility === 'irreversible' ? "Can't be undone" : null, operation.effect.metered ? 'Uses quota' : null].filter(Boolean).join(' · ')
  if (status === 'approved') return <p className="text-sm">Approved. Return to your MCP client to finish.</p>
  return <div className="space-y-4"><p className="text-sm">{effect}</p><p className="text-sm text-muted-foreground">Review code: {operation.reviewCode}</p><pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(operation.review, null, 2)}</pre><div className="flex gap-2"><button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={() => void copilotApi.approveProposal(proposal.id, operation.reviewDigest, proposal.workspaceId).then((result) => { if (result.status === 'approved') setStatus('approved'); else setError('This review is no longer available.') }).catch(() => setError('Could not record approval.'))}>Approve</button><button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={() => void copilotApi.dismissProposal(proposal.id, proposal.workspaceId).then(() => setStatus('declined')).catch(() => setError('Could not decline this review.'))}>Decline</button></div>{status === 'declined' ? <p className="text-sm">Declined.</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}</div>
}
