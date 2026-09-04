'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'next/navigation'

import { CopilotProposalCard } from '@/components/dashboard/copilot-proposal-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { copilotApi, type CopilotAvailability, type CopilotProposalDetail } from '@/lib/api-copilot'
import { getApiErrorMessage } from '@/lib/api-error'

export default function OperatorMcpProposalPage() {
  const params = useParams<{ proposalId: string }>()
  const [proposal, setProposal] = useState<CopilotProposalDetail | null>(null)
  const [availability, setAvailability] = useState<CopilotAvailability | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([copilotApi.getProposal(params.proposalId, controller.signal), copilotApi.getAvailability(controller.signal)])
      .then(([nextProposal, nextAvailability]) => { setProposal(nextProposal); setAvailability(nextAvailability) })
      .catch((loadError) => { if (!controller.signal.aborted) setError(getApiErrorMessage(loadError, 'Could not load this proposal.')) })
    return () => controller.abort()
  }, [params.proposalId])

  if (error) return <ProposalShell><p role="alert" className="text-sm text-destructive">{error}</p></ProposalShell>
  if (!proposal || !availability) return <ProposalShell><Spinner className="h-6 w-6" /></ProposalShell>

  return (
    <ProposalShell>
      <Card className="w-full max-w-2xl">
        <CardHeader><CardTitle>Review proposal from Radioso MCP</CardTitle></CardHeader>
        <CardContent>
          <CopilotProposalCard
            proposal={proposal}
            canApply={availability.available && (availability.applyableProposalTargets ?? []).includes(proposal.targetType)}
            onOpenEntity={() => undefined}
          />
        </CardContent>
      </Card>
    </ProposalShell>
  )
}

function ProposalShell({ children }: { children: ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center bg-muted/20 p-4 sm:p-8">{children}</main>
}
