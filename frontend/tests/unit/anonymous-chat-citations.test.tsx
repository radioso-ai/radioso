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

const baseConversationList = {
  workspaceName: 'Acme',
  assistantAvatarUrl: null,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
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
}

const citedAnswer = {
  answer: 'Grounded answer.',
  citations: [
    {
      documentId: '',
      chunkId: '',
      title: 'Policy Handbook',
      sourceUrl: 'https://example.com/policy',
    },
  ],
  answerSegments: [{ text: 'Grounded answer.', citationIndices: [0] }],
  suggestions: [],
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

function ChatProbe({
  sendMessage,
  onMessages,
}: {
  sendMessage?: string
  onMessages: (messages: ChatMessage[]) => void
}) {
  const chat = useAnonymousChat()
  const didSendRef = useRef(false)

  useEffect(() => {
    onMessages(chat.messages)
  }, [chat.messages, onMessages])

  useEffect(() => {
    if (!sendMessage || chat.isHydrating || didSendRef.current) {
      return
    }

    didSendRef.current = true
    void chat.sendMessage(sendMessage, { method: 'typed' })
  }, [chat, sendMessage])

  return null
}

const renderProvider = ({
  onMessages,
  sendMessage,
}: {
  onMessages: (messages: ChatMessage[]) => void
  sendMessage?: string
}) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(
      <AnonymousChatProvider token="public-chat-token" sessionChannel={null}>
        <ChatProbe onMessages={onMessages} sendMessage={sendMessage} />
      </AnonymousChatProvider>,
    )
  })

  return { container, root }
}

describe('anonymous chat citations', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null

  beforeEach(() => {
    mounted = null
    publicChatApiMock.listConversations.mockResolvedValue(baseConversationList)
    publicChatApiMock.bootstrapConversation.mockResolvedValue(undefined)
    publicChatApiMock.getConversationDetail.mockReset()
    publicChatApiMock.streamConversationEvents.mockImplementation(
      () => new Promise<void>(() => {}),
    )
    publicChatApiMock.streamMessage.mockReset()
    publicChatApiMock.tailConversation.mockResolvedValue({ messages: [], cursor: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (mounted) {
      act(() => {
        mounted?.root.unmount()
      })
      mounted.container.remove()
    }
    vi.clearAllMocks()
  })

  it('preserves citation artifacts from streamed public chat completions', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = {
        conversationId: 'conversation-1',
        assistantMessageId: 'assistant-1',
        ...citedAnswer,
      }

      handlers.onConversation?.({ conversationId: completion.conversationId })
      handlers.onDone?.(completion)
      return completion
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({
      sendMessage: 'What does the policy say?',
      onMessages: (messages) => {
        latestMessages = messages
      },
    })

    await waitFor(() => {
      const assistant = latestMessages.find((message) => message.role === 'assistant' && message.status === 'complete')
      expect(assistant?.citations).toEqual(citedAnswer.citations)
      expect(assistant?.answerSegments).toEqual(citedAnswer.answerSegments)
    })
  })

  it('does not recover the previous assistant message when HITL suppresses AI output', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = {
        conversationId: 'conversation-1',
        assistantMessageId: '',
        answer: '',
        citations: [],
        answerSegments: [],
        suggestions: [],
        ownership: {
          state: 'human_owned' as const,
          suppressed: true,
        },
      }

      handlers.onConversation?.({ conversationId: completion.conversationId })
      handlers.onDone?.(completion)
      return completion
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({
      sendMessage: 'yes',
      onMessages: (messages) => {
        latestMessages = messages
      },
    })

    await waitFor(() => {
      expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1)
      expect(latestMessages.map((message) => message.content)).toEqual(['yes'])
    })

    expect(publicChatApiMock.getConversationDetail).not.toHaveBeenCalled()
    expect(latestMessages.some((message) => message.role === 'assistant')).toBe(false)
  })

  it('renders the localized waiting message when HITL suppresses AI output', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = {
        conversationId: 'conversation-1',
        assistantMessageId: '',
        answer: 'Un compañero se está uniendo, por favor espera.',
        citations: [],
        answerSegments: [],
        suggestions: [],
        ownership: {
          state: 'human_owned' as const,
          suppressed: true,
        },
      }

      handlers.onConversation?.({ conversationId: completion.conversationId })
      handlers.onDone?.(completion)
      return completion
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({
      sendMessage: 'gracias',
      onMessages: (messages) => {
        latestMessages = messages
      },
    })

    await waitFor(() => {
      expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1)
      expect(latestMessages.map((message) => message.content)).toEqual([
        'gracias',
        'Un compañero se está uniendo, por favor espera.',
      ])
    })

    expect(publicChatApiMock.getConversationDetail).not.toHaveBeenCalled()
  })

  it('preserves citation artifacts from restored public chat history', async () => {
    publicChatApiMock.listConversations.mockResolvedValue({
      ...baseConversationList,
      conversations: [{ id: 'conversation-1', title: 'Policy', updatedAt: '2026-06-01T10:00:00.000Z' }],
    })
    publicChatApiMock.getConversationDetail.mockResolvedValue({
      conversationId: 'conversation-1',
      workspaceId: 'workspace-1',
      agentId: null,
      sourceChannel: 'website_embed',
      sourceOrigin: 'https://site.example',
      createdAt: '2026-06-01T10:00:00.000Z',
      updatedAt: '2026-06-01T10:00:00.000Z',
      messageCount: 1,
      userMessageCount: 0,
      assistantMessageCount: 1,
      messagesTotal: 1,
      messageWindowOffset: 0,
      messageWindowLimit: 10,
      hasOlderMessages: false,
      nextCursor: null,
      tailCursor: 'assistant-1-cursor',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: citedAnswer.answer,
          createdAt: '2026-06-01T10:00:00.000Z',
          citations: citedAnswer.citations,
          answerSegments: citedAnswer.answerSegments,
          suggestions: [],
        },
      ],
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({
      onMessages: (messages) => {
        latestMessages = messages
      },
    })

    await waitFor(() => {
      const assistant = latestMessages.find((message) => message.role === 'assistant')
      expect(assistant?.citations).toEqual(citedAnswer.citations)
      expect(assistant?.answerSegments).toEqual(citedAnswer.answerSegments)
    })
  })

  it('streams active public conversation notifications for human replies', async () => {
    let streamHandler: ((event: { type: 'ready' | 'message.created'; conversationId: string; messageId?: string; createdAt?: string }) => void) | null = null
    publicChatApiMock.listConversations.mockResolvedValue({
      ...baseConversationList,
      conversations: [{ id: 'conversation-1', title: 'Policy', updatedAt: '2026-06-01T10:00:00.000Z' }],
    })
    publicChatApiMock.getConversationDetail.mockResolvedValue({
      conversationId: 'conversation-1',
      workspaceId: 'workspace-1',
      agentId: null,
      sourceChannel: 'website_embed',
      sourceOrigin: 'https://site.example',
      createdAt: '2026-06-01T10:00:00.000Z',
      updatedAt: '2026-06-01T10:00:00.000Z',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messagesTotal: 2,
      messageWindowOffset: 0,
      messageWindowLimit: 10,
      hasOlderMessages: false,
      nextCursor: null,
      tailCursor: 'assistant-1-cursor',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          source: 'customer',
          content: 'Can a person help?',
          createdAt: '2026-06-01T10:00:00.000Z',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          source: 'ai_agent',
          content: 'I can connect you.',
          createdAt: '2026-06-01T10:00:01.000Z',
          suggestions: [],
        },
      ],
    })
    publicChatApiMock.tailConversation
      .mockResolvedValueOnce({ messages: [], cursor: 'assistant-1-cursor' })
      .mockResolvedValueOnce({
        cursor: 'cursor-2',
        messages: [
          {
            id: 'human-1',
            role: 'assistant',
            source: 'human_agent',
            content: 'Human reply',
            createdAt: '2026-06-01T10:00:05.000Z',
          },
        ],
      })
    publicChatApiMock.streamConversationEvents.mockImplementation(async (_token, _conversationId, handlers) => {
      streamHandler = handlers.onEvent ?? null
      handlers.onEvent?.({ type: 'ready', conversationId: 'conversation-1' })
      await new Promise<void>(() => {})
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({
      onMessages: (messages) => {
        latestMessages = messages
      },
    })

    await waitFor(() => {
      expect(publicChatApiMock.tailConversation).toHaveBeenCalledWith('public-chat-token', 'conversation-1', {
        limit: 25,
        cursor: 'assistant-1-cursor',
      })
    })

    await act(async () => {
      streamHandler?.({
        type: 'message.created',
        conversationId: 'conversation-1',
        messageId: 'human-1',
        createdAt: '2026-06-01T10:00:05.000Z',
      })
    })

    await waitFor(() => {
      expect(latestMessages.map((message) => message.content)).toContain('Human reply')
    })
    expect(publicChatApiMock.tailConversation).toHaveBeenLastCalledWith('public-chat-token', 'conversation-1', {
      limit: 25,
      cursor: 'assistant-1-cursor',
    })
  }, 10_000)

  it('preserves citation artifacts from public bootstrap greetings', async () => {
    publicChatApiMock.listConversations.mockResolvedValue({
      ...baseConversationList,
      assistantBootstrapActive: true,
    })
    publicChatApiMock.bootstrapConversation.mockResolvedValue({
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-1',
      ...citedAnswer,
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({
      onMessages: (messages) => {
        latestMessages = messages
      },
    })

    await waitFor(() => {
      const assistant = latestMessages.find((message) => message.role === 'assistant')
      expect(assistant?.citations).toEqual(citedAnswer.citations)
      expect(assistant?.answerSegments).toEqual(citedAnswer.answerSegments)
    })
  })
})
