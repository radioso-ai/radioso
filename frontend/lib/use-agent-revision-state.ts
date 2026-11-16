'use client'

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import { AGENT_DRAFT_SAVED_EVENT } from '@/lib/agent-draft-save-port'
import { agentRevisionsApi, type AgentRevisionState } from '@/lib/api-agent-revisions'

/** A clean saved draft holds the published scoped authoring, so publishing it would allocate a version nobody can tell apart from the live one. */
export const hasPublishableChanges = (state: AgentRevisionState) => state.status !== 'draft_clean'

interface AgentRevisionStateHandle {
  /** Null until the first read lands, and while the last one failed. */
  state: AgentRevisionState | null
  /** The last read's failure; null once a read succeeds. */
  error: string | null
  setState: Dispatch<SetStateAction<AgentRevisionState | null>>
  setError: Dispatch<SetStateAction<string | null>>
  reload: () => Promise<void>
  /**
   * Counts requests for this agent. A caller that starts its own request bumps it, so a read that
   * is still in flight when that request starts is recognized as stale and dropped.
   */
  requestGenerationRef: MutableRefObject<number>
}

/**
 * The agent's draft-versus-published state, read from the server and re-read whenever a draft save
 * or a publication announces itself. The Publish header and the agent menu's Build dot both read it,
 * so there is one place that decides how the state is fetched and when it is stale.
 */
export function useAgentRevisionState(agentId: string | undefined): AgentRevisionStateHandle {
  const [state, setState] = useState<AgentRevisionState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestGenerationRef = useRef(0)

  const reload = useCallback(async () => {
    if (!agentId) return
    // Bump before the request so an earlier call's response, arriving after a
    // newer one already applied, is recognized as stale and discarded.
    const generation = ++requestGenerationRef.current
    try {
      const next = await agentRevisionsApi.getState(agentId)
      if (requestGenerationRef.current !== generation) return
      setState(next)
      setError(null)
    } catch (cause) {
      if (requestGenerationRef.current !== generation) return
      setState(null)
      setError(cause instanceof Error ? cause.message : 'Draft publication state is unavailable.')
    }
  }, [agentId])

  useEffect(() => {
    const timeout = window.setTimeout(() => { void reload() }, 0)
    return () => window.clearTimeout(timeout)
  }, [reload])

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ agentId?: string }>).detail?.agentId === agentId) void reload()
    }
    window.addEventListener(AGENT_DRAFT_SAVED_EVENT, refresh)
    return () => window.removeEventListener(AGENT_DRAFT_SAVED_EVENT, refresh)
  }, [agentId, reload])

  return { state, error, setState, setError, reload, requestGenerationRef }
}
