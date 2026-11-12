import { afterEach, describe, expect, it, vi } from 'vitest'

const BACKEND_URL = 'https://backend.example.com'

describe('backend proxy route with a photo upload', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('passes a multipart upload through with its boundary and its bytes, and the visitor session header', async () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', BACKEND_URL)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12', readingStatus: 'read' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { POST } = await import('@/app/backend/[...path]/route')

    const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const form = new FormData()
    form.append('image', new File([photoBytes], 'farmhouse.jpg', { type: 'image/jpeg' }))
    form.append('locale', 'it')

    const response = await POST(
      new Request('https://frontend.example.com/backend/api/v1/public/chat/chat-token/images', {
        method: 'POST',
        headers: { 'X-Radioso-Public-Session': 'session-1' },
        body: form,
      }),
      { params: Promise.resolve({ path: ['api', 'v1', 'public', 'chat', 'chat-token', 'images'] }) },
    )

    expect(response.status).toBe(201)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }]
    expect(url).toBe(`${BACKEND_URL}/api/v1/public/chat/chat-token/images`)
    expect(init.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    expect(init.headers.get('x-radioso-public-session')).toBe('session-1')

    const upstream = init.body as ArrayBuffer
    const forwarded = new Uint8Array(upstream)
    const text = new TextDecoder('latin1').decode(forwarded)
    expect(text).toContain('name="image"; filename="farmhouse.jpg"')
    expect(text).toContain('name="locale"')
    const jpegStart = text.indexOf('\xff\xd8\xff\xe0')
    expect([...forwarded.slice(jpegStart, jpegStart + photoBytes.length)]).toEqual([...photoBytes])
  })
})
