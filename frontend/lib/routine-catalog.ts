'use client'

import { useEffect, useState } from 'react'

import { routinesApi } from './api'

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map()

interface RoutineCatalogState {
  agentId: string
  names: Map<string, string>
}

/**
 * Resolves a routine's display name from its id for diagnostics surfaces. The
 * turn trace only carries the routine id (a definition id), so — as with the
 * skill catalog — the readable name is fetched separately and joined back by id.
 *
 * Pass `null`/`undefined` for the agent to skip the fetch (e.g. when the
 * conversation has no routine turns to label). While a fetch is in flight, or
 * for a different agent than the loaded one, an empty map is returned so stale
 * names never leak across conversations.
 */
export const useRoutineCatalog = (
  agentId: string | null | undefined,
): ReadonlyMap<string, string> => {
  const [loaded, setLoaded] = useState<RoutineCatalogState | null>(null)

  useEffect(() => {
    if (!agentId) {
      return
    }

    let cancelled = false
    void routinesApi.listRoutines(agentId)
      .then((response) => {
        if (cancelled) {
          return
        }
        setLoaded({
          agentId,
          names: new Map(response.routines.map((routine) => [routine.id, routine.name])),
        })
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ agentId, names: new Map() })
        }
      })

    return () => {
      cancelled = true
    }
  }, [agentId])

  return loaded && loaded.agentId === agentId ? loaded.names : EMPTY_NAMES
}
