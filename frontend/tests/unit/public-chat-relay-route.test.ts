import { afterEach, describe, expect, it, vi } from 'vitest'

import type { components } from '../../../typescript-sdk/src/generated/types'

type PublicChatRequest = components['schemas']['PublicChatRequest']

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

  it('forwards the privacy notice version and the signed identity, so the backend records and verifies them', async () => {
    const { upstream } = await relay({
      message: 'When do you open?',
      stream: true,
      privacyNoticeVersion: 'a1b2c3d4',
      signedIdentity: 'eyJjdXN0b21lcklkIjoiY3VzdC0xIn0.c2ln',
    })

    expect(upstream.privacyNoticeVersion).toBe('a1b2c3d4')
    expect(upstream.signedIdentity).toBe('eyJjdXN0b21lcklkIjoiY3VzdC0xIn0.c2ln')
  })

  it('forwards every field the backend accepts, unchanged', async () => {
    // Typed as the full request so a field the backend gains fails this file's typecheck until it is listed here.
    const everyField: Required<PublicChatRequest> = {
      message: 'Is this in stock?',
      imageIds: [IMAGE_ID],
      stream: true,
      conversationId: '0d6b1c0e-7f3a-4e55-9a49-6a1f4cbd2a10',
      bootstrapGreetingId: '5f2f8a52-3b1c-4f0e-8c46-2f9d3c7b1e44',
      startConversation: false,
      userExpectedLocale: 'it',
      pageContext: { pageUrl: 'https://example.test/', pageTitle: 'Shop', browserTimeZone: 'Europe/Rome' },
      clientContextCapabilities: {
        'page.read': { available: true, mode: 'metadata', supportedOperations: ['metadata'] },
        'reply.blocks': { item_list: { layouts: ['carousel', 'list'] } },
      },
      signedIdentity: 'signed-identity-token',
      privacyNoticeVersion: 'a1b2c3d4',
      inputMetadata: {
        method: 'item_select',
        selection: {
          messageId: '9a3c1d52-6e0b-4b7e-8d3a-1c5f2e7a9b01',
          blockId: 'block-1',
          itemKey: 'item-1',
        },
      },
    }

    const { upstream } = await relay(everyField)

    expect(upstream).toEqual(everyField)
  })

  it('maps the older query and bootstrapGreeting names onto message and startConversation', async () => {
    const { upstream } = await relay({ query: 'Hello', bootstrapGreeting: true, stream: true })

    expect(upstream).toMatchObject({ message: 'Hello', startConversation: true, stream: true })
    expect(upstream).not.toHaveProperty('query')
    expect(upstream).not.toHaveProperty('bootstrapGreeting')
  })

  it('prefers message and startConversation when a page sends both names', async () => {
    const { upstream } = await relay({ message: 'Current', query: 'Older', startConversation: false, bootstrapGreeting: true })

    expect(upstream).toMatchObject({ message: 'Current', startConversation: false })
  })

  it('leaves out a field the page sends as null, since the backend takes an absent field', async () => {
    // The embed frame sends `signedIdentity: null` for a visitor the site has not identified.
    const { upstream } = await relay({ message: 'Hi', stream: true, signedIdentity: null, pageContext: null })

    expect(upstream).toEqual({ message: 'Hi', stream: true })
  })

  it('does not pass on a field the backend schema does not list', async () => {
    const { upstream } = await relay({ message: 'Hi', stream: true, workspaceId: 'workspace-1', verifiedCustomerId: 'customer-1' })

    expect(upstream).toEqual({ message: 'Hi', stream: true })
  })

  it('answers a body that is not an object with an empty request for the backend to refuse', async () => {
    const { upstream } = await relay('just text')

    expect(upstream).toEqual({})
  })
})
