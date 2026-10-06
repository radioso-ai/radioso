const RATE_LIMIT_RESPONSE_HEADER_NAMES = [
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
] as const

export const relayRateLimitResponseHeaders = (upstream: Headers, target: Headers): void => {
  const exposedHeaders: string[] = []

  for (const name of RATE_LIMIT_RESPONSE_HEADER_NAMES) {
    const value = upstream.get(name)
    if (value) {
      target.set(name, value)
      exposedHeaders.push(name)
    }
  }

  if (exposedHeaders.length > 0) {
    target.set('Access-Control-Expose-Headers', exposedHeaders.join(', '))
  }
}
