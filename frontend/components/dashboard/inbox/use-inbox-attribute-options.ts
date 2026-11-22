'use client'

import { useCallback, useEffect, useState } from 'react'

import { getApiErrorStatus } from '@/lib/api-error'
import { contextVariablesApi } from '@/lib/api-context-variables'
import { buildAttributeFilterChoices, type AttributeFilterChoice } from '@/lib/conversation-attributes'

export interface InboxAttributeOptions {
  /** The workspace's Choice attributes; empty until loaded, when not enabled, or for another workspace. */
  choices: AttributeFilterChoice[]
  /** The read failed for a reason other than the operator not being allowed to read attributes. */
  unavailable: boolean
  /** Reads the catalog again, such as after the list refused a filter whose attribute changed. */
  reload: () => void
}

interface Loaded {
  workspaceId: string
  choices: AttributeFilterChoice[]
  unavailable: boolean
}

/** The workspace's Choice attributes for the Inbox's attribute filter, kept to the workspace that read them. */
export const useInboxAttributeOptions = ({ workspaceId, enabled }: { workspaceId: string; enabled: boolean }): InboxAttributeOptions => {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [readCount, setReadCount] = useState(0)

  useEffect(() => {
    if (!enabled || !workspaceId) {
      return
    }
    let cancelled = false

    void contextVariablesApi.listCatalog()
      .then((response) => {
        if (!cancelled) {
          setLoaded({ workspaceId, choices: buildAttributeFilterChoices(response.contextVariables), unavailable: false })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          // An operator who may not read attributes simply has no attribute filter.
          setLoaded({ workspaceId, choices: [], unavailable: getApiErrorStatus(error) !== 403 })
        }
      })

    return () => {
      cancelled = true
    }
  }, [enabled, workspaceId, readCount])

  const reload = useCallback(() => setReadCount((count) => count + 1), [])
  const current = enabled && loaded?.workspaceId === workspaceId ? loaded : null
  return { choices: current?.choices ?? [], unavailable: current?.unavailable ?? false, reload }
}
