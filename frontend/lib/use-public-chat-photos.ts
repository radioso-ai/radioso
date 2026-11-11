'use client'

import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'

import type { ComposerImages } from '@/components/chat/visitor-image-composer'
import type { VisitorImageThreadConfig } from '@/components/chat/visitor-image-thumbnails'
import type { WebsiteEmbedCopy } from '@/lib/embed-widget'
import { useVisitorImageAttachments } from '@/lib/use-visitor-image-attachments'
import { canSendMessage } from '@/lib/visitor-image-attachments'

interface PublicChatPhotosInput {
  /** Whether the agent takes photos in this chat. */
  acceptsImages: boolean
  uploadImage: (file: File, signal: AbortSignal) => Promise<{ id: string }>
  sendMessage: (
    content: string,
    inputMetadata: { method: 'typed' },
    options: { imageIds: string[]; onImagesRefused: () => void },
  ) => Promise<void>
  publicChatToken: string
  copy: Pick<WebsiteEmbedCopy, 'publicChatImageAlt' | 'publicChatImageUnavailableLabel'>
  input: string
  setInput: Dispatch<SetStateAction<string>>
}

/**
 * The photos of the visitor's public chat: what the composer shows, whether the message can go,
 * how the thread reads a photo, and the send. A send the server refuses for its photos leaves the
 * composer empty of them with the reason shown, and what the visitor typed back in the field.
 */
export function usePublicChatPhotos({ acceptsImages, uploadImage, sendMessage, publicChatToken, copy, input, setInput }: PublicChatPhotosInput) {
  const { attachments, state } = useVisitorImageAttachments(uploadImage)
  // The controls appear only where the agent takes photos; a message with a photo needs no text.
  const composerImages = useMemo<ComposerImages | undefined>(
    () => (acceptsImages
      ? {
          attachments: state.attachments,
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
    const imageIds = attachments.takeForSend()
    setInput('')
    await sendMessage(text, { method: 'typed' }, {
      imageIds,
      onImagesRefused: () => {
        setInput((current) => current || text)
        attachments.refuseSend('unavailable')
      },
    })
  }, [attachments, sendMessage, setInput])
  const clear = useCallback(() => attachments.clear(), [attachments])

  return { composerImages, visitorImages, canSend: canSendMessage(input, state), send, clear }
}
