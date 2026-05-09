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
        duplex: 'half',
      }),
    )

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Headers }
    expect(upstreamInit.headers.get('content-type')).toBe('application/json')
    expect(upstreamInit.headers.get('cookie')).toBe('theme=dark')
    expect(upstreamInit.headers.get('x-forwarded-prefix')).toBe('/backend')

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
      message: 'hi',
      startConversation: undefined,
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
      conversationId: undefined,
      message: 'Hello',
      startConversation: false,
      stream: true,
      userExpectedLocale: undefined,
      inputMetadata: undefined,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-radioso-anonymous-session')).toBe('anon-1')
    expect(await response.json()).toEqual({
      conversationId: 'conv-1',
      answer: 'ok',
    })
  })
})
