import type { ChatUserInputMetadata, VisitorImageInput } from '@/lib/api-types'

/**
 * A visitor message with photos stores `content` as the turn text the agent saw (the typed text
 * plus one reading block per photo) and keeps what the visitor actually did in
 * `inputMetadata.imageInput`. A thread shows the second: the visitor's own words and their photos,
 * with the agent's readings kept out of their bubble.
 */

const isImageEntry = (value: unknown): value is VisitorImageInput['images'][number] =>
  typeof value === 'object'
  && value !== null
  && typeof (value as { id?: unknown }).id === 'string'
  && (typeof (value as { reading?: unknown }).reading === 'string' || (value as { reading?: unknown }).reading === null)

/** The photos a message carries, or null when it carries none or the record is not what the API promises. */
export const readVisitorImageInput = (metadata: object | null | undefined): VisitorImageInput | null => {
  const record: unknown = (metadata as { imageInput?: unknown } | null | undefined)?.imageInput
  if (typeof record !== 'object' || record === null) {
    return null
  }
  const { typedText, images } = record as { typedText?: unknown; images?: unknown }
  if (typeof typedText !== 'string' || !Array.isArray(images)) {
    return null
  }
  const wellFormed = images.filter(isImageEntry)
  return wellFormed.length > 0 ? { typedText, images: wellFormed } : null
}

type VisitorMessageBody =
  | { kind: 'images'; typedText: string; images: VisitorImageInput['images'] }
  | { kind: 'text'; text: string }

/** What a visitor message shows in the thread. */
export const visitorMessageBody = (message: {
  content: string
  inputMetadata?: object | null
}): VisitorMessageBody => {
  const imageInput = readVisitorImageInput(message.inputMetadata)
  return imageInput
    ? { kind: 'images', typedText: imageInput.typedText, images: imageInput.images }
    : { kind: 'text', text: message.content }
}

/** What a person reads of a visitor message: the words, and how many photos came with them. */
export interface VisibleMessageText {
  text: string
  photoCount: number
}

/**
 * What an operator surface shows of a visitor message outside the thread bubble that renders the
 * photos themselves (a header, a preview, a default name): what was typed and the photo count,
 * never `content`, whose reading blocks are for the agent's model. The backend's twin is
 * `visibleMessageText` in `shared/domain/visibleMessageText.ts`; each side reads the one stored
 * `imageInput`, here as the API returns it.
 */
export const visibleMessageText = (message: {
  content: string
  inputMetadata?: object | null
}): VisibleMessageText => {
  const imageInput = readVisitorImageInput(message.inputMetadata)
  return imageInput
    ? { text: imageInput.typedText, photoCount: imageInput.images.length }
    : { text: message.content, photoCount: 0 }
}

/** The short marker that stands for photos where a surface has no room for them: "1 photo", "3 photos". */
export const photoCountLabel = (photoCount: number): string =>
  photoCount === 1 ? '1 photo' : `${photoCount} photos`

/** A one-line label for a message shown without its photos: its words, then the photo marker; either alone when the other is absent. */
export const visibleMessageLabel = ({ text, photoCount }: VisibleMessageText): string => {
  const words = text.trim()
  if (photoCount === 0) {
    return words
  }
  return words ? `${words} · ${photoCountLabel(photoCount)}` : photoCountLabel(photoCount)
}

/** The label of the question a low-quality turn answered: its words and photo count, or '' when it has neither. */
export const questionLabel = (turn: { question: string | null; questionPhotoCount?: number }): string =>
  visibleMessageLabel({ text: turn.question ?? '', photoCount: turn.questionPhotoCount ?? 0 })

/** The metadata of the visitor's own message the moment it is sent, before the server's reading exists. */
export const withVisitorImageInput = (
  metadata: ChatUserInputMetadata | undefined,
  typedText: string,
  imageIds: readonly string[],
): ChatUserInputMetadata | undefined => {
  if (imageIds.length === 0) {
    return metadata
  }
  return {
    ...(metadata ?? { method: 'typed' }),
    imageInput: { typedText, images: imageIds.map((id) => ({ id, reading: null })) },
  }
}
