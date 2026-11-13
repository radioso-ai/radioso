'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agentsApi } from '@/lib/api'
import { agentRevisionsApi, type TestExecutionHistoryDetail } from '@/lib/api-agent-revisions'
import {
  photoReadingLocale,
  readWithRetries,
  testChatPhotoAvailability,
  testChatPhotoSendOutcome,
  type TestChatPhotoAvailability,
  type TestChatPhotoSendOutcome,
} from '@/lib/test-chat-photos'
import { useFileDropGuard } from '@/lib/use-file-drop-guard'
import { useVisitorImageAttachments } from '@/lib/use-visitor-image-attachments'
import { canSendMessage, emptyAttachments } from '@/lib/visitor-image-attachments'
import type { ComposerImages } from '@/lib/visitor-image-types'

/** Whether the agent takes photos, read when Test Chat opens; `off` until the agent is read. */
function useTestChatPhotoAvailability(agentId: string): TestChatPhotoAvailability {
  const [availability, setAvailability] = useState<TestChatPhotoAvailability>('off')
  useEffect(() => {
    let active = true
    agentsApi.getAgent(agentId).then((agent) => {
      if (active) setAvailability(testChatPhotoAvailability(agent))
    }, () => undefined)
    return () => {
      active = false
    }
  }, [agentId])
  return availability
}

/** How long to wait before each further read of the stored readings, which a dropped connection can delay. */
const STORED_READINGS_RETRY_MS = [750, 1_500, 3_000] as const

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One send's photos: the test it went to and the ids it carried, empty for a message without photos. */
interface TestChatPhotoSend {
  executionId: string
  imageIds: readonly string[]
}

/**
 * The photos of Test Chat's next message, attached as a visitor attaches them: picked, pasted or
 * dropped, shrunk in the browser, uploaded and read by the agent's chat model before the message
 * goes. Offered exactly when the agent takes photos from visitors.
 *
 * A send takes the uploaded photos out of the composer; `settle` lets them go once the test took
 * the message, drops them with a reason when it refused them, and gives them back when the message
 * never reached it, and answers which, for the words too. Once a test took photos, `onStored`
 * receives the test as stored, which carries the agent's reading of each one; a failed read is
 * tried again, and the photos stay pending rather than read as unreadable if it never succeeds.
 * Photos are read in the operator's browser language, as a visitor's are in the visitor's, and go up
 * for the test the next message goes to, whose revisions decide whether it takes them.
 */
export function useTestChatPhotos(
  agentId: string,
  onStored: (detail: TestExecutionHistoryDetail) => void,
  /** The test the next message goes to, started as a send would start it; null when none could start. */
  prepareExecution: () => Promise<string | null>,
) {
  const availability = useTestChatPhotoAvailability(agentId)
  const acceptsImages = availability === 'available'
  const prepareRef = useRef(prepareExecution)
  useEffect(() => {
    prepareRef.current = prepareExecution
  }, [prepareExecution])
  // Photos attached together wait for one test to start, never one each.
  const preparing = useRef<Promise<string | null> | null>(null)
  const upload = useCallback(async (file: File, signal: AbortSignal) => {
    preparing.current ??= prepareRef.current().finally(() => { preparing.current = null })
    const executionId = await preparing.current
    if (!executionId) throw new Error('test_chat_not_started')
    return agentRevisionsApi.uploadTestChatImage(agentId, executionId, file, { locale: photoReadingLocale(navigator.language), signal })
  }, [agentId])
  const { attachments, state } = useVisitorImageAttachments(upload)
  useFileDropGuard(acceptsImages)
  const onStoredRef = useRef(onStored)
  useEffect(() => {
    onStoredRef.current = onStored
  }, [onStored])

  const composerImages = useMemo<ComposerImages | undefined>(
    () => (acceptsImages
      ? {
          attachments: state.attachments,
          canAttach: true,
          limitReached: state.limitReached,
          sendFailure: state.sendFailure,
          onFiles: (files) => attachments.addFiles(files),
          onRemove: (key) => attachments.remove(key),
        }
      : undefined),
    [acceptsImages, attachments, state],
  )

  /** Text, or uploaded photos, and no photo still uploading. */
  const canSend = useCallback((text: string) => canSendMessage(text, acceptsImages ? state : emptyAttachments), [acceptsImages, state])

  /** The uploaded photos' ids for the message about to be sent, in the order they were attached. */
  const take = useCallback((): string[] => (acceptsImages ? attachments.takeForSend() : []), [acceptsImages, attachments])

  const settle = useCallback((send: TestChatPhotoSend, result: { taken: true } | { taken: false; error: unknown }): TestChatPhotoSendOutcome['kind'] => {
    const outcome = testChatPhotoSendOutcome(result)
    if (send.imageIds.length === 0) return outcome.kind
    if (outcome.kind === 'returned') {
      // The composer's error line says why; the photos come back as they were.
      attachments.restoreSend(null)
      return outcome.kind
    }
    attachments.finishSend()
    if (outcome.kind === 'refused') {
      attachments.notice('unavailable')
      return outcome.kind
    }
    void readWithRetries(() => agentRevisionsApi.getTestExecution(agentId, send.executionId), STORED_READINGS_RETRY_MS, wait)
      .then((stored) => { if (stored) onStoredRef.current(stored.execution) })
    return outcome.kind
  }, [agentId, attachments])

  return { availability, composerImages, canSend, take, settle }
}
