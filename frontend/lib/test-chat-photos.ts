import { unsentImageSendOf } from '@/lib/public-chat-errors'

/**
 * Whether Test Chat offers photos for the agent: exactly when its chats take them from visitors,
 * since the photo switch and the chat model belong to the agent rather than to a version. `off`
 * while the switch is off (or the agent is still loading); `model_cannot_read` while it is on but
 * the chat model the agent answers with cannot read images.
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
type TestChatPhotoSendOutcome =
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
