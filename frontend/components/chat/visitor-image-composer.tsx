'use client'

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent } from 'react'
import { ImagePlus, TriangleAlert, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { WebsiteEmbedCopy, WebsiteEmbedTheme } from '@/lib/embed-widget'
import { errorForeground } from '@/lib/public-chat-theme'
import {
  MAX_VISITOR_IMAGES_PER_MESSAGE,
  VISITOR_IMAGE_ACCEPT,
  type Attachment,
  type SendFailure,
} from '@/lib/visitor-image-attachments'
import type { ComposerImages } from '@/lib/visitor-image-types'

type ImageCopy = Pick<
  WebsiteEmbedCopy,
  | 'publicChatAttachImageLabel'
  | 'publicChatRemoveImageTemplate'
  | 'publicChatImageUploadingLabel'
  | 'publicChatImageUnsupportedMessage'
  | 'publicChatImageTooLargeMessage'
  | 'publicChatImageFailedMessage'
  | 'publicChatImageRefusedMessage'
  | 'publicChatImageBusyMessage'
  | 'publicChatImageLimitTemplate'
  | 'publicChatMessageFailedMessage'
>

const failureMessage = (copy: ImageCopy, failure: SendFailure): string => {
  switch (failure) {
    case 'unsupported_type':
      return copy.publicChatImageUnsupportedMessage
    case 'too_large':
      return copy.publicChatImageTooLargeMessage
    case 'unavailable':
      return copy.publicChatImageRefusedMessage
    case 'busy':
      return copy.publicChatImageBusyMessage
    case 'not_sent':
      return copy.publicChatMessageFailedMessage
    default:
      return copy.publicChatImageFailedMessage
  }
}

const removeLabel = (copy: ImageCopy, number: number, count: number): string =>
  copy.publicChatRemoveImageTemplate.replaceAll('{number}', String(number)).replaceAll('{count}', String(count))

const hasFiles = (transfer: DataTransfer | null): boolean => Boolean(transfer && Array.from(transfer.types).includes('Files'))

/** The files a paste or drop carries; empty for a paste of plain text, which then goes into the message. */
const filesOf = (transfer: DataTransfer | null): File[] => (transfer ? Array.from(transfer.files) : [])

/** The composer's attach control: it opens the file picker for up to three photos. */
export function VisitorImageAttachButton({
  theme,
  copy,
  images,
  className,
}: {
  theme: WebsiteEmbedTheme
  copy: ImageCopy
  images: ComposerImages
  className: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const full = images.attachments.length >= MAX_VISITOR_IMAGES_PER_MESSAGE
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={VISITOR_IMAGE_ACCEPT}
        multiple
        hidden
        data-testid="visitor-image-input"
        onChange={(event) => {
          images.onFiles(Array.from(event.target.files ?? []))
          // The same photo can be picked again after it was removed.
          event.target.value = ''
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={`${className} shrink-0 rounded-full hover:opacity-80`}
        disabled={full}
        title={copy.publicChatAttachImageLabel}
        data-visitor-image-attach
        style={{ color: theme.inputForeground }}
        onClick={() => inputRef.current?.click()}
        // Keep focus in the message field, as Send does.
        onMouseDown={(event) => event.preventDefault()}
      >
        <ImagePlus className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{copy.publicChatAttachImageLabel}</span>
      </Button>
    </>
  )
}

function Chip({
  attachment,
  position,
  count,
  theme,
  copy,
  onRemove,
}: {
  attachment: Attachment
  position: number
  count: number
  theme: WebsiteEmbedTheme
  copy: ImageCopy
  onRemove: (viaKeyboard: boolean) => void
}) {
  const failed = attachment.status === 'error'
  const errorColor = errorForeground(theme.mutedBackground)
  return (
    <li
      className="relative size-14 shrink-0 overflow-hidden rounded-lg border"
      style={{ borderColor: failed ? errorColor : theme.inputBorder, background: theme.mutedBackground, color: failed ? errorColor : theme.inputForeground }}
      data-attachment-status={attachment.status}
      data-chip-key={attachment.key}
      title={failed ? failureMessage(copy, attachment.failure) : attachment.fileName}
    >
      {attachment.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a blob URL of the photo as the browser shrank it
        <img src={attachment.previewUrl} alt="" className={`size-full object-cover ${failed ? 'opacity-40' : ''}`} />
      ) : null}
      {attachment.status === 'uploading' ? (
        <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
          <Spinner className="size-4" aria-label={copy.publicChatImageUploadingLabel} />
        </span>
      ) : null}
      {failed ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <TriangleAlert className="size-5" aria-hidden="true" />
        </span>
      ) : null}
      <button
        type="button"
        // A mouse click leaves detail at 1 or more; a keyboard press leaves it at 0, and only that moves focus on.
        onClick={(event: MouseEvent<HTMLButtonElement>) => onRemove(event.detail === 0)}
        className="absolute right-0 top-0 flex size-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        // Keep focus in the message field, as Send does.
        onMouseDown={(event) => event.preventDefault()}
      >
        <X className="size-3" aria-hidden="true" />
        <span className="sr-only">{removeLabel(copy, position, count)}</span>
      </button>
    </li>
  )
}

/** The photos attached to the message so far, each with its state, and why one failed, did not fit, or was not sent. */
export function VisitorImageChips({
  images,
  theme,
  copy,
  onRemove,
}: {
  images: ComposerImages
  theme: WebsiteEmbedTheme
  copy: ImageCopy
  onRemove: (key: string, viaKeyboard: boolean) => void
}) {
  const reasons = [
    ...new Set(
      images.attachments.flatMap((attachment) => (attachment.status === 'error' ? [failureMessage(copy, attachment.failure)] : [])),
    ),
  ]
  if (images.sendFailure && !reasons.includes(failureMessage(copy, images.sendFailure))) {
    reasons.push(failureMessage(copy, images.sendFailure))
  }
  if (images.limitReached) {
    reasons.push(copy.publicChatImageLimitTemplate.replaceAll('{count}', String(MAX_VISITOR_IMAGES_PER_MESSAGE)))
  }
  if (images.attachments.length === 0 && reasons.length === 0) {
    return null
  }
  return (
    <div className="px-2 pb-1 pt-1.5">
      {images.attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {images.attachments.map((attachment, index) => (
            <Chip
              key={attachment.key}
              attachment={attachment}
              position={index + 1}
              count={images.attachments.length}
              theme={theme}
              copy={copy}
              onRemove={(viaKeyboard) => onRemove(attachment.key, viaKeyboard)}
            />
          ))}
        </ul>
      ) : null}
      {reasons.length > 0 ? (
        <p role="alert" data-testid="visitor-image-notice" className="mt-1.5 text-xs" style={{ color: errorForeground(theme.inputBackground) }}>
          {reasons.join(' ')}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The composer's behaviour around photos: paste and drop where the agent takes photos, and where
 * focus goes when a photo is removed from the keyboard (the next photo's Remove, else the attach
 * control, else the message field) so it is never left on something that is gone.
 */
export function useVisitorImageComposer(images: ComposerImages | undefined) {
  const [dragging, setDragging] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const refocus = useRef<{ nextKey: string | undefined } | null>(null)
  const attachments = images?.attachments
  useEffect(() => {
    const pending = refocus.current
    refocus.current = null
    const form = formRef.current
    if (!pending || !form) {
      return
    }
    const next = pending.nextKey ? form.querySelector<HTMLElement>(`[data-chip-key="${CSS.escape(pending.nextKey)}"] button`) : null
    const attach = form.querySelector<HTMLElement>('[data-visitor-image-attach]:not(:disabled)')
    const field = form.querySelector<HTMLElement>('textarea')
    ;(next ?? attach ?? field)?.focus()
  }, [attachments])

  const removeChip = (key: string, viaKeyboard: boolean) => {
    if (!images) {
      return
    }
    if (viaKeyboard) {
      const index = images.attachments.findIndex((attachment) => attachment.key === key)
      refocus.current = { nextKey: images.attachments[index + 1]?.key }
    }
    images.onRemove(key)
  }

  if (!images?.canAttach) {
    return { formRef, dragging: false, dropProps: {}, onPaste: undefined, removeChip }
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesOf(event.clipboardData)
    if (files.length > 0) {
      event.preventDefault()
      images.onFiles(files)
    }
  }
  const dropProps = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (hasFiles(event.dataTransfer)) {
        event.preventDefault()
        setDragging(true)
      }
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDragging(false)
      }
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      setDragging(false)
      const files = filesOf(event.dataTransfer)
      if (files.length > 0) {
        event.preventDefault()
        images.onFiles(files)
      }
    },
  }
  return { formRef, dragging, dropProps, onPaste, removeChip }
}
