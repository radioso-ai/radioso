'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'

import { streamWorkspaceEvents, type WorkspacePushEvent } from './api-events'
import { useWorkspace } from './workspace-context'

const INVALIDATION_DEBOUNCE_MS = 300

interface WorkspaceEventSubscription {
  changeKinds: ReadonlySet<string>
  onInvalidate: () => void
  seenVersions: Set<string>
  timeoutId: number | null
}

interface WorkspaceEventsContextValue {
  subscribe: (changeKinds: readonly string[], onInvalidate: () => void) => () => void
}

const WorkspaceEventsContext = createContext<WorkspaceEventsContextValue | null>(null)

const eventVersionKey = (event: WorkspacePushEvent): string =>
  `${event.resourceType}:${event.resourceId}:${event.version}`

export function WorkspaceEventsProvider({ children }: { children: ReactNode }) {
  const { activeWorkspaceId } = useWorkspace()
  const subscriptionsRef = useRef(new Map<number, WorkspaceEventSubscription>())
  const nextSubscriptionIdRef = useRef(0)

  const scheduleInvalidation = useCallback((subscription: WorkspaceEventSubscription) => {
    if (subscription.timeoutId !== null) {
      window.clearTimeout(subscription.timeoutId)
    }

    subscription.timeoutId = window.setTimeout(() => {
      subscription.timeoutId = null
      subscription.seenVersions.clear()
      subscription.onInvalidate()
    }, INVALIDATION_DEBOUNCE_MS)
  }, [])

  const dispatch = useCallback((event: WorkspacePushEvent) => {
    for (const subscription of subscriptionsRef.current.values()) {
      if (!subscription.changeKinds.has(event.changeKind)) {
        continue
      }

      const versionKey = eventVersionKey(event)
      if (subscription.seenVersions.has(versionKey)) {
        continue
      }

      subscription.seenVersions.add(versionKey)
      scheduleInvalidation(subscription)
    }
  }, [scheduleInvalidation])

  const notifyReconnect = useCallback(() => {
    for (const subscription of subscriptionsRef.current.values()) {
      subscription.onInvalidate()
    }
  }, [])

  const subscribe = useCallback((changeKinds: readonly string[], onInvalidate: () => void) => {
    const subscriptionId = nextSubscriptionIdRef.current
    nextSubscriptionIdRef.current += 1
    const subscription: WorkspaceEventSubscription = {
      changeKinds: new Set(changeKinds),
      onInvalidate,
      seenVersions: new Set(),
      timeoutId: null,
    }
    subscriptionsRef.current.set(subscriptionId, subscription)

    return () => {
      subscriptionsRef.current.delete(subscriptionId)
      if (subscription.timeoutId !== null) {
        window.clearTimeout(subscription.timeoutId)
      }
    }
  }, [])

  useEffect(() => {
    if (!activeWorkspaceId) {
      return
    }

    const controller = new AbortController()
    void streamWorkspaceEvents({ onReady: notifyReconnect, onPush: dispatch }, controller.signal)
    return () => controller.abort()
  }, [activeWorkspaceId, dispatch, notifyReconnect])

  useEffect(() => () => {
    for (const subscription of subscriptionsRef.current.values()) {
      if (subscription.timeoutId !== null) {
        window.clearTimeout(subscription.timeoutId)
      }
    }
    subscriptionsRef.current.clear()
  }, [])

  const value = useMemo(() => ({ subscribe }), [subscribe])
  return <WorkspaceEventsContext.Provider value={value}>{children}</WorkspaceEventsContext.Provider>
}

/** Subscribe a mounted dashboard surface to content-free workspace invalidation hints. */
export const useWorkspaceEvents = (
  changeKinds: readonly string[],
  onInvalidate: () => void,
): void => {
  const context = useContext(WorkspaceEventsContext)
  if (!context) {
    throw new Error('useWorkspaceEvents must be used within a WorkspaceEventsProvider')
  }

  const onInvalidateRef = useRef(onInvalidate)
  useEffect(() => {
    onInvalidateRef.current = onInvalidate
  }, [onInvalidate])
  const changeKindsKey = changeKinds.join('\u0000')

  useEffect(() => {
    const kinds = changeKindsKey ? changeKindsKey.split('\u0000') : []
    return context.subscribe(kinds, () => onInvalidateRef.current())
  }, [changeKindsKey, context])
}
