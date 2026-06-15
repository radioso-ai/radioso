import { afterEach, describe, expect, it, vi } from 'vitest'

const BACKEND_URL = 'https://backend.example.com'

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

  it('forwards bearer auth for chat streaming proxy requests', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: done\ndata: {"conversationId":"conv-1","answer":"ok"}\n\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      }),
    )

    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/api/chat/stream/route')

    const request = new Request('https://frontend.example.com/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer radioso_workspace_token',
      },
      body: JSON.stringify({
        agentId: '0f0ad444-31c6-48f2-ac31-eb2d2e46226d',
        query: 'Hello',
        stream: true,
      }),
    })

    const response = await POST(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/api/v1/assistant/chat`,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    )

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(upstreamInit.headers.Authorization).toBe('Bearer radioso_workspace_token')
    expect(JSON.parse(upstreamInit.body as string)).toMatchObject({
      agentId: '0f0ad444-31c6-48f2-ac31-eb2d2e46226d',
      message: 'Hello',
      stream: true,
      sourceContext: {
        surface: 'authenticated_chat',
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
  })

  it('returns CORS headers for public chat preflight requests', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const { OPTIONS } = await import('@/app/api/public/chat/[token]/route')

    const response = await OPTIONS(new Request('https://frontend.example.com/api/public/chat/token-1', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://radioso.dev',
        'Access-Control-Request-Method': 'POST',
      },
    }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://radioso.dev')
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
            'Access-Control-Allow-Origin': 'https://radioso.dev',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'service_unavailable', message: 'No response' } }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'https://radioso.dev',
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
        Origin: 'https://radioso.dev',
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
        Origin: 'https://radioso.dev',
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
          Origin: 'https://radioso.dev',
          'X-Radioso-Public-Session': 'session-token',
        }),
      }),
    )
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://radioso.dev')
    expect(allowed.headers.get('access-control-allow-headers')).toBe('Content-Type, X-Radioso-Public-Session')
    expect(upstreamError.status).toBe(503)
    expect(upstreamError.headers.get('access-control-allow-origin')).toBe('https://radioso.dev')
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
          'Access-Control-Allow-Origin': 'https://platform.radioso.dev',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/api/public/chat/[token]/route')

    const response = await POST(new Request('http://next-internal.example/api/public/chat/token-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://platform.radioso.dev',
        Host: 'platform.radioso.dev',
        'X-Forwarded-Proto': 'https, http',
        'X-Radioso-Public-Session': 'session-token',
      },
      body: JSON.stringify({ message: 'Hello', stream: true }),
    }), {
      params: Promise.resolve({ token: 'token-1' }),
    })

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(upstreamInit.headers).toMatchObject({
      Origin: 'https://platform.radioso.dev',
      'X-Forwarded-Host': 'platform.radioso.dev',
      'X-Forwarded-Proto': 'https',
      'X-Radioso-Public-Session': 'session-token',
    })
    expect(response.status).toBe(200)
  })

  it('normalizes new authenticated chat payloads before forwarding upstream', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: done\ndata: {"conversationId":"conv-2","answer":"ok"}\n\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      }),
    )

    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/api/chat/stream/route')

    const request = new Request('https://frontend.example.com/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer radioso_workspace_token',
      },
      body: JSON.stringify({
        conversationId: '5a657822-fc30-4693-8c7c-a4e7e9368afd',
        bootstrapGreetingId: '6f1a68f5-a62b-4dc9-8204-a1f4b8304e6a',
        message: 'hi',
        stream: true,
        userExpectedLocale: 'en-GB',
        inputMetadata: { method: 'typed' },
        sourceContext: { surface: 'authenticated_chat' },
      }),
    })

    const response = await POST(request)

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(upstreamInit.headers.Authorization).toBe('Bearer radioso_workspace_token')
    expect(JSON.parse(upstreamInit.body as string)).toEqual({
      conversationId: '5a657822-fc30-4693-8c7c-a4e7e9368afd',
      bootstrapGreetingId: '6f1a68f5-a62b-4dc9-8204-a1f4b8304e6a',
      message: 'hi',
      stream: true,
      userExpectedLocale: 'en-GB',
      inputMetadata: { method: 'typed' },
      sourceContext: { surface: 'authenticated_chat' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
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
