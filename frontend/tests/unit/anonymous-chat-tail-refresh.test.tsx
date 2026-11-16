/* @vitest-environment jsdom */

import { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AnonymousChatProvider,
  type ChatMessage,
  useAnonymousChat,
} from '@/lib/anonymous-chat-context'
import { publicChatApi } from '@/lib/api'
import type { ChatConversationSummary } from '@/lib/api'
import { createTailRefresher, tailRefreshRetryDelayMs } from '@/lib/public-chat-tail-refresh'

// A `ready` from the visitor's event stream means a reply may have been stored while the stream
// could not hear it. The tail read it sets off is the only way that reply reaches the visitor, so a
// read that fails is tried again rather than dropped.

vi.mock('@/lib/api', () => ({
  clearStoredAnonymousSession: vi.fn(),
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
  readStoredPublicSessionResumeToken: vi.fn(() => null),
  readStoredPublicSessionToken: vi.fn(() => 'public-session-token'),
}))

const publicChatApiMock = vi.mocked(publicChatApi)

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const conversationSummary: ChatConversationSummary = {
  id: 'conversation-1',
  agentId: null,
  agentName: null,
  agentInternalName: null,
  sourceChannel: 'website_embed',
  callerKind: 'human' as const,
  sourceOrigin: 'https://site.example',
  channelContext: null,
  anonymousSessionId: null,
  entryPageUrl: null,
  visitorCountry: null,
  title: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  messageCount: 1,
  userMessageCount: 1,
  assistantMessageCount: 0,
  preview: 'Can a person help?',
}

const conversationList = {
  workspaceName: 'Acme',
  assistantAvatarUrl: null,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  theme: { brand: '#0f172a', brandText: '#f8fafc', surface: '#ffffff', text: '#0f172a' },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  intakeActions: [],
  assistantBootstrapActive: false,
  conversations: [conversationSummary],
  total: 1,
  nextCursor: null,
  hasMore: false,
}

const conversationDetail = {
  conversationId: 'conversation-1',
  workspaceId: 'workspace-1',
  agentId: null,
  sourceChannel: 'website_embed',
  callerKind: 'human' as const,
  sourceOrigin: 'https://site.example',
  channelContext: null,
  title: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  messageCount: 1,
  userMessageCount: 1,
  assistantMessageCount: 0,
  messagesTotal: 1,
  messageWindowOffset: 0,
  messageWindowLimit: 10,
  hasOlderMessages: false,
  nextCursor: null,
  tailCursor: 'user-1-cursor',
  messages: [
    {
      id: 'user-1',
      role: 'user' as const,
      source: 'customer' as const,
      content: 'Can a person help?',
      createdAt: '2026-06-01T10:00:00.000Z',
    },
  ],
}

const humanReply = {
  cursor: 'human-1-cursor',
  messages: [
    {
      id: 'human-1',
      role: 'assistant' as const,
      source: 'human_agent' as const,
      content: 'Hi, Sam here. Let me check your order.',
      createdAt: '2026-06-01T10:00:05.000Z',
    },
  ],
}

const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** Polls for up to three seconds, past the first retry's longest wait. */
const waitFor = async (assertion: () => void) => {
  let lastError: unknown
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await act(async () => {
        await pause(25)
      })
    }
  }
  throw lastError
}

function MessagesProbe({ onMessages }: { onMessages: (messages: ChatMessage[]) => void }) {
  const chat = useAnonymousChat()
  useEffect(() => {
    onMessages(chat.messages)
  }, [chat.messages, onMessages])
  return null
}

describe('tailRefreshRetryDelayMs', () => {
  it('draws each wait between half and all of a ceiling that doubles from one second', () => {
    expect(tailRefreshRetryDelayMs(0, () => 0)).toBe(500)
    expect(tailRefreshRetryDelayMs(0, () => 1)).toBe(1_000)
    expect(tailRefreshRetryDelayMs(1, () => 0)).toBe(1_000)
    expect(tailRefreshRetryDelayMs(4, () => 1)).toBe(16_000)
  })

  it('gives up after five retries, leaving the read to the next event', () => {
    expect(tailRefreshRetryDelayMs(5, () => 0)).toBeNull()
  })
})

describe('createTailRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const unavailable = new Error('Service unavailable')

  it('retries a failed read after a backoff, keeping whether it should load the conversation first', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValue(undefined)
    const refresher = createTailRefresher({ read, isGone: () => false, onGone: vi.fn(), random: () => 0 })

    refresher.refresh(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    // The second failure waits twice as long.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(read).toHaveBeenCalledTimes(3)
    expect(read.mock.calls.map(([includeSnapshot]) => includeSnapshot)).toEqual([true, true, true])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('stops retrying once the conversation is gone, and says so', async () => {
    const onGone = vi.fn()
    const read = vi.fn().mockRejectedValue(new Error('not found'))
    const refresher = createTailRefresher({ read, isGone: () => true, onGone })

    refresher.refresh(false)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(read).toHaveBeenCalledOnce()
    expect(onGone).toHaveBeenCalledOnce()
  })

  it('reads nothing more once the visitor leaves the conversation', async () => {
    const read = vi.fn().mockRejectedValue(unavailable)
    const refresher = createTailRefresher({ read, isGone: () => false, onGone: vi.fn(), random: () => 0 })

    refresher.refresh(false)
    await vi.advanceTimersByTimeAsync(0)
    refresher.stop()
    refresher.refresh(false)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(read).toHaveBeenCalledOnce()
  })

  it('gives up after five retries until the next event asks again', async () => {
    const read = vi.fn().mockRejectedValue(unavailable)
    const refresher = createTailRefresher({ read, isGone: () => false, onGone: vi.fn(), random: () => 1 })

    refresher.refresh(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(read).toHaveBeenCalledTimes(6)

    refresher.refresh(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(7)
  })
})

describe('anonymous chat tail refresh', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null

  beforeEach(() => {
    mounted = null
    publicChatApiMock.listConversations.mockResolvedValue(conversationList)
    publicChatApiMock.getConversationDetail.mockResolvedValue(conversationDetail)
    publicChatApiMock.streamConversationEvents.mockImplementation(async (_token, _conversationId, handlers) => {
      handlers?.onEvent?.({ type: 'ready', conversationId: 'conversation-1' })
      await new Promise<void>(() => {})
    })
  })

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted?.root.unmount()
      })
      mounted.container.remove()
    }
    vi.clearAllMocks()
  })

  it('reads the tail again after a failed read, so the reply a `ready` announced still shows', async () => {
    publicChatApiMock.tailConversation
      .mockRejectedValueOnce(new Error('Service unavailable'))
      .mockResolvedValueOnce(humanReply)
      .mockResolvedValue({ messages: [], cursor: 'human-1-cursor' })

    let latestMessages: ChatMessage[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted = { container, root }
    act(() => {
      root.render(
        <AnonymousChatProvider token="public-chat-token" sessionChannel={null}>
          <MessagesProbe onMessages={(messages) => { latestMessages = messages }} />
        </AnonymousChatProvider>,
      )
    })

    await waitFor(() => {
      expect(latestMessages.map((message) => message.content)).toContain('Hi, Sam here. Let me check your order.')
    })
    expect(publicChatApiMock.tailConversation).toHaveBeenCalledTimes(2)
    expect(publicChatApiMock.tailConversation).toHaveBeenLastCalledWith('public-chat-token', 'conversation-1', {
      limit: 25,
      cursor: 'user-1-cursor',
    })
  }, 10_000)
})
