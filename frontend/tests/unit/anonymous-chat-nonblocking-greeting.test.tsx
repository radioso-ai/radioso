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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

const greetingActiveConversationList = {
  workspaceName: 'Acme',
  assistantAvatarUrl: null,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  theme: { brand: '#0f172a', brandText: '#f8fafc', surface: '#ffffff', text: '#0f172a' },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  intakeActions: [],
  assistantBootstrapActive: true,
  conversations: [],
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

function ChatProbe({
  sendMessage,
  onSnapshot,
}: {
  sendMessage?: string
  onSnapshot: (snapshot: Snapshot) => void
}) {
  const chat = useAnonymousChat()
  const didSendRef = useRef(false)

  useEffect(() => {
    onSnapshot({ messages: chat.messages, isHydrating: chat.isHydrating })
  }, [chat.messages, chat.isHydrating, onSnapshot])

  useEffect(() => {
    if (!sendMessage || chat.isHydrating || didSendRef.current) {
      return
    }
    didSendRef.current = true
    void chat.sendMessage(sendMessage, { method: 'typed' })
  }, [chat, sendMessage])

  return null
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const renderProvider = ({
  onSnapshot,
  sendMessage,
}: {
  onSnapshot: (snapshot: Snapshot) => void
  sendMessage?: string
}) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(
      <AnonymousChatProvider token="public-chat-token" sessionChannel={null}>
        <ChatProbe onSnapshot={onSnapshot} sendMessage={sendMessage} />
      </AnonymousChatProvider>,
    )
  })

  return { container, root }
}

describe('anonymous chat non-blocking greeting', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null

  beforeEach(() => {
    mounted = null
    publicChatApiMock.listConversations.mockResolvedValue(greetingActiveConversationList)
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

  it('unblocks the chat with a typing placeholder while the greeting is still generating', async () => {
    const greeting = deferred<unknown>()
    publicChatApiMock.bootstrapConversation.mockReturnValue(greeting.promise as Promise<never>)

    let snapshot: Snapshot = { messages: [], isHydrating: true }
    mounted = renderProvider({
      onSnapshot: (next) => {
        snapshot = next
      },
    })

    // Interactive (not hydrating) with a streaming/empty assistant placeholder —
    // which renders as the typing bubble — before the greeting LLM returns.
    await waitFor(() => {
      expect(snapshot.isHydrating).toBe(false)
      const assistant = snapshot.messages.find((message) => message.role === 'assistant')
      expect(assistant).toBeTruthy()
      expect(assistant?.status).toBe('streaming')
      expect(assistant?.content).toBe('')
    })

    await act(async () => {
      greeting.resolve({
        conversationId: 'conversation-1',
        assistantMessageId: 'assistant-1',
        answer: 'Hi there, how can I help?',
        citations: [],
        answerSegments: [],
        suggestions: [],
      })
      await flush()
    })

    await waitFor(() => {
      const assistant = snapshot.messages.find((message) => message.role === 'assistant')
      expect(assistant?.status).toBe('complete')
      expect(assistant?.content).toBe('Hi there, how can I help?')
    })
  })

  it('lets a message sent mid-greeting join the greeting conversation', async () => {
    const greeting = deferred<unknown>()
    publicChatApiMock.bootstrapConversation.mockReturnValue(greeting.promise as Promise<never>)

    let capturedSendPayload: { conversationId?: string; bootstrapGreetingId?: string } | null = null
    publicChatApiMock.streamMessage.mockImplementation(async (_token, data, handlers) => {
      capturedSendPayload = data as { conversationId?: string; bootstrapGreetingId?: string }
      const completion = {
        conversationId: 'conversation-1',
        assistantMessageId: 'assistant-2',
        answer: 'Here is your answer.',
        citations: [],
        answerSegments: [],
        suggestions: [],
      }
      handlers.onConversation?.({ conversationId: completion.conversationId })
      handlers.onDone?.(completion)
      return completion
    })

    let snapshot: Snapshot = { messages: [], isHydrating: true }
    // The probe auto-sends as soon as the UI unblocks — i.e. while the greeting
    // is still generating.
    mounted = renderProvider({
      sendMessage: 'what are your hours?',
      onSnapshot: (next) => {
        snapshot = next
      },
    })

    await waitFor(() => {
      expect(snapshot.isHydrating).toBe(false)
    })

    // The mid-greeting turn must wait for the greeting to resolve so it can join
    // the same conversation instead of forking a new one.
    await act(async () => {
      await flush()
    })
    expect(publicChatApiMock.streamMessage).not.toHaveBeenCalled()

    await act(async () => {
      greeting.resolve({
        bootstrapGreetingId: 'greeting-1',
        assistantMessageId: 'assistant-1',
        answer: 'Welcome!',
        citations: [],
        answerSegments: [],
        suggestions: [],
      })
      await flush()
    })

    await waitFor(() => {
      expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1)
    })

    expect(capturedSendPayload?.bootstrapGreetingId).toBe('greeting-1')
    expect(capturedSendPayload?.conversationId).toBeUndefined()

    await waitFor(() => {
      expect(snapshot.messages.map((message) => message.content)).toEqual([
        'Welcome!',
        'what are your hours?',
        'Here is your answer.',
      ])
    })
  })

  it('drops the placeholder when the greeting produces no message', async () => {
    const greeting = deferred<unknown>()
    publicChatApiMock.bootstrapConversation.mockReturnValue(greeting.promise as Promise<never>)

    let snapshot: Snapshot = { messages: [], isHydrating: true }
    mounted = renderProvider({
      onSnapshot: (next) => {
        snapshot = next
      },
    })

    await waitFor(() => {
      expect(snapshot.isHydrating).toBe(false)
      expect(snapshot.messages.some((message) => message.role === 'assistant')).toBe(true)
    })

    await act(async () => {
      greeting.resolve(undefined)
      await flush()
    })

    await waitFor(() => {
      expect(snapshot.messages).toHaveLength(0)
    })
  })
})
