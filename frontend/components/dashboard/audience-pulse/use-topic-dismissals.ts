'use client'

import { useCallback, useRef, useState } from 'react'

import { audiencePulseApi } from '@/lib/api-audience-pulse'
import type { DismissalChoices } from '@/lib/audience-pulse-queue'

/**
 * The operator's "not for us" choices since the report was read, applied at once and saved behind
 * them. Calls for one topic run in order, so an Undo never overtakes the dismissal it undoes; a
 * failed save puts the topic back where it was and reports it.
 */
export function useTopicDismissals(onSaveFailed: () => void): {
  choices: DismissalChoices
  choose: (topicId: string, dismissed: boolean) => void
} {
  const [choices, setChoices] = useState<Record<string, boolean>>({})
  const pendingRef = useRef(new Map<string, Promise<void>>())

  const choose = useCallback((topicId: string, dismissed: boolean) => {
    setChoices((current) => ({ ...current, [topicId]: dismissed }))
    const save = async () => {
      try {
        await (dismissed ? audiencePulseApi.dismissTopic(topicId) : audiencePulseApi.restoreTopic(topicId))
      } catch {
        // Only revert a choice the operator has not changed again since.
        setChoices((current) => (current[topicId] === dismissed ? { ...current, [topicId]: !dismissed } : current))
        onSaveFailed()
      }
    }
    const previous = pendingRef.current.get(topicId) ?? Promise.resolve()
    pendingRef.current.set(topicId, previous.then(save))
  }, [onSaveFailed])

  return { choices, choose }
}
