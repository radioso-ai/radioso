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
