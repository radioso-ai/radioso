import { useCallback, useEffect, useRef } from 'react'

import { registerAgentDraftSaver } from '@/lib/agent-draft-save-port'

/** Fired on the window, with `{ agentId }`, by the page header's Save draft. */
const SAVE_AGENT_DRAFT_EVENT = 'radioso:save-agent-draft'

/**
 * Makes `save` the agent's one draft saver while the page is mounted: Test Chat reaches it
 * through the save port, and the header's Save draft reaches it through the window event. An
 * `agentId` of `undefined` registers nothing.
 *
 * A save that fails leaves the page showing the failure. When the operator then undoes what
 * could not be saved and nothing is left unsaved, `onFailureResolved` runs so the page can drop
 * the failure it was showing.
 */
export function useAgentDraftSaver({
  agentId,
  save,
  isDirty,
  onFailureResolved,
}: {
  agentId: string | undefined
  save: () => Promise<void>
  isDirty: boolean
  onFailureResolved?: () => void
}): void {
  const failedRef = useRef(false)
  const onFailureResolvedRef = useRef(onFailureResolved)
  useEffect(() => {
    onFailureResolvedRef.current = onFailureResolved
  })
  const trackedSave = useCallback(async () => {
    try {
      await save()
      failedRef.current = false
    } catch (error) {
      failedRef.current = true
      throw error
    }
  }, [save])

  useEffect(() => {
    if (isDirty || !failedRef.current) return
    failedRef.current = false
    onFailureResolvedRef.current?.()
  }, [isDirty])

  useEffect(() => {
    if (!agentId) return
    const unregister = registerAgentDraftSaver(agentId, { save: trackedSave, isDirty: () => isDirty })
    const handler = (event: Event) => {
      if ((event as CustomEvent<{ agentId?: string }>).detail?.agentId === agentId) void trackedSave().catch(() => undefined)
    }
    window.addEventListener(SAVE_AGENT_DRAFT_EVENT, handler)
    return () => {
      unregister()
      window.removeEventListener(SAVE_AGENT_DRAFT_EVENT, handler)
    }
  }, [agentId, isDirty, trackedSave])
}
