'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'next/navigation'

import { AuthPage } from '@/components/auth/auth-page'
import { CopilotProposalCard } from '@/components/dashboard/copilot-proposal-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { copilotApi, type CopilotAvailability, type CopilotProposalDetail } from '@/lib/api-copilot'
import { getApiErrorMessage, getApiErrorStatus } from '@/lib/api-error'
import { useAuth } from '@/lib/auth-context'

export default function OperatorMcpProposalPage() {
  const params = useParams<{ proposalId: string }>()
  const { isAuthenticated, isBootstrapping } = useAuth()
  const [proposal, setProposal] = useState<CopilotProposalDetail | null>(null)
  const [availability, setAvailability] = useState<CopilotAvailability | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requiresAuth, setRequiresAuth] = useState(false)

  useEffect(() => {
    if (isBootstrapping) return
    const controller = new AbortController()
    void copilotApi.getProposal(params.proposalId, controller.signal)
      .then(async (nextProposal) => ({
        nextProposal,
        nextAvailability: await copilotApi.getAvailability(controller.signal, nextProposal.workspaceId),
      }))
      .then(({ nextProposal, nextAvailability }) => {
        setError(null)
        setRequiresAuth(false)
        setProposal(nextProposal)
        setAvailability(nextAvailability)
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return
        if (getApiErrorStatus(loadError) === 401) {
          setError(null)
          setRequiresAuth(true)
          return
        }
        setRequiresAuth(false)
        setError(getApiErrorMessage(loadError, 'Could not load this proposal.'))
      })
    return () => controller.abort()
  }, [isAuthenticated, isBootstrapping, params.proposalId])

  if (isBootstrapping) return <ProposalShell><Spinner className="h-6 w-6" /></ProposalShell>
  if (requiresAuth) return <AuthPage returnTo={`/oauth/operator-mcp/proposal/${encodeURIComponent(params.proposalId)}`} />
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
            workspaceId={proposal.workspaceId}
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
