import { describe, expect, it } from 'vitest'

import { buildError } from '@/lib/api-client'
import { pendingRegistrationPollDelayMs } from '@/lib/auth-pending-poll'

describe('pending registration poll backoff', () => {
  it('uses the Retry-After response header before the structured error details', async () => {
    const error = await buildError(new Response(JSON.stringify({
      error: {
        code: 'rate_limit_exceeded',
        message: 'Please wait before trying again',
        details: { retryAfterSeconds: 9 },
      },
    }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'Retry-After': '17',
      },
    }))

    expect(pendingRegistrationPollDelayMs(error)).toBe(17_000)
  })

  it('uses the actual nested 429 detail when a proxy omits Retry-After', async () => {
    const error = await buildError(new Response(JSON.stringify({
      error: {
        code: 'rate_limit_exceeded',
        message: 'Please wait before trying again',
        details: { retryAfterSeconds: 23 },
      },
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }))

    expect(pendingRegistrationPollDelayMs(error)).toBe(23_000)
  })
})
