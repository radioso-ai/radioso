import { afterEach, describe, expect, it, vi } from 'vitest'

const BACKEND_URL = 'https://backend.example.com'
const IMAGE_ID = '6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12'

const relay = async (body: unknown) => {
  vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)

  const { POST } = await import('@/app/api/public/chat/[token]/route')
  await POST(
    new Request('https://frontend.example.com/api/public/chat/token-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Radioso-Public-Session': 'session-1' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token: 'token-1' }) },
  )

  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
  return { url, headers: init.headers, upstream: JSON.parse(init.body as string) as Record<string, unknown> }
}

describe('public chat relay route', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('forwards the photos a message carries, so the agent reads them', async () => {
    const { url, upstream } = await relay({ imageIds: [IMAGE_ID], stream: true, conversationId: 'conversation-1' })

    expect(url).toBe(`${BACKEND_URL}/api/v1/public/chat/token-1`)
    expect(upstream.imageIds).toEqual([IMAGE_ID])
    expect(upstream.stream).toBe(true)
    expect(upstream.conversationId).toBe('conversation-1')
  })

  it('sends a photo-only message without a message field', async () => {
    const { upstream } = await relay({ imageIds: [IMAGE_ID], stream: true })

    expect(upstream).not.toHaveProperty('message')
    expect(upstream.imageIds).toEqual([IMAGE_ID])
  })

  it('forwards the typed text with the photos, and the visitor session header', async () => {
    const { upstream, headers } = await relay({ message: 'Something like this', imageIds: [IMAGE_ID], stream: true })

    expect(upstream.message).toBe('Something like this')
    expect(headers['x-radioso-public-session'] ?? headers['X-Radioso-Public-Session']).toBe('session-1')
  })

  it('forwards the fields a text message has always carried', async () => {
    const { upstream } = await relay({
      message: 'When do you open?',
      stream: true,
      conversationId: 'conversation-1',
      bootstrapGreetingId: 'greeting-1',
      userExpectedLocale: 'it',
      inputMetadata: { method: 'typed' },
      pageContext: { pageUrl: 'https://example.test/' },
    })

    expect(upstream).toMatchObject({
      message: 'When do you open?',
      stream: true,
      conversationId: 'conversation-1',
      bootstrapGreetingId: 'greeting-1',
      userExpectedLocale: 'it',
      inputMetadata: { method: 'typed' },
      pageContext: { pageUrl: 'https://example.test/' },
    })
    expect(upstream).not.toHaveProperty('imageIds')
  })
})
