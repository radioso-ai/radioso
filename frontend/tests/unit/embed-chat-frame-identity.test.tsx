/* @vitest-environment jsdom */

import { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnonymousChatProvider, useAnonymousChat } from '@/lib/anonymous-chat-context'
import { EmbeddedChatFrame } from '@/components/chat/embedded-chat-frame'
import { publicChatApi } from '@/lib/api'

// PublicChatShell owns the real composer UI (input box, send button, keyboard
// handling); driving a send through it would require re-implementing that UI
// in this test. EmbeddedChatFrame only hands PublicChatShell a token and a
// resolveSignedIdentity callback, so this thin stub keeps that same contract
// but swaps the UI for a driver that calls sendMessage() directly through the
// real AnonymousChatProvider — the same provider PublicChatShell renders in
// production. This exercises EmbeddedChatFrame's real resolveSignedIdentity
// and message handling without exporting any frame internals.
const sendBus = new EventTarget()
const triggerSend = (message: string) => {
  sendBus.dispatchEvent(new CustomEvent('send', { detail: message }))
}

type AnonymousChat = ReturnType<typeof useAnonymousChat>

function IdentitySendDriver({ onChat }: { onChat: (chat: AnonymousChat) => void }) {
  const chat = useAnonymousChat()

  useEffect(() => {
    onChat(chat)
  }, [chat, onChat])

  useEffect(() => {
    const handler = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      void chat.sendMessage(message, { method: 'typed' })
    }
    sendBus.addEventListener('send', handler)
    return () => sendBus.removeEventListener('send', handler)
  }, [chat])

  return null
}

vi.mock('@/components/chat/public-chat-shell', () => ({
  PublicChatShell: ({
    token,
    resolveSignedIdentity,
  }: {
    token: string
    resolveSignedIdentity?: () => Promise<string | null>
  }) => (
    <AnonymousChatProvider token={token} sessionChannel={null} resolveSignedIdentity={resolveSignedIdentity}>
      <IdentitySendDriver onChat={(chat) => { latestChat = chat }} />
    </AnonymousChatProvider>
  ),
  PublicChatThreadLoadingView: () => null,
}))

vi.mock('@/lib/api', () => ({
  answerFeedbackApi: {
    clearPublic: vi.fn(),
    submitPublic: vi.fn(),
  },
  clearStoredAnonymousSession: vi.fn(),
  clearStoredEmbedBootstrapSession: vi.fn(),
  publicChatApi: {
    bootstrapConversation: vi.fn(),
    createSession: vi.fn(),
    getConversationDetail: vi.fn(),
    listConversations: vi.fn(),
    streamConversationEvents: vi.fn(),
    streamMessage: vi.fn(),
    tailConversation: vi.fn(),
  },
  readStoredAnonymousSessionId: vi.fn(() => null),
  readStoredEffectivePublicChatToken: vi.fn(() => null),
  readStoredEmbedBootstrapSession: vi.fn(() => null),
  readStoredPublicSessionResumeToken: vi.fn(() => null),
  readStoredPublicSessionToken: vi.fn(() => 'public-session-token'),
  storeEmbedBootstrapSession: vi.fn(),
}))

const publicChatApiMock = vi.mocked(publicChatApi)

// Set by IdentitySendDriver's onChat callback each render; read back from
// tests to know when hydration has settled before triggering a send.
let latestChat: AnonymousChat | null = null

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const baseConversationList = {
  workspaceName: 'Acme',
  assistantAvatarUrl: null,
  theme: {
    brand: '#0f172a',
    brandText: '#f8fafc',
    surface: '#ffffff',
    text: '#0f172a',
  },
  branding: {
    hidePoweredBy: false,
    privacyPolicyUrl: null,
  },
  intakeActions: [],
  assistantBootstrapActive: false,
  conversations: [],
  total: 0,
  nextCursor: null,
  hasMore: false,
}

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0))

const waitFor = async (assertion: () => void) => {
  let lastError: unknown

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await act(async () => {
        await flush()
      })
    }
  }

  throw lastError
}

const waitForWithFakeTimers = async (assertion: () => void) => {
  let lastError: unknown

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
    }
  }

  throw lastError
}

const buildSessionMessageEvent = (
  parent: unknown,
  overrides: Record<string, unknown> = {},
) => {
  const event = new MessageEvent('message', {
    data: {
      type: 'radioso:embed:session',
      session: {
        workspaceName: 'Acme',
        publicChatToken: 'public-chat-token',
        publicSessionId: 'embed-session-1',
        publicSessionToken: 'session-token',
        expiresAt: '2026-05-27T11:00:00.000Z',
        resumeToken: 'resume-token',
        resumeExpiresAt: '2026-06-27T11:00:00.000Z',
      },
      ...overrides,
    },
  })
  Object.defineProperty(event, 'source', { value: parent })
  return event
}

const buildIdentityMessageEvent = (parent: unknown, data: Record<string, unknown>) => {
  const event = new MessageEvent('message', {
    data: { type: 'radioso:embed:identity', ...data },
  })
  Object.defineProperty(event, 'source', { value: parent })
  return event
}

const findPostedMessages = (parent: { postMessage: ReturnType<typeof vi.fn> }, type: string) =>
  parent.postMessage.mock.calls.map(([message]) => message).filter((message) => message?.type === type)

describe('embedded chat frame signed identity', () => {
  let container: HTMLDivElement
  let root: Root | null
  let originalParent: WindowProxy
  let parent: { postMessage: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = null
    latestChat = null
    originalParent = window.parent
    parent = { postMessage: vi.fn() }
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: parent,
    })
    publicChatApiMock.listConversations.mockResolvedValue(baseConversationList)
    publicChatApiMock.bootstrapConversation.mockResolvedValue(undefined)
    publicChatApiMock.getConversationDetail.mockReset()
    publicChatApiMock.streamConversationEvents.mockImplementation(
      () => new Promise<void>(() => {}),
    )
    publicChatApiMock.streamMessage.mockReset()
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = {
        conversationId: 'conversation-1',
        answer: 'Answer text',
        citations: [],
        suggestions: [],
      }
      handlers?.onConversation?.({ conversationId: completion.conversationId })
      handlers?.onDone?.(completion)
      return completion
    })
    publicChatApiMock.tailConversation.mockResolvedValue({ messages: [], cursor: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (root) {
      act(() => {
        root?.unmount()
      })
    }
    container.remove()
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent,
    })
    vi.clearAllMocks()
  })

  it('requests a fresh signed identity from the host on send in provider mode', async () => {
    root = createRoot(container)
    act(() => {
      root?.render(<EmbeddedChatFrame token="embed-token" />)
    })

    act(() => {
      window.dispatchEvent(buildSessionMessageEvent(parent, { identityProvider: true }))
    })

    await waitFor(() => expect(latestChat?.isHydrating).toBe(false))

    triggerSend('Hello via provider')

    await waitFor(() => {
      expect(findPostedMessages(parent, 'radioso:embed:identity-request')).toHaveLength(1)
    })

    const [requestMessage] = findPostedMessages(parent, 'radioso:embed:identity-request')
    expect(typeof requestMessage.requestId).toBe('string')

    act(() => {
      window.dispatchEvent(
        buildIdentityMessageEvent(parent, { requestId: requestMessage.requestId, signedIdentity: 'tok' }),
      )
    })

    await waitFor(() => expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1))

    expect(publicChatApiMock.streamMessage.mock.calls[0]?.[1]).toMatchObject({
      signedIdentity: 'tok',
    })
  })

  it('sends with a null identity when the host never replies within the timeout', async () => {
    vi.useFakeTimers()

    root = createRoot(container)
    act(() => {
      root?.render(<EmbeddedChatFrame token="embed-token" />)
    })

    act(() => {
      window.dispatchEvent(buildSessionMessageEvent(parent, { identityProvider: true }))
    })

    await waitForWithFakeTimers(() => expect(latestChat?.isHydrating).toBe(false))

    triggerSend('Hello with no reply')

    await waitForWithFakeTimers(() => {
      expect(findPostedMessages(parent, 'radioso:embed:identity-request')).toHaveLength(1)
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    await waitForWithFakeTimers(() => expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1))

    expect(publicChatApiMock.streamMessage.mock.calls[0]?.[1]).toMatchObject({
      signedIdentity: null,
    })
  })

  it('sends the static token with no identity-request round trip in static mode', async () => {
    root = createRoot(container)
    act(() => {
      root?.render(<EmbeddedChatFrame token="embed-token" />)
    })

    act(() => {
      window.dispatchEvent(
        buildSessionMessageEvent(parent, { identityProvider: false, signedIdentity: 'static' }),
      )
    })

    await waitFor(() => expect(latestChat?.isHydrating).toBe(false))

    triggerSend('Hello static')

    await waitFor(() => expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1))

    expect(publicChatApiMock.streamMessage.mock.calls[0]?.[1]).toMatchObject({
      signedIdentity: 'static',
    })
    expect(findPostedMessages(parent, 'radioso:embed:identity-request')).toHaveLength(0)
  })

  it('switches to the request path after an unrequested provider-mode identity update', async () => {
    root = createRoot(container)
    act(() => {
      root?.render(<EmbeddedChatFrame token="embed-token" />)
    })

    act(() => {
      window.dispatchEvent(
        buildSessionMessageEvent(parent, { identityProvider: false, signedIdentity: 'static' }),
      )
    })

    await waitFor(() => expect(latestChat?.isHydrating).toBe(false))

    act(() => {
      window.dispatchEvent(buildIdentityMessageEvent(parent, { identityProvider: true, signedIdentity: null }))
    })

    triggerSend('Hello after switch')

    await waitFor(() => {
      expect(findPostedMessages(parent, 'radioso:embed:identity-request')).toHaveLength(1)
    })

    const [requestMessage] = findPostedMessages(parent, 'radioso:embed:identity-request')

    act(() => {
      window.dispatchEvent(
        buildIdentityMessageEvent(parent, { requestId: requestMessage.requestId, signedIdentity: 'switched-token' }),
      )
    })

    await waitFor(() => expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1))

    expect(publicChatApiMock.streamMessage.mock.calls[0]?.[1]).toMatchObject({
      signedIdentity: 'switched-token',
    })
  })
})
