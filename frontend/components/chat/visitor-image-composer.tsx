'use client'

import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { ImagePlus, TriangleAlert, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { WebsiteEmbedCopy, WebsiteEmbedTheme } from '@/lib/embed-widget'
import {
  MAX_VISITOR_IMAGES_PER_MESSAGE,
  VISITOR_IMAGE_ACCEPT,
  type Attachment,
  type VisitorImageFailure,
} from '@/lib/visitor-image-attachments'

/** What the composer needs to attach photos; absent where the agent takes none. */
export interface ComposerImages {
  attachments: readonly Attachment[]
  /** A paste or drop carried more photos than the message has room for. */
  limitReached: boolean
  onFiles: (files: File[]) => void
  onRemove: (key: string) => void
}

type ImageCopy = Pick<
  WebsiteEmbedCopy,
  | 'publicChatAttachImageLabel'
  | 'publicChatRemoveImageLabel'
  | 'publicChatImageUploadingLabel'
  | 'publicChatImageUnsupportedMessage'
  | 'publicChatImageTooLargeMessage'
  | 'publicChatImageFailedMessage'
  | 'publicChatImageLimitTemplate'
>

const failureMessage = (copy: ImageCopy, failure: VisitorImageFailure): string => {
  switch (failure) {
    case 'unsupported_type':
      return copy.publicChatImageUnsupportedMessage
    case 'too_large':
      return copy.publicChatImageTooLargeMessage
    default:
      return copy.publicChatImageFailedMessage
  }
}

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

function Chip({ attachment, theme, copy, onRemove }: { attachment: Attachment; theme: WebsiteEmbedTheme; copy: ImageCopy; onRemove: () => void }) {
  const failed = attachment.status === 'error'
  return (
    <li
      className="relative size-14 shrink-0 overflow-hidden rounded-lg border"
      style={{ borderColor: failed ? 'currentColor' : theme.inputBorder, background: theme.mutedBackground, color: failed ? '#b91c1c' : theme.inputForeground }}
      data-attachment-status={attachment.status}
      title={failed ? failureMessage(copy, attachment.failure) : attachment.fileName}
    >
      {attachment.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a blob URL of the photo just picked
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
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        // Keep focus in the message field, as Send does.
        onMouseDown={(event) => event.preventDefault()}
      >
        <X className="size-3" aria-hidden="true" />
        <span className="sr-only">{copy.publicChatRemoveImageLabel}</span>
      </button>
    </li>
  )
}

/** The photos attached to the message so far, each with its state, and why one failed or did not fit. */
export function VisitorImageChips({ images, theme, copy }: { images: ComposerImages; theme: WebsiteEmbedTheme; copy: ImageCopy }) {
  const reasons = [
    ...new Set(
      images.attachments.flatMap((attachment) => (attachment.status === 'error' ? [failureMessage(copy, attachment.failure)] : [])),
    ),
  ]
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
          {images.attachments.map((attachment) => (
            <Chip key={attachment.key} attachment={attachment} theme={theme} copy={copy} onRemove={() => images.onRemove(attachment.key)} />
          ))}
        </ul>
      ) : null}
      {reasons.length > 0 ? (
        <p role="alert" data-testid="visitor-image-notice" className="mt-1.5 text-xs" style={{ color: '#b91c1c' }}>
          {reasons.join(' ')}
        </p>
      ) : null}
    </div>
  )
}

/** Paste and drop handlers for the composer, active only where the agent takes photos. */
export function useVisitorImageDrop(images: ComposerImages | undefined) {
  const [dragging, setDragging] = useState(false)
  if (!images) {
    return { dragging: false, dropProps: {}, onPaste: undefined }
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
  return { dragging, dropProps, onPaste }
}
