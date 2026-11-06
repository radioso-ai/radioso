import { useEffect } from 'react'

import { registerAgentDraftSaver } from '@/lib/agent-draft-save-port'

/** Fired on the window, with `{ agentId }`, by the page header's Save draft. */
const SAVE_AGENT_DRAFT_EVENT = 'radioso:save-agent-draft'

/**
 * Makes `save` the agent's one draft saver while the page is mounted: Test Chat reaches it
 * through the save port, and the header's Save draft reaches it through the window event. An
 * `agentId` of `undefined` registers nothing.
 */
export function useAgentDraftSaver({
  agentId,
  save,
  isDirty,
}: {
  agentId: string | undefined
  save: () => Promise<void>
  isDirty: boolean
}): void {
  useEffect(() => {
    if (!agentId) return
    const unregister = registerAgentDraftSaver(agentId, { save, isDirty: () => isDirty })
    const handler = (event: Event) => {
      if ((event as CustomEvent<{ agentId?: string }>).detail?.agentId === agentId) void save().catch(() => undefined)
    }
    window.addEventListener(SAVE_AGENT_DRAFT_EVENT, handler)
    return () => {
      unregister()
      window.removeEventListener(SAVE_AGENT_DRAFT_EVENT, handler)
    }
  }, [agentId, isDirty, save])
}
