import { normalizeWebsiteEmbedLocale } from '@/lib/embed-widget'
import { unsentImageSendOf } from '@/lib/public-chat-errors'

/**
 * Whether Test Chat offers photos, from the agent's saved settings: the photo switch is the draft's
 * value, which Test Chat tests, and the chat model belongs to the agent. `off` while the draft has
 * photos off (or the agent is still loading); `model_cannot_read` while they are on but the chat
 * model the agent answers with cannot read images. The server decides by the revisions a test
 * runs, so a version picked from the history is refused when its switch is off.
 */
export type TestChatPhotoAvailability = 'available' | 'off' | 'model_cannot_read'

export const testChatPhotoAvailability = (
  agent: { visitorImagesEnabled?: boolean; chatModelReadsImages?: boolean },
): TestChatPhotoAvailability => {
  if (!agent.visitorImagesEnabled) return 'off'
  if (agent.chatModelReadsImages === false) return 'model_cannot_read'
  return agent.chatModelReadsImages ? 'available' : 'off'
}

/**
 * What a send means for its photos: the test took the message, so they go with it; it refused the
 * photos (sent before, or the agent stopped taking them), so they go with a reason; or the message
 * never reached the test, so they come back to the composer, uploaded as they were.
 */
export type TestChatPhotoSendOutcome =
  | { kind: 'taken' }
  | { kind: 'refused' }
  | { kind: 'returned'; failure: 'not_sent' }

export const testChatPhotoSendOutcome = (send: { taken: true } | { taken: false; error: unknown }): TestChatPhotoSendOutcome => {
  if (send.taken) return { kind: 'taken' }
  const unsent = unsentImageSendOf(send.error)
  if (unsent === 'images_refused') return { kind: 'refused' }
  // A plan limit refuses a test turn mid-stream, after the test stored the message and its photos.
  if (unsent === null) return { kind: 'taken' }
  return { kind: 'returned', failure: 'not_sent' }
}

/**
 * The language the agent reads a Test Chat photo in: the operator's browser language, as a
 * visitor's photo is read in the visitor's. Undefined, so the agent's default applies, when the
 * browser names none the chat would accept.
 */
export const photoReadingLocale = (browserLocale: string | undefined): string | undefined => {
  const trimmed = browserLocale?.trim()
  return trimmed && trimmed.length <= 35 && normalizeWebsiteEmbedLocale(trimmed) !== null ? trimmed : undefined
}

/** Reads once, then again after each of `delaysMs` while it fails; null once every try failed. */
export const readWithRetries = async <T>(read: () => Promise<T>, delaysMs: readonly number[], wait: (ms: number) => Promise<void>): Promise<T | null> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read()
    } catch {
      const delay = delaysMs[attempt]
      if (delay === undefined) return null
      await wait(delay)
    }
  }
}
