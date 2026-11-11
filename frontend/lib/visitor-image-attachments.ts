/**
 * The photos a visitor has attached to the message they are composing: what each is doing, which
 * can be sent, and why one failed. Pure state transitions; the upload and the previews are the
 * hook's (`use-visitor-image-attachments.ts`).
 */

export const MAX_VISITOR_IMAGES_PER_MESSAGE = 3
/** What the file picker offers: the types the server reads. */
export const VISITOR_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp'
const VISITOR_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']
/** The server's raw upload cap. */
const MAX_VISITOR_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024

export type VisitorImageFailure = 'unsupported_type' | 'too_large' | 'unavailable' | 'failed'

interface AttachmentBase {
  /** Identifies the chip in the composer; the server's image id only exists once the upload is done. */
  key: string
  fileName: string
  /** An object URL of the photo for the chip; null when the file was refused before it was read. */
  previewUrl: string | null
}

export type Attachment = AttachmentBase & (
  | { status: 'uploading' }
  | { status: 'ready'; imageId: string }
  | { status: 'error'; failure: VisitorImageFailure }
)

export interface AttachmentsState {
  attachments: readonly Attachment[]
  /** Set when a paste or drop carried more photos than the message has room for. */
  limitReached: boolean
}

export const emptyAttachments: AttachmentsState = { attachments: [], limitReached: false }

/** A photo to add; `failure` is set when it was refused before any upload. */
export interface NewAttachment extends AttachmentBase {
  failure?: VisitorImageFailure
}

export type AttachmentAction =
  | { type: 'add'; items: readonly NewAttachment[] }
  | { type: 'uploaded'; key: string; imageId: string }
  | { type: 'failed'; key: string; failure: VisitorImageFailure }
  | { type: 'remove'; key: string }
  | { type: 'clear' }

export const remainingSlots = (state: AttachmentsState): number =>
  Math.max(0, MAX_VISITOR_IMAGES_PER_MESSAGE - state.attachments.length)

/** Which of the new photos the message has room for, and which it does not. */
export const splitByCapacity = <T>(
  state: AttachmentsState,
  items: readonly T[],
): { accepted: T[]; overflow: T[] } => {
  const room = remainingSlots(state)
  return { accepted: items.slice(0, room), overflow: items.slice(room) }
}

const toAttachment = ({ failure, ...base }: NewAttachment): Attachment =>
  failure ? { ...base, status: 'error', failure } : { ...base, status: 'uploading' }

const replaceAttachment = (state: AttachmentsState, key: string, next: (current: Attachment) => Attachment): AttachmentsState => {
  const index = state.attachments.findIndex((attachment) => attachment.key === key)
  if (index === -1) {
    return state
  }
  const attachments = state.attachments.slice()
  attachments[index] = next(state.attachments[index])
  return { ...state, attachments }
}

export const reduceAttachments = (state: AttachmentsState, action: AttachmentAction): AttachmentsState => {
  switch (action.type) {
    case 'add': {
      const { accepted, overflow } = splitByCapacity(state, action.items)
      return {
        attachments: [...state.attachments, ...accepted.map(toAttachment)],
        limitReached: overflow.length > 0,
      }
    }
    case 'uploaded':
      return replaceAttachment(state, action.key, ({ key, fileName, previewUrl }) => ({
        key,
        fileName,
        previewUrl,
        status: 'ready',
        imageId: action.imageId,
      }))
    case 'failed':
      return replaceAttachment(state, action.key, ({ key, fileName, previewUrl }) => ({
        key,
        fileName,
        previewUrl,
        status: 'error',
        failure: action.failure,
      }))
    case 'remove':
      return {
        attachments: state.attachments.filter((attachment) => attachment.key !== action.key),
        limitReached: false,
      }
    case 'clear':
      return emptyAttachments
  }
}

export const readyImageIds = (state: AttachmentsState): string[] =>
  state.attachments.flatMap((attachment) => (attachment.status === 'ready' ? [attachment.imageId] : []))

export const hasUploadInFlight = (state: AttachmentsState): boolean =>
  state.attachments.some((attachment) => attachment.status === 'uploading')

/** A message goes out with text or an uploaded photo, and never while a photo is still on its way. */
export const canSendMessage = (text: string, state: AttachmentsState): boolean =>
  !hasUploadInFlight(state) && (text.trim() !== '' || readyImageIds(state).length > 0)

/**
 * Whether the server would refuse the file's type, known from what the browser reports. A file with
 * no reported type goes up and the server reads its bytes.
 */
export const preUploadFailure = (file: { type: string }): VisitorImageFailure | null =>
  file.type !== '' && !VISITOR_IMAGE_TYPES.includes(file.type) ? 'unsupported_type' : null

/** Whether the file to upload is over the server's raw cap; checked after the browser has shrunk the photo. */
export const exceedsUploadCap = (file: { size: number }): boolean => file.size > MAX_VISITOR_IMAGE_UPLOAD_BYTES

const FAILURE_BY_CODE: Readonly<Record<string, VisitorImageFailure>> = {
  unsupported_image_type: 'unsupported_type',
  image_too_large: 'too_large',
  image_too_many_pixels: 'too_large',
  visitor_images_unavailable: 'unavailable',
}

/** The reason an upload's error stands for; anything the visitor cannot act on is a plain failure. */
export const visitorImageFailureOf = (error: unknown): VisitorImageFailure => {
  const code = typeof error === 'object' && error !== null && 'error' in error
    ? (error as { error?: { code?: unknown } }).error?.code
    : undefined
  return (typeof code === 'string' ? FAILURE_BY_CODE[code] : undefined) ?? 'failed'
}
