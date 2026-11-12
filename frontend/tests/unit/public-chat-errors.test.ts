import { describe, expect, it } from 'vitest'

import { getErrorResponse, isRateLimitError, isUsageLimitExceededError, unsentImageSendOf } from '@/lib/public-chat-errors'

const apiError = (code: string, status: number, extra: Record<string, unknown> = {}) => ({ status, error: { code, message: 'No.', ...extra } })

describe('reading a chat error', () => {
  it('finds the structured error an API answer carries, and nothing in anything else', () => {
    expect(getErrorResponse(apiError('not_found', 404))).toEqual({ code: 'not_found', message: 'No.' })
    expect(getErrorResponse(new TypeError('Failed to fetch'))).toBeNull()
    expect(getErrorResponse(undefined)).toBeNull()
  })

  it('knows a rate limit and how long to wait', () => {
    expect(isRateLimitError(apiError('rate_limit_exceeded', 429, { retryAfterSeconds: 12 }))).toEqual({ message: 'No.', retryAfterSeconds: 12 })
    expect(isRateLimitError(apiError('rate_limit_exceeded', 429))?.retryAfterSeconds).toBe(60)
    expect(isRateLimitError(apiError('not_found', 404))).toBeNull()
  })

  it('knows the account is out of answers', () => {
    expect(isUsageLimitExceededError(apiError('usage_limit_exceeded', 429))).toBe(true)
    expect(isUsageLimitExceededError(apiError('rate_limit_exceeded', 429))).toBe(false)
  })
})

describe('a send with photos that failed before the server took the photos', () => {
  it('is a send the server refused for its photos when it names them', () => {
    expect(unsentImageSendOf(apiError('visitor_image_unavailable', 409))).toBe('images_refused')
  })

  it('is a rate limit when the request was held back before the turn started', () => {
    expect(unsentImageSendOf(apiError('rate_limit_exceeded', 429))).toBe('rate_limited')
  })

  it.each([
    ['a network error, where the server may never have seen the request', new TypeError('Failed to fetch')],
    ['a server error', apiError('internal_error', 500)],
    ['a bad request', apiError('bad_request', 400)],
  ])('is a message that did not go for %s', (_label, error) => {
    expect(unsentImageSendOf(error)).toBe('not_sent')
  })

  it('is not one the photos can come back from when the plan has no answers left, since the turn had stored them', () => {
    expect(unsentImageSendOf(apiError('usage_limit_exceeded', 429))).toBeNull()
  })

  it('is not one the photos can come back from when the chat itself is gone', () => {
    expect(unsentImageSendOf(apiError('not_found', 404))).toBeNull()
    expect(unsentImageSendOf(apiError('agent_not_published', 409))).toBeNull()
  })
})
