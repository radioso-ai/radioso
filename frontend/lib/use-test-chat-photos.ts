'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agentsApi } from '@/lib/api'
import { agentRevisionsApi, type TestExecutionHistoryDetail } from '@/lib/api-agent-revisions'
import { testChatPhotoAvailability, testChatPhotoSendOutcome, type TestChatPhotoAvailability } from '@/lib/test-chat-photos'
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
 * never reached it. Once a test took photos, `onStored` receives the test as stored, which carries
 * the agent's reading of each one.
 */
export function useTestChatPhotos(agentId: string, onStored: (detail: TestExecutionHistoryDetail) => void) {
  const availability = useTestChatPhotoAvailability(agentId)
  const acceptsImages = availability === 'available'
  const upload = useCallback((file: File, signal: AbortSignal) => agentRevisionsApi.uploadTestChatImage(agentId, file, signal), [agentId])
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

  const settle = useCallback((send: TestChatPhotoSend, result: { taken: true } | { taken: false; error: unknown }) => {
    if (send.imageIds.length === 0) return
    const outcome = testChatPhotoSendOutcome(result)
    if (outcome.kind === 'returned') {
      attachments.restoreSend(outcome.failure)
      return
    }
    attachments.finishSend()
    if (outcome.kind === 'refused') {
      attachments.notice('unavailable')
      return
    }
    void agentRevisionsApi.getTestExecution(agentId, send.executionId).then(({ execution }) => onStoredRef.current(execution), () => undefined)
  }, [agentId, attachments])

  return { availability, composerImages, canSend, take, settle }
}
