import { afterEach, describe, expect, it, vi } from 'vitest'

const EVENTS_URL = 'https://dashboard.example.com/backend/api/v1/events?ignored=1'
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const VALID_HEADERS = {
  Accept: 'text/event-stream',
  Cookie: 'radioso_session=session-1',
  'X-Workspace-Id': WORKSPACE_ID,
}

type EventsRoute = {
  runtime: string
  dynamic: string
  GET: (request: Request) => Promise<Response> | Response
  HEAD: (request: Request) => Promise<Response> | Response
  OPTIONS: (request: Request) => Promise<Response> | Response
  POST: (request: Request) => Promise<Response> | Response
  PUT: (request: Request) => Promise<Response> | Response
  PATCH: (request: Request) => Promise<Response> | Response
  DELETE: (request: Request) => Promise<Response> | Response
}

const loadEventsRoute = async () =>
  (await import('@/app/backend/api/v1/events/route')) as unknown as EventsRoute

const makeRequest = (headers: HeadersInit = VALID_HEADERS, init: RequestInit = {}) =>
  new Request(EVENTS_URL, {
    ...init,
    headers,
  })

const getInit = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Headers; signal: AbortSignal }

const headerNames = (headers: Headers) => [...headers.keys()].sort()

const defer = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const withMissingRealtimeUrl = async <T>(operation: () => Promise<T>) => {
  const previous = process.env.REALTIME_INTERNAL_URL
  delete process.env.REALTIME_INTERNAL_URL
  try {
    return await operation()
  } finally {
    if (previous === undefined) {
      delete process.env.REALTIME_INTERNAL_URL
    } else {
      process.env.REALTIME_INTERNAL_URL = previous
    }
  }
}

describe('dedicated workspace-events frontend proxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('exports the node runtime, dynamic route, and explicit GET-only method surface', async () => {
    const route = await loadEventsRoute()

    expect(route.runtime).toBe('nodejs')
    expect(route.dynamic).toBe('force-dynamic')
    expect(route.GET).toEqual(expect.any(Function))
    expect(route.HEAD).toEqual(expect.any(Function))
    expect(route.OPTIONS).toEqual(expect.any(Function))
    expect(route.POST).toEqual(expect.any(Function))
    expect(route.PUT).toEqual(expect.any(Function))
    expect(route.PATCH).toEqual(expect.any(Function))
    expect(route.DELETE).toEqual(expect.any(Function))
  })

  it.each([
    ['HEAD', 'HEAD'],
    ['OPTIONS', 'OPTIONS'],
    ['POST', 'POST'],
    ['PUT', 'PUT'],
    ['PATCH', 'PATCH'],
    ['DELETE', 'DELETE'],
  ] as const)('rejects %s with 405 and Allow: GET without fetching', async (exportName, method) => {
    vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const route = await loadEventsRoute()

    const response = await route[exportName](makeRequest(VALID_HEADERS, { method }))

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('guards direct GET invocation when the Request method is not GET', async () => {
    vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const route = await loadEventsRoute()

    const response = await route.GET(makeRequest(VALID_HEADERS, { method: 'POST' }))

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['malformed', 'not-a-url'],
    ['unsupported scheme', 'ftp://realtime.internal.example'],
    ['missing host', 'https://'],
    ['credentials', 'https://user:secret@realtime.internal.example'],
    ['query', 'https://realtime.internal.example?secret=1'],
    ['fragment', 'https://realtime.internal.example#secret'],
  ] as const)('fails closed for a %s REALTIME_INTERNAL_URL without fetching', async (_name, value) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const run = async () => {
      if (value === undefined) {
        return withMissingRealtimeUrl(async () => {
          const route = await loadEventsRoute()
          return route.GET(makeRequest())
        })
      }
      vi.stubEnv('REALTIME_INTERNAL_URL', value)
      const route = await loadEventsRoute()
      return route.GET(makeRequest())
    }

    const response = await run()
    expect(response.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.text()).toBe('')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('retry-after')).toBe('60')
  })

  it.each([
    ['http://realtime.internal.example:8080', 'http://realtime.internal.example:8080/api/v1/events'],
    ['https://realtime.internal.example', 'https://realtime.internal.example/api/v1/events'],
    ['https://realtime.internal.example/realtime/base', 'https://realtime.internal.example/realtime/base/api/v1/events'],
    ['https://realtime.internal.example/realtime/base/', 'https://realtime.internal.example/realtime/base/api/v1/events'],
  ])('preserves the safe internal path prefix and appends /api/v1/events exactly once (%s)', async (internalUrl, expectedUrl) => {
      vi.stubEnv('REALTIME_INTERNAL_URL', internalUrl)
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('event: ready\ndata: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const route = await loadEventsRoute()

      await route.GET(makeRequest())

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl)
    },
  )

  it('forwards only the realtime request header allowlist and never derives origin from callers', async () => {
    vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const route = await loadEventsRoute()
    const request = makeRequest({
      ...VALID_HEADERS,
      Traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      Tracestate: 'vendor=value',
      Authorization: 'Bearer must-not-forward',
      Host: 'attacker.example',
      Origin: 'https://attacker.example',
      Referer: 'https://attacker.example/page',
      Forwarded: 'for=attacker;host=attacker.example;proto=https',
      'X-Forwarded-For': ' attacker',
      'X-Forwarded-Host': 'attacker.example',
      'X-Forwarded-Proto': 'https',
      'X-Real-IP': '192.0.2.10',
      'X-Cloud-Trace-Context': 'trace/span;o=1',
      'X-Platform': 'serverless',
      'X-Serverless': 'true',
      Baggage: 'user.id=secret',
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=5',
      Upgrade: 'websocket',
      TE: 'trailers',
      Trailer: 'X-Secret-Trailer',
      Via: '1.1 attacker-proxy',
      'Proxy-Authorization': 'Basic c2VjcmV0',
      'Transfer-Encoding': 'chunked',
      'Content-Length': '123',
      'Content-Encoding': 'gzip',
      'X-Forwarded-Prefix': '/attacker',
    })

    await route.GET(request)

    const init = getInit(fetchMock)
    expect(init.method).toBe('GET')
    expect(init.cache).toBe('no-store')
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBe(request.signal)
    expect(init).not.toHaveProperty('body')
    expect(init).not.toHaveProperty('duplex')
    expect(headerNames(init.headers)).toEqual([
      'accept',
      'cookie',
      'traceparent',
      'tracestate',
      'x-workspace-id',
    ])
    expect(init.headers.get('cookie')).toBe(VALID_HEADERS.Cookie)
    expect(init.headers.get('accept')).toBe(VALID_HEADERS.Accept)
    expect(init.headers.get('x-workspace-id')).toBe(WORKSPACE_ID)
    expect(init.headers.get('traceparent')).toContain('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(init.headers.get('tracestate')).toBe('vendor=value')
    expect(init.headers.get('authorization')).toBeNull()
    expect(init.headers.get('origin')).toBeNull()
    expect(init.headers.get('host')).toBeNull()
  })

  it('propagates a pre-aborted request instead of converting it to generic 503', async () => {
    vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const route = await loadEventsRoute()
    const controller = new AbortController()
    const reason = new DOMException('request aborted', 'AbortError')
    controller.abort(reason)

    await expect(route.GET(makeRequest(VALID_HEADERS, { signal: controller.signal }))).rejects.toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates a mid-flight abort and passes the exact request signal upstream', async () => {
    vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const route = await loadEventsRoute()
    const controller = new AbortController()
    const reason = new DOMException('request aborted', 'AbortError')
    const request = makeRequest(VALID_HEADERS, { signal: controller.signal })
    const pending = route.GET(request)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(getInit(fetchMock).signal).toBe(request.signal)
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('returns the upstream body directly, exposes the first chunk before completion, and propagates reader cancellation', async () => {
    vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
    const secondChunk = defer<Uint8Array>()
    const cancelled = defer<unknown>()
    const first = new TextEncoder().encode('event: ready\n\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first)
        void secondChunk.promise.then((chunk) => {
          controller.enqueue(chunk)
          controller.close()
        })
      },
      cancel(reason) {
        cancelled.resolve(reason)
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const route = await loadEventsRoute()

    const response = await route.GET(makeRequest())
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const firstRead = await reader!.read()
    expect(new TextDecoder().decode(firstRead.value)).toBe('event: ready\n\n')
    expect(firstRead.done).toBe(false)

    let secondReadSettled = false
    const secondRead = reader!.read().then((result) => {
      secondReadSettled = true
      return result
    })
    await Promise.resolve()
    expect(secondReadSettled).toBe(false)

    await reader!.cancel('client disconnected')
    await expect(cancelled.promise).resolves.toBe('client disconnected')
    await expect(secondRead).resolves.toMatchObject({ done: true })
  })

  it.each([200, 400, 401, 403, 404, 429, 503])(
    'passes through supported upstream status %s and only the SSE response headers',
    async (status) => {
      vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('upstream-body', {
          status,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'Retry-After': '7',
            Connection: 'keep-alive',
            'Content-Encoding': 'gzip',
            'Content-Length': '14',
            'Set-Cookie': 'secret=must-not-forward',
            Location: 'https://attacker.example/redirect',
            Server: 'backend-secret',
            'Transfer-Encoding': 'chunked',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
            Via: '1.1 attacker-proxy',
            Vary: 'Origin',
            'X-Custom-Upstream': 'must-not-forward',
          },
        }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const route = await loadEventsRoute()

      const response = await route.GET(makeRequest())

      expect(response.status).toBe(status)
      expect(headerNames(response.headers)).toEqual([
        'cache-control',
        'content-type',
        'retry-after',
        'x-accel-buffering',
      ])
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      expect(response.headers.get('cache-control')).toBe('no-cache, no-transform')
      expect(response.headers.get('x-accel-buffering')).toBe('no')
      expect(response.headers.get('retry-after')).toBe('7')
      expect(await response.text()).toBe('upstream-body')
    },
  )

  it('turns a manual redirect into a content-free generic 503 without forwarding Location', async () => {
    vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
    let cancelCalls = 0
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('redirect-body-must-not-leak'))
      },
      cancel() {
        cancelCalls += 1
        return Promise.reject(new Error('upstream cancellation failed'))
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(upstreamBody, {
        status: 302,
        headers: { Location: 'https://secret.example/next' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const route = await loadEventsRoute()
    const unhandledRejection = vi.fn()
    process.on('unhandledRejection', unhandledRejection)

    try {
      const response = await route.GET(makeRequest())

      expect(response.status).toBe(503)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('retry-after')).toBe('1')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe('')
      await vi.waitFor(() => expect(cancelCalls).toBe(1), { timeout: 250 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandledRejection)
    }
  })

  it('uses the same sanitized content-free 503 for configuration and upstream failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new Error('connect https://user:password@secret.example/token=abc failed'),
    )
    vi.stubGlobal('fetch', fetchMock)

    vi.stubEnv('REALTIME_INTERNAL_URL', 'https://realtime.internal.example')
    const route = await loadEventsRoute()
    const thrownResponse = await route.GET(makeRequest())
    const thrownBody = await thrownResponse.text()

    expect(thrownResponse.status).toBe(503)
    expect(thrownBody).toBe('')
    expect(thrownResponse.headers.get('cache-control')).toBe('no-store')
    expect(thrownResponse.headers.get('retry-after')).toBe('1')
    expect(thrownBody).not.toContain('secret')
    expect(thrownBody).not.toContain('password')
    expect(thrownBody).not.toContain('token')

    await withMissingRealtimeUrl(async () => {
      const missingRoute = await loadEventsRoute()
      const configResponse = await missingRoute.GET(makeRequest())
      expect(configResponse.status).toBe(503)
      expect(await configResponse.text()).toBe('')
      expect(configResponse.headers.get('cache-control')).toBe('no-store')
      expect(configResponse.headers.get('retry-after')).toBe('60')
    })
  })

  it('keeps the ordinary catch-all proxy behavior separate and unchanged', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', 'https://backend.example.com')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ordinary-response', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { GET } = await import('@/app/backend/[...path]/route')

    const response = await GET(
      new Request('https://dashboard.example.com/backend/api/v1/workspaces?view=recent', {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ordinary-token',
          Cookie: 'radioso_session=session-1',
        },
      }),
      { params: Promise.resolve({ path: ['api', 'v1', 'workspaces'] }) },
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example.com/api/v1/workspaces?view=recent',
      expect.objectContaining({ method: 'GET', cache: 'no-store', redirect: 'manual' }),
    )
    const init = getInit(fetchMock)
    expect(init.headers.get('authorization')).toBe('Bearer ordinary-token')
    expect(init.headers.get('cookie')).toBe('radioso_session=session-1')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ordinary-response')
  })
})
