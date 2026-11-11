'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'

import { createClientId } from '@/lib/client-id'
import { VisitorImageAttachments, type VisitorImageAttachmentDeps } from '@/lib/visitor-image-attachment-controller'
import type { AttachmentsState } from '@/lib/visitor-image-attachments'
import { browserImageCodec } from '@/lib/visitor-image-browser-codec'

const browserPreviews: VisitorImageAttachmentDeps['previews'] = {
  create: (file) => URL.createObjectURL(file),
  revoke: (url) => URL.revokeObjectURL(url),
}

/**
 * The photos attached to the message being composed. `upload` sends one shrunk photo to the chat
 * session; the work, and the previews it makes, end with the component.
 */
export function useVisitorImageAttachments(upload: VisitorImageAttachmentDeps['upload']): {
  attachments: VisitorImageAttachments
  state: AttachmentsState
} {
  const [attachments] = useState(
    () => new VisitorImageAttachments({ upload, codec: browserImageCodec, previews: browserPreviews, createKey: () => createClientId('visitor-image') }),
  )
  useEffect(() => {
    attachments.setUpload(upload)
  }, [attachments, upload])
  useEffect(() => () => attachments.dispose(), [attachments])
  const state = useSyncExternalStore(attachments.subscribe, attachments.getState, attachments.getState)
  return { attachments, state }
}
