'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react'

import { AGENT_DRAFT_SAVED_EVENT } from '@/lib/agent-draft-save-port'
import { agentRevisionsApi, type AgentRevisionState } from '@/lib/api-agent-revisions'
import { useAgents } from '@/lib/agents-context'

/** A clean saved draft holds the published scoped authoring, so publishing it would allocate a version nobody can tell apart from the live one. */
export const hasPublishableChanges = (state: AgentRevisionState) => state.status !== 'draft_clean'

/**
 * The selected agent's draft-versus-published state, read from the server and read again whenever a
 * draft save or a publication announces itself. The Publish header and the agent menu's Build dot both
 * read it, so there is one place that decides how it is fetched and when it is stale.
 */
export interface AgentRevisionPort {
  /** Null until the first read of this agent lands, and while the last one failed. */
  state: AgentRevisionState | null
  /** The last read's failure; null once a read succeeds. */
  error: string | null
  setState: Dispatch<SetStateAction<AgentRevisionState | null>>
  setError: Dispatch<SetStateAction<string | null>>
  reload: () => Promise<void>
  /**
   * Counts requests. A caller that starts its own request bumps it, so a read that is still in flight
   * when that request starts is recognized as stale and dropped.
   */
  requestGenerationRef: MutableRefObject<number>
}

const detachedPort: AgentRevisionPort = {
  state: null,
  error: null,
  setState: () => undefined,
  setError: () => undefined,
  reload: async () => undefined,
  requestGenerationRef: { current: 0 },
}

const AgentRevisionContext = createContext<AgentRevisionPort>(detachedPort)

export const useAgentRevision = (): AgentRevisionPort => useContext(AgentRevisionContext)

interface Held<T> {
  agentId: string
  value: T
}

export function AgentRevisionProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { selectedAgent } = useAgents()
  const agentId = selectedAgent?.id
  // What was read belongs to the agent it was read for; it is never shown for another.
  const [heldState, setHeldState] = useState<Held<AgentRevisionState | null> | null>(null)
  const [heldError, setHeldError] = useState<Held<string | null> | null>(null)
  const requestGenerationRef = useRef(0)

  const reload = useCallback(async () => {
    if (!agentId) return
    // Bump before the request so an earlier call's response, arriving after a newer one already
    // applied, is recognized as stale and discarded.
    const generation = ++requestGenerationRef.current
    try {
      const next = await agentRevisionsApi.getState(agentId)
      if (requestGenerationRef.current !== generation) return
      setHeldState({ agentId, value: next })
      setHeldError({ agentId, value: null })
    } catch (cause) {
      if (requestGenerationRef.current !== generation) return
      setHeldState({ agentId, value: null })
      setHeldError({ agentId, value: cause instanceof Error ? cause.message : 'Draft publication state is unavailable.' })
    }
  }, [agentId])

  useEffect(() => {
    if (!enabled) return
    const timeout = window.setTimeout(() => { void reload() }, 0)
    return () => window.clearTimeout(timeout)
  }, [enabled, reload])

  useEffect(() => {
    if (!enabled) return
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ agentId?: string }>).detail?.agentId === agentId) void reload()
    }
    window.addEventListener(AGENT_DRAFT_SAVED_EVENT, refresh)
    return () => window.removeEventListener(AGENT_DRAFT_SAVED_EVENT, refresh)
  }, [agentId, enabled, reload])

  const setState = useCallback<Dispatch<SetStateAction<AgentRevisionState | null>>>((action) => {
    if (!agentId) return
    setHeldState((previous) => {
      const before = previous?.agentId === agentId ? previous.value : null
      return { agentId, value: typeof action === 'function' ? action(before) : action }
    })
  }, [agentId])
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>((action) => {
    if (!agentId) return
    setHeldError((previous) => {
      const before = previous?.agentId === agentId ? previous.value : null
      return { agentId, value: typeof action === 'function' ? action(before) : action }
    })
  }, [agentId])

  const port = useMemo<AgentRevisionPort>(() => ({
    state: heldState && heldState.agentId === agentId ? heldState.value : null,
    error: heldError && heldError.agentId === agentId ? heldError.value : null,
    setState,
    setError,
    reload,
    requestGenerationRef,
  }), [agentId, heldError, heldState, reload, setError, setState])

  return <AgentRevisionContext.Provider value={port}>{children}</AgentRevisionContext.Provider>
}
