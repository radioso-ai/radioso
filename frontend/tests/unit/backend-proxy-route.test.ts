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
          requiresEmailVerification: false,
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
      requiresEmailVerification: false,
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
        Authorization: 'Bearer sk_proj_workspace_token',
      },
      body: JSON.stringify({
        query: 'Hello',
        stream: true,
      }),
    })

    const response = await POST(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `${BACKEND_URL}/api/v1/chat/`,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    )

    const upstreamInit = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(upstreamInit.headers.Authorization).toBe('Bearer sk_proj_workspace_token')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
  })
})
