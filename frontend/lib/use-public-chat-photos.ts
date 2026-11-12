'use client'

import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'

import type { WebsiteEmbedCopy } from '@/lib/embed-widget'
import type { UnsentImageSend } from '@/lib/public-chat-errors'
import { useFileDropGuard } from '@/lib/use-file-drop-guard'
import { useVisitorImageAttachments } from '@/lib/use-visitor-image-attachments'
import { canSendMessage, emptyAttachments } from '@/lib/visitor-image-attachments'
import type { ComposerImages, VisitorImageThreadConfig } from '@/lib/visitor-image-types'

interface PublicChatPhotosInput {
  /** Whether the agent takes photos in this chat. */
  acceptsImages: boolean
  uploadImage: (file: File, signal: AbortSignal) => Promise<{ id: string }>
  sendMessage: (
    content: string,
    inputMetadata: { method: 'typed' },
    options: { imageIds: string[]; onNotSent: (reason: UnsentImageSend) => void },
  ) => Promise<void>
  publicChatToken: string
  copy: Pick<WebsiteEmbedCopy, 'publicChatImageAlt' | 'publicChatImageUnavailableLabel'>
  input: string
  setInput: Dispatch<SetStateAction<string>>
}

/**
 * The photos of the visitor's public chat: what the composer shows, whether the message can go,
 * how the thread reads a photo, and the send.
 *
 * Photos leave the composer when the message is sent but come back with the words if the server
 * did not take them, since each one already cost a read; only a send the server took, or refused
 * the photos of, lets them go. Photos the chat stops offering are dropped with a notice, and
 * neither count toward a send nor go with one.
 */
export function usePublicChatPhotos({ acceptsImages, uploadImage, sendMessage, publicChatToken, copy, input, setInput }: PublicChatPhotosInput) {
  const { attachments, state } = useVisitorImageAttachments(uploadImage)
  useFileDropGuard(acceptsImages)
  useEffect(() => {
    if (!acceptsImages && state.attachments.length > 0) {
      attachments.clear()
      attachments.notice('unavailable')
    }
  }, [acceptsImages, attachments, state.attachments.length])
  // What the composer shows: the controls while the agent takes photos, and a notice that outlives them.
  const composerImages = useMemo<ComposerImages | undefined>(
    () => (acceptsImages || state.sendFailure
      ? {
          attachments: acceptsImages ? state.attachments : [],
          canAttach: acceptsImages,
          limitReached: state.limitReached,
          sendFailure: state.sendFailure,
          onFiles: (files) => attachments.addFiles(files),
          onRemove: (key) => attachments.remove(key),
        }
      : undefined),
    [acceptsImages, attachments, state],
  )
  const visitorImages = useMemo<VisitorImageThreadConfig>(
    () => ({
      source: { kind: 'public', publicChatToken },
      altLabel: copy.publicChatImageAlt,
      unavailableLabel: copy.publicChatImageUnavailableLabel,
    }),
    [copy.publicChatImageAlt, copy.publicChatImageUnavailableLabel, publicChatToken],
  )
  const send = useCallback(async (text: string) => {
    const imageIds = acceptsImages ? attachments.takeForSend() : []
    setInput('')
    let notSent = false
    await sendMessage(text, { method: 'typed' }, {
      imageIds,
      onNotSent: (reason) => {
        notSent = true
        setInput((current) => current || text)
        if (reason === 'images_refused') {
          attachments.finishSend()
          attachments.notice('unavailable')
        } else {
          attachments.restoreSend(reason === 'not_sent' ? 'not_sent' : null)
        }
      },
    })
    if (!notSent) attachments.finishSend()
  }, [acceptsImages, attachments, sendMessage, setInput])
  const clear = useCallback(() => attachments.clear(), [attachments])

  return { composerImages, visitorImages, canSend: canSendMessage(input, acceptsImages ? state : emptyAttachments), send, clear }
}
