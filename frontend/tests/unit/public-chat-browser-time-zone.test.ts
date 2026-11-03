import { afterEach, describe, expect, it, vi } from 'vitest'

import { withBrowserTimeZone } from '@/lib/browser-time-zone'

vi.mock('@/lib/api-client', () => ({
  API_BASE: '/backend/api/v1',
  PUBLIC_CHAT_STREAMING_API_PATH: '/backend/api/v1/public/chat',
  attachAnonymousSessionHeader: (_token: string, headers: Record<string, string>) => headers,
  buildError: async (response: Response) => response.json(),
  canRetryWithFreshWorkspaceToken: () => false,
  persistAnonymousSessionHeader: vi.fn(),
  refreshWorkspaceApiToken: vi.fn(),
  request: vi.fn(),
  requestLongRunning: vi.fn(),
  requireWorkspaceApiToken: async () => 'workspace-token',
  storeEffectivePublicChatToken: vi.fn(),
  storePublicSessionResumeToken: vi.fn(),
  storePublicSessionToken: vi.fn(),
  storeWorkspaceToken: vi.fn(),
  getStoredActiveWorkspaceId: () => 'workspace-1',
}))

const stubBrowserZone = (timeZone: string | undefined) => {
  const RealDateTimeFormat = Intl.DateTimeFormat
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
    const formatter = new RealDateTimeFormat(...args)
    return Object.assign(Object.create(formatter) as Intl.DateTimeFormat, {
      resolvedOptions: () => ({ ...formatter.resolvedOptions(), timeZone }),
    })
  })
}

describe('withBrowserTimeZone', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("adds the browser's zone to the page context the request already carries", () => {
    stubBrowserZone('America/Los_Angeles')

    expect(withBrowserTimeZone({ message: 'Hi', pageContext: { pageUrl: 'https://example.com/events' } })).toEqual({
      message: 'Hi',
      pageContext: { pageUrl: 'https://example.com/events', browserTimeZone: 'America/Los_Angeles' },
    })
  })

  it('gives a request without page context one that names only the zone', () => {
    stubBrowserZone('Europe/Rome')

    expect(withBrowserTimeZone({ message: 'Hi', pageContext: null })).toEqual({
      message: 'Hi',
      pageContext: { browserTimeZone: 'Europe/Rome' },
    })
  })

  it('leaves the request as it was when the browser reports no zone', () => {
    stubBrowserZone(undefined)

    const request = { message: 'Hi', pageContext: { pageUrl: 'https://example.com' } }
    expect(withBrowserTimeZone(request)).toBe(request)
  })

  it("sends the browser's zone with every public chat message", async () => {
    stubBrowserZone('America/Los_Angeles')
    const { publicChatApi } = await import('@/lib/api')
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ conversationId: 'c1', answer: 'A.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await publicChatApi.sendMessage('public-token', { message: 'Hi', stream: false })
    await publicChatApi.streamMessage('public-token', { message: 'Hi', stream: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body)).pageContext).toEqual({ browserTimeZone: 'America/Los_Angeles' })
    }
  })
})
