import { ApiError } from './api-client'

const DEFAULT_TRANSIENT_BACKOFF_MS = 12_000

export const pendingRegistrationPollDelayMs = (error: unknown): number => {
  if (!(error instanceof ApiError)) return DEFAULT_TRANSIENT_BACKOFF_MS
  if (error.responseRetryAfterSeconds !== undefined) {
    return error.responseRetryAfterSeconds * 1_000
  }
  const details = error.error.details
  if (details && typeof details === 'object' && 'retryAfterSeconds' in details) {
    const retryAfterSeconds = details.retryAfterSeconds
    if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1_000
    }
  }
  if (typeof error.error.retryAfterSeconds === 'number' && error.error.retryAfterSeconds > 0) {
    return error.error.retryAfterSeconds * 1_000
  }
  return DEFAULT_TRANSIENT_BACKOFF_MS
}
