const REALTIME_EVENTS_PATH = '/api/v1/events'

const REQUEST_HEADER_ALLOWLIST = [
  'cookie',
  'accept',
  'x-workspace-id',
  'traceparent',
  'tracestate',
] as const

const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'cache-control',
  'x-accel-buffering',
  'retry-after',
] as const

const PASSTHROUGH_STATUSES = new Set([200, 400, 401, 403, 404, 429, 503])

const invalidUpstream = () =>
  new Response(null, {
    status: 503,
    headers: {
      'cache-control': 'no-store',
      'retry-after': '1',
    },
  })

const getRealtimeEventsUrl = () => {
  const configuredUrl = process.env.REALTIME_INTERNAL_URL
  if (!configuredUrl || configuredUrl.trim() !== configuredUrl || /[?#]/.test(configuredUrl)) {
    return undefined
  }

  try {
    const url = new URL(configuredUrl)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined
    }

    url.pathname = REALTIME_EVENTS_PATH
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

const buildUpstreamHeaders = (request: Request) => {
  const headers = new Headers()
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = request.headers.get(name)
    if (value) {
      headers.set(name, value)
    }
  }
  return headers
}

const buildResponseHeaders = (upstream: Response) => {
  const headers = new Headers()
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.headers.get(name)
    if (value) {
      headers.set(name, value)
    }
  }
  return headers
}

const discardUpstreamBody = (upstream: Response) => {
  const body = upstream.body
  if (!body) {
    return
  }

  try {
    void body.cancel().catch(() => undefined)
  } catch {
    // A locked or otherwise invalid stream must not affect the sanitized response.
  }
}

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw signal.reason
  }
}

export const proxyRealtimeEvents = async (request: Request): Promise<Response> => {
  if (request.method !== 'GET') {
    return new Response(null, {
      status: 405,
      headers: { allow: 'GET', 'cache-control': 'no-store' },
    })
  }

  throwIfAborted(request.signal)

  const upstreamUrl = getRealtimeEventsUrl()
  if (!upstreamUrl) {
    return invalidUpstream()
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: buildUpstreamHeaders(request),
      cache: 'no-store',
      redirect: 'manual',
      signal: request.signal,
    })

    if (!PASSTHROUGH_STATUSES.has(upstream.status)) {
      discardUpstreamBody(upstream)
      return invalidUpstream()
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: buildResponseHeaders(upstream),
    })
  } catch {
    if (request.signal.aborted) {
      throw request.signal.reason
    }
    return invalidUpstream()
  }
}
