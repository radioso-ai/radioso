import { describe, expect, it } from 'vitest'

import { relayRateLimitResponseHeaders } from '@/lib/server/rate-limit-headers'

describe('relayRateLimitResponseHeaders', () => {
  it('copies only the allowed rate-limit headers and exposes the copied headers', () => {
    const responseHeaders = new Headers()

    relayRateLimitResponseHeaders(
      new Headers({
        'RateLimit-Limit': '60',
        'RateLimit-Remaining': '12',
        'RateLimit-Reset': '30',
        'Retry-After': '30',
        'X-Upstream-Private': 'do-not-relay',
      }),
      responseHeaders,
    )

    expect(responseHeaders.get('ratelimit-limit')).toBe('60')
    expect(responseHeaders.get('ratelimit-remaining')).toBe('12')
    expect(responseHeaders.get('ratelimit-reset')).toBe('30')
    expect(responseHeaders.get('retry-after')).toBe('30')
    expect(responseHeaders.get('access-control-expose-headers')).toBe(
      'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After',
    )
    expect(responseHeaders.get('x-upstream-private')).toBeNull()
  })

  it('does not expose rate-limit headers when none are relayed', () => {
    const responseHeaders = new Headers()

    relayRateLimitResponseHeaders(new Headers({ 'X-Upstream-Private': 'do-not-relay' }), responseHeaders)

    expect(responseHeaders.get('access-control-expose-headers')).toBeNull()
  })
})
