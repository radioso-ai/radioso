'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquarePlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { agentRevisionsApi } from '@/lib/api-agent-revisions'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { useAuth } from '@/lib/auth-context'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * Starts a private test execution seeded with a real conversation's thread and
 * opens it in the agent's Test Chat, so the operator can keep chatting from
 * where it left off without touching the original.
 *
 * The seed runs against the currently published revision. Conversations do not
 * record the revision they ran on, so a publish after the conversation means the
 * continuation follows the newer behaviour. Test values are left empty, the same
 * starting point a fresh single-revision run in Test Chat uses.
 */
export function ContinueInTestChatAction({
  conversationId,
  agentId,
}: {
  conversationId: string
  agentId: string
}) {
  const router = useRouter()
  const { user } = useAuth()
  const { activeWorkspaceId, workspaces } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleContinue = async () => {
    if (!user || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const revisionState = await agentRevisionsApi.getState(agentId)
      const publishedRevisionId = revisionState.publishedRevision?.id
      if (!publishedRevisionId) {
        throw new Error('This agent has no published version to continue on.')
      }
      const execution = await agentRevisionsApi.startTest(agentId, {
        mode: 'single',
        revisionIds: [publishedRevisionId],
        testValues: [],
        seedConversationId: conversationId,
      })
      const workspacePublicRouteKey = activeWorkspaceId
        ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.publicRouteKey
        : undefined
      router.push(
        buildDashboardHref(user.accountId, {
          section: 'agents',
          agentId,
          agentTab: 'chat',
          agentTestExecutionId: execution.id,
          workspaceId: activeWorkspaceId ?? undefined,
          workspacePublicRouteKey,
        }),
      )
      // Navigation unmounts this component; leave `busy` set so the button can't
      // fire twice during the transition.
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Could not open a test copy.')
      setBusy(false)
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="gap-1.5"
      onClick={() => void handleContinue()}
      disabled={busy}
      title={error ?? 'Continue this conversation in a test chat that leaves the original untouched'}
    >
      <MessageSquarePlus className="h-3.5 w-3.5" />
      {busy ? 'Opening…' : 'Continue in test chat'}
    </Button>
  )
}
