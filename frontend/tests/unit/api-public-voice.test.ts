import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api-client', () => ({
  PUBLIC_CHAT_STREAMING_API_PATH: '/api/public/chat',
  attachAnonymousSessionHeader: (_token: string, headers: Record<string, string>) => ({
    ...headers,
    'X-Radioso-Public-Session': 'public-session-token',
  }),
}))

import { reportVoiceVendorConversation, startPublicVoiceSession } from '@/lib/api-public-voice'

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const session = {
  vendor: 'elevenlabs',
  signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig',
  sessionKey: '33333333-3333-4333-8333-333333333333',
  locale: 'it',
  expiresAt: '2026-10-16T12:15:00.000Z',
}

describe('public voice session start', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("asks the app host's relay with the embed's public session and the visitor's language", async () => {
    const fetchMock = vi.fn(async () => respond(200, session))
    vi.stubGlobal('fetch', fetchMock)

    const result = await startPublicVoiceSession('launch token', { locale: 'it' })

    expect(result).toEqual({
      kind: 'started',
      session: { vendor: 'elevenlabs', signedUrl: session.signedUrl, sessionKey: session.sessionKey, locale: 'it' },
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/public/chat/launch%20token/voice/sessions')
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(init.headers).toMatchObject({ 'X-Radioso-Public-Session': 'public-session-token' })
    expect(JSON.parse(init.body as string)).toEqual({ locale: 'it' })
  })

  it('sends no locale when the visitor names none', async () => {
    const fetchMock = vi.fn(async () => respond(200, session))
    vi.stubGlobal('fetch', fetchMock)

    await startPublicVoiceSession('launch-token', {})

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({})
  })

  it.each([
    ['voice is off', 404, { error: { code: 'not_found', message: 'Voice sessions are not available for this agent.' } }],
    ['the start budget is spent', 429, { error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }],
    ['the session could not be started', 503, { error: { code: 'voice_unavailable', message: 'Try again later.' } }],
    ['the answer names a vendor the page cannot open', 200, { ...session, vendor: 'another-vendor' }],
    ['the answer is not a session', 200, { signedUrl: session.signedUrl }],
  ])('reads it as refused when %s', async (_case, status, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(status, body)))

    expect(await startPublicVoiceSession('launch-token', {})).toEqual({ kind: 'refused' })
  })

  it('reads a network failure as refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))

    expect(await startPublicVoiceSession('launch-token', {})).toEqual({ kind: 'refused' })
  })
})

describe('public voice session start: recording notice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps the agent's recording notice for the page to show", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { ...session, recordingNotice: 'Questa chiamata viene registrata.' })))

    const result = await startPublicVoiceSession('token', { locale: 'it' })

    expect(result).toMatchObject({ kind: 'started', session: { recordingNotice: 'Questa chiamata viene registrata.' } })
  })
})

describe('vendor conversation report', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("tells the app host's relay the vendor's id for the session's call, with the embed's public session, and outlives the page", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(reportVoiceVendorConversation('launch token', { sessionKey: session.sessionKey, vendorConversationId: 'conv_1' })).resolves.toBe('recorded')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/public/chat/launch%20token/voice/sessions/${session.sessionKey}/vendor-conversation`)
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(init.headers).toMatchObject({ 'X-Radioso-Public-Session': 'public-session-token' })
    expect(JSON.parse(init.body as string)).toEqual({ vendorConversationId: 'conv_1' })
  })

  it('tries once more when the report does not get through, and never rejects', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(reportVoiceVendorConversation('token', { sessionKey: session.sessionKey, vendorConversationId: 'conv_1' })).resolves.toBe('recorded')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const failing = vi.fn(async () => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', failing)
    await expect(reportVoiceVendorConversation('token', { sessionKey: session.sessionKey, vendorConversationId: 'conv_1' })).resolves.toBe('failed')
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('takes a refusal as final', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(reportVoiceVendorConversation('token', { sessionKey: session.sessionKey, vendorConversationId: 'conv_1' })).resolves.toBe('refused')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
