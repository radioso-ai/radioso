/* @vitest-environment jsdom */

import { useEffect, useRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AnonymousChatProvider,
  type ChatMessage,
  useAnonymousChat,
} from '@/lib/anonymous-chat-context'
import { publicChatApi } from '@/lib/api'

// A turn that dies mid-flight (provider outage, DB statement timeout) must not put
// backend error text in the visitor's transcript. The context marks the turn failed
// and leaves the body empty; the view supplies the localized failure copy.

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

const conversationList = {
  workspaceName: 'Acme',
  assistantAvatarUrl: null,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  theme: { brand: '#0f172a', brandText: '#f8fafc', surface: '#ffffff', text: '#0f172a' },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
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

type Snapshot = { messages: ChatMessage[]; isHydrating: boolean }

function ChatProbe({ onSnapshot }: { onSnapshot: (snapshot: Snapshot) => void }) {
  const chat = useAnonymousChat()
  const didSendRef = useRef(false)

  useEffect(() => {
    onSnapshot({ messages: chat.messages, isHydrating: chat.isHydrating })
  }, [chat.messages, chat.isHydrating, onSnapshot])

  useEffect(() => {
    if (chat.isHydrating || didSendRef.current) {
      return
    }
    didSendRef.current = true
    void chat.sendMessage('esiste in zona Cuneo un vs centro?', { method: 'typed' })
  }, [chat])

  return null
}

const renderProvider = (onSnapshot: (snapshot: Snapshot) => void) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(
      <AnonymousChatProvider token="public-chat-token" sessionChannel={null}>
        <ChatProbe onSnapshot={onSnapshot} />
      </AnonymousChatProvider>,
    )
  })

  return { container, root }
}

describe('anonymous chat failed turn', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null

  beforeEach(() => {
    mounted = null
    publicChatApiMock.listConversations.mockResolvedValue(conversationList)
    publicChatApiMock.getConversationDetail.mockReset()
    publicChatApiMock.streamConversationEvents.mockImplementation(() => new Promise<void>(() => {}))
    publicChatApiMock.streamMessage.mockReset()
    publicChatApiMock.tailConversation.mockResolvedValue({ messages: [], cursor: null })
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

  it('marks the turn failed without writing raw backend error text into the transcript', async () => {
    publicChatApiMock.streamMessage.mockRejectedValue(
      new Error('canceling statement due to statement timeout'),
    )

    let snapshot: Snapshot = { messages: [], isHydrating: true }
    mounted = renderProvider((next) => {
      snapshot = next
    })

    await waitFor(() => {
      const assistant = snapshot.messages.find((message) => message.role === 'assistant')
      expect(assistant?.status).toBe('error')
    })

    const assistant = snapshot.messages.find((message) => message.role === 'assistant')
    expect(assistant?.content).toBe('')
    expect(JSON.stringify(snapshot.messages)).not.toContain('statement timeout')
  })

  it('keeps text that streamed before the failure', async () => {
    publicChatApiMock.streamMessage.mockImplementation((async (
      _token: unknown,
      _data: unknown,
      handlers: { onChunk?: (chunk: { text: string }) => void },
    ) => {
      handlers.onChunk?.({ text: 'Il centro più vicino' })
      await Promise.resolve()
      throw new Error('canceling statement due to statement timeout')
    }) as never)

    let snapshot: Snapshot = { messages: [], isHydrating: true }
    mounted = renderProvider((next) => {
      snapshot = next
    })

    await waitFor(() => {
      const assistant = snapshot.messages.find((message) => message.role === 'assistant')
      expect(assistant?.status).toBe('error')
    })

    const assistant = snapshot.messages.find((message) => message.role === 'assistant')
    expect(assistant?.content).toBe('Il centro più vicino')
  })
})
