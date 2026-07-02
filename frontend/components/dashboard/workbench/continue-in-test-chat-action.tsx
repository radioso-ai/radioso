'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquarePlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { chatApi } from '@/lib/api'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { useAuth } from '@/lib/auth-context'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * Forks a real conversation into a test-session copy (`authenticated_chat`) and
 * opens the agent's chat workbench seeded with that fork, so the operator can
 * keep chatting from where it left off without touching the original.
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
      const { conversationId: forkId } = await chatApi.forkConversation(conversationId)
      const workspacePublicRouteKey = activeWorkspaceId
        ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.publicRouteKey
        : undefined
      router.push(
        buildDashboardHref(user.accountId, {
          section: 'agents',
          agentId,
          agentTab: 'chat',
          agentChatConversationId: forkId,
          workspaceId: activeWorkspaceId ?? undefined,
          workspacePublicRouteKey,
        }),
      )
      // Navigation unmounts this component; leave `busy` set so the button can't
      // fire twice during the transition.
    } catch {
      setError('Could not open a test copy.')
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
      title={error ?? 'Fork this conversation into a test chat you can keep continuing'}
    >
      <MessageSquarePlus className="h-3.5 w-3.5" />
      {busy ? 'Opening…' : 'Continue in test chat'}
    </Button>
  )
}
