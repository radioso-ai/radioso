import type { ErrorResponse } from '@/lib/api'
import { publicChatUnavailableReasonOf } from '@/lib/public-chat-unavailable'

export const getErrorResponse = (error: unknown): ErrorResponse['error'] | null => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'code' in error.error &&
    typeof error.error.code === 'string' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error as ErrorResponse['error']
  }

  return null
}

export const isRateLimitError = (error: unknown): { message: string; retryAfterSeconds: number } | null => {
  const structuredError = getErrorResponse(error)
  if (structuredError?.code !== 'rate_limit_exceeded') {
    return null
  }

  return {
    message: structuredError.message,
    retryAfterSeconds: Number(structuredError.retryAfterSeconds ?? 60),
  }
}

// The account's conversation quota is exhausted. This is the only error code the
// public route still answers with on this path when the agent cannot reply, so it
// gets its own visitor-facing copy instead of the generic failure message. Quota
// can be restored at any time, so the composer stays enabled either way.
export const isUsageLimitExceededError = (error: unknown): boolean =>
  getErrorResponse(error)?.code === 'usage_limit_exceeded'

/**
 * What happened to a send with photos that did not reach the point where the server takes them:
 * it refused the photos, held the request back, never started (another send was still going), or
 * failed some other way.
 */
export type UnsentImageSend = 'images_refused' | 'rate_limited' | 'not_started' | 'not_sent'

/**
 * Whether a send with photos failed without the server having taken them, so the photos and the
 * words can come back to the composer; null when it did, or when the chat itself is gone. A send
 * the server refused for its photos names them. A rate limit holds the request back before any
 * turn starts. A network error or any other refusal may have reached the server or not: if it
 * did, a second send of the same photos is refused as one the server already has, and the photos
 * go with a reason. An out-of-answers plan refuses a turn that already stored its message and
 * photos, and a chat that is gone has nothing to send to.
 */
export const unsentImageSendOf = (error: unknown): Exclude<UnsentImageSend, 'not_started'> | null => {
  const code = getErrorResponse(error)?.code
  if (code === 'visitor_image_unavailable') {
    return 'images_refused'
  }
  if (isUsageLimitExceededError(error) || publicChatUnavailableReasonOf(code)) {
    return null
  }
  return isRateLimitError(error) ? 'rate_limited' : 'not_sent'
}
