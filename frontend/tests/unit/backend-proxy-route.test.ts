import { EDGE_FACTS_HEADERS, verifyEdgeFactsProof } from '@radioso/edge-proof'
import { afterEach, describe, expect, it, vi } from 'vitest'

const BACKEND_URL = 'https://backend.example.com'
const EDGE_PROOF_SECRET = 'e'.repeat(32)

const CLIENT_SUPPLIED_EDGE_HEADERS = {
  [EDGE_FACTS_HEADERS.marker]: 'spoofed',
  [EDGE_FACTS_HEADERS.facts]: 'forged-facts',
  [EDGE_FACTS_HEADERS.signature]: 'forged-signature',
  [EDGE_FACTS_HEADERS.timestamp]: '1',
}

const upstreamHeadersOf = (fetchMock: ReturnType<typeof vi.fn>): Record<string, string> => {
  const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Headers }
  return Object.fromEntries(upstreamInit.headers.entries())
}

describe('backend proxy route', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('proxies auth requests with the runtime backend URL and forwards cookies', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          userId: 'user-1',
          accountId: 'account-1',
          organizationName: 'Acme',
          workspaceId: 'workspace-1',
          workspaceName: 'Default',
          workspacePublicRouteKey: 'default-abc123',
        }),
        {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'radioso_session=session-1; Path=/; HttpOnly; Secure; SameSite=Lax',
          },
        },
      ),
    )

    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/backend/[...path]/route')

    const request = new Request('https://frontend.example.com/backend/api/v1/auth/register?source=staging', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'theme=dark',
      },
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'Password123!',
        organizationName: 'Acme',
      }),
    })

    const response = await POST(request, {
      params: Promise.resolve({ path: ['api', 'v1', 'auth', 'register'] }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/api/v1/auth/register?source=staging`,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        redirect: 'manual',
      }),
    )

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Headers }
    expect(upstreamInit.headers.get('content-type')).toBe('application/json')
    expect(upstreamInit.headers.get('cookie')).toBe('theme=dark')
    expect(upstreamInit.headers.get('x-forwarded-prefix')).toBe('/backend')
    expect(upstreamInit.body).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(upstreamInit.body as ArrayBuffer)).toBe(
      JSON.stringify({
        email: 'user@example.com',
        password: 'Password123!',
        organizationName: 'Acme',
      }),
    )
    expect('duplex' in upstreamInit).toBe(false)

    expect(response.status).toBe(201)
    expect(response.headers.get('set-cookie')).toContain('radioso_session=session-1')
    expect(await response.json()).toEqual({
      userId: 'user-1',
      accountId: 'account-1',
      organizationName: 'Acme',
      workspaceId: 'workspace-1',
      workspaceName: 'Default',
      workspacePublicRouteKey: 'default-abc123',
    })
  })

  it('signs the exact upstream method and pathname, replacing any client-supplied edge headers', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)
    vi.stubEnv('RADIOSO_EDGE_PROOF_SECRET', EDGE_PROOF_SECRET)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/backend/[...path]/route')

    await POST(new Request('https://frontend.example.com/backend/api/v1/public/chat/launch%20token/sessions?resume=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.9, 35.191.0.1',
        ...CLIENT_SUPPLIED_EDGE_HEADERS,
      },
      body: JSON.stringify({ channel: 'anonymous_link' }),
    }), {
      params: Promise.resolve({ path: ['api', 'v1', 'public', 'chat', 'launch token', 'sessions'] }),
    })

    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/api/v1/public/chat/launch%20token/sessions?resume=1`,
      expect.anything(),
    )
    const headers = upstreamHeadersOf(fetchMock)
    expect(headers[EDGE_FACTS_HEADERS.marker]).toBe('frontend')
    const verification = verifyEdgeFactsProof({
      headers,
      method: 'POST',
      path: '/api/v1/public/chat/launch%20token/sessions',
      secret: EDGE_PROOF_SECRET,
    })
    expect(verification).toMatchObject({ ok: true, facts: { forwardedFor: '203.0.113.9, 35.191.0.1' } })
  })

  it('drops client-supplied edge proof headers and sends only the marker when no secret is configured', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)
    vi.stubEnv('RADIOSO_EDGE_PROOF_SECRET', '')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await import('@/app/backend/[...path]/route')

    await GET(new Request('https://frontend.example.com/backend/api/v1/auth/session', {
      headers: CLIENT_SUPPLIED_EDGE_HEADERS,
    }), {
      params: Promise.resolve({ path: ['api', 'v1', 'auth', 'session'] }),
    })

    const headers = upstreamHeadersOf(fetchMock)
    expect(headers[EDGE_FACTS_HEADERS.marker]).toBe('frontend')
    expect(headers).not.toHaveProperty(EDGE_FACTS_HEADERS.facts)
    expect(headers).not.toHaveProperty(EDGE_FACTS_HEADERS.signature)
    expect(headers).not.toHaveProperty(EDGE_FACTS_HEADERS.timestamp)
  })

  it('returns a 503 JSON error when the backend is unavailable', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo EAI_AGAIN backend')))

    const { GET } = await import('@/app/backend/[...path]/route')

    const response = await GET(new Request('https://frontend.example.com/backend/health'), {
      params: Promise.resolve({ path: ['health'] }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Backend is unavailable: getaddrinfo EAI_AGAIN backend',
      },
    })
  })

  it('buffers proxied request bodies so backend auth failures propagate', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      if (init?.body instanceof ReadableStream) {
        throw new Error('expected non-null body source')
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'unauthorized',
              message: 'Invalid email or password',
            },
          }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        ),
      )
    })

    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/backend/[...path]/route')

    const request = new Request('https://frontend.example.com/backend/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'wrong-password',
      }),
    })

    const response = await POST(request, {
      params: Promise.resolve({ path: ['api', 'v1', 'auth', 'login'] }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Invalid email or password',
      },
    })
  })

  it('returns CORS headers for public chat preflight requests', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const { OPTIONS } = await import('@/app/api/public/chat/[token]/route')

    const response = await OPTIONS(new Request('https://frontend.example.com/api/public/chat/token-1', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://radioso.ai',
        'Access-Control-Request-Method': 'POST',
      },
    }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://radioso.ai')
    expect(response.headers.get('access-control-allow-methods')).toBe('OPTIONS, POST')
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type, X-Radioso-Public-Session')
    expect(response.headers.get('vary')).toBe('Origin')
  })

  it('relays public chat CORS origin from upstream responses', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response('event: done\ndata: {}\n\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': 'https://radioso.ai',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'service_unavailable', message: 'No response' } }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'https://radioso.ai',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/api/public/chat/[token]/route')

    const allowed = await POST(new Request('https://frontend.example.com/api/public/chat/token-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://radioso.ai',
        'X-Radioso-Public-Session': 'session-token',
      },
      body: JSON.stringify({ message: 'Hello', stream: true }),
    }), {
      params: Promise.resolve({ token: 'token-1' }),
    })

    const upstreamError = await POST(new Request('https://frontend.example.com/api/public/chat/token-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://radioso.ai',
        'X-Radioso-Public-Session': 'session-token',
      },
      body: JSON.stringify({ message: 'Hello', stream: false }),
    }), {
      params: Promise.resolve({ token: 'token-1' }),
    })

    const denied = await POST(new Request('https://frontend.example.com/api/public/chat/token-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://denied.example.com',
        'X-Radioso-Public-Session': 'session-token',
      },
      body: JSON.stringify({ message: 'Hello', stream: true }),
    }), {
      params: Promise.resolve({ token: 'token-1' }),
    })

    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/api/v1/public/chat/token-1`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Origin: 'https://radioso.ai',
          'X-Radioso-Public-Session': 'session-token',
        }),
      }),
    )
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://radioso.ai')
    expect(allowed.headers.get('access-control-allow-headers')).toBe('Content-Type, X-Radioso-Public-Session')
    expect(upstreamError.status).toBe(503)
    expect(upstreamError.headers.get('access-control-allow-origin')).toBe('https://radioso.ai')
    expect(denied.status).toBe(404)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    expect(denied.headers.get('vary')).toBe('Origin')
  })

  it('forwards the external app origin to backend for public chat stream auth', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: done\ndata: {}\n\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Access-Control-Allow-Origin': 'https://app.radioso.ai',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/api/public/chat/[token]/route')

    const response = await POST(new Request('http://next-internal.example/api/public/chat/token-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.radioso.ai',
        Host: 'app.radioso.ai',
        'X-Forwarded-Proto': 'https, http',
        'X-Radioso-Public-Session': 'session-token',
      },
      body: JSON.stringify({ message: 'Hello', stream: true }),
    }), {
      params: Promise.resolve({ token: 'token-1' }),
    })

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(upstreamInit.headers).toMatchObject({
      Origin: 'https://app.radioso.ai',
      'X-Forwarded-Host': 'app.radioso.ai',
      'X-Forwarded-Proto': 'https',
      'X-Radioso-Public-Session': 'session-token',
    })
    expect(response.status).toBe(200)
  })

  it('signs embed config source facts and relays only rate-limit response headers', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)
    vi.stubEnv('RADIOSO_EDGE_PROOF_SECRET', EDGE_PROOF_SECRET)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'RateLimit-Limit': '60',
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': '30',
          'Retry-After': '30',
          'X-Upstream-Private': 'do-not-relay',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await import('@/app/api/embed/config/[token]/route')
    const response = await GET(new Request('https://frontend.example.com/api/embed/config/token-1', {
      headers: {
        Origin: 'https://embed.example.com',
        'X-Forwarded-For': '203.0.113.9, 35.191.0.1',
        ...CLIENT_SUPPLIED_EDGE_HEADERS,
      },
    }), { params: Promise.resolve({ token: 'token-1' }) })

    const headers = Object.fromEntries(new Headers(fetchMock.mock.calls[0][1].headers).entries())
    const verification = verifyEdgeFactsProof({
      headers,
      method: 'GET',
      path: '/api/v1/public/chat/token-1/embed-config',
      secret: EDGE_PROOF_SECRET,
    })

    expect(verification).toMatchObject({ ok: true, facts: { forwardedFor: '203.0.113.9, 35.191.0.1' } })
    expect(response.status).toBe(429)
    expect(response.headers.get('ratelimit-limit')).toBe('60')
    expect(response.headers.get('ratelimit-remaining')).toBe('0')
    expect(response.headers.get('ratelimit-reset')).toBe('30')
    expect(response.headers.get('retry-after')).toBe('30')
    expect(response.headers.get('x-upstream-private')).toBeNull()
  })

  it('relays only rate-limit response headers for embed sessions', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'RateLimit-Limit': '10',
          'RateLimit-Remaining': '0',
          'RateLimit-Reset': '15',
          'Retry-After': '15',
          'X-Upstream-Private': 'do-not-relay',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/api/embed/session/[token]/route')
    const response = await POST(new Request('https://frontend.example.com/api/embed/session/token-1', {
      method: 'POST',
      headers: { Origin: 'https://embed.example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }), { params: Promise.resolve({ token: 'token-1' }) })

    expect(response.status).toBe(429)
    expect(response.headers.get('ratelimit-limit')).toBe('10')
    expect(response.headers.get('ratelimit-remaining')).toBe('0')
    expect(response.headers.get('ratelimit-reset')).toBe('15')
    expect(response.headers.get('retry-after')).toBe('15')
    expect(response.headers.get('x-upstream-private')).toBeNull()
  })

  it('forwards bearer auth for document search proxy requests', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ searchId: 'search-1', query: 'Neil Armstrong', results: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    )

    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/api/document/search/route')

    const request = new Request('https://frontend.example.com/api/document/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer radioso_workspace_token',
      },
      body: JSON.stringify({
        query: 'Neil Armstrong',
      }),
    })

    const response = await POST(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/api/v1/document/search`,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    )

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(upstreamInit.headers.Authorization).toBe('Bearer radioso_workspace_token')
    expect(upstreamInit.body).toBe(JSON.stringify({ query: 'Neil Armstrong' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it('normalizes public chat proxy payloads before forwarding upstream', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ conversationId: 'conv-1', answer: 'ok' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Radioso-Anonymous-Session': 'anon-1',
        },
      }),
    )

    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/api/public/chat/[token]/route')

    const request = new Request('https://frontend.example.com/api/public/chat/public-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Radioso-Anonymous-Session': 'anon-existing',
      },
      body: JSON.stringify({
        query: 'Hello',
        bootstrapGreetingId: '6f1a68f5-a62b-4dc9-8204-a1f4b8304e6a',
        bootstrapGreeting: false,
        stream: true,
      }),
    })

    const response = await POST(request, {
      params: Promise.resolve({ token: 'public-token' }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/api/v1/public/chat/public-token`,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    )

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(upstreamInit.headers['X-Radioso-Anonymous-Session']).toBe('anon-existing')
    expect(JSON.parse(upstreamInit.body as string)).toEqual({
      bootstrapGreetingId: '6f1a68f5-a62b-4dc9-8204-a1f4b8304e6a',
      message: 'Hello',
      startConversation: false,
      stream: true,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-radioso-anonymous-session')).toBe('anon-1')
    expect(await response.json()).toEqual({
      conversationId: 'conv-1',
      answer: 'ok',
    })
  })
})
