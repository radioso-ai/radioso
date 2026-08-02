/* @vitest-environment jsdom */

import { useEffect, useRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnonymousChatProvider, useAnonymousChat } from '@/lib/anonymous-chat-context'
import { EmbeddedChatFrame } from '@/components/chat/embedded-chat-frame'
import {
  WEBSITE_EMBED_ANALYTICS_MESSAGE,
  postWebsiteEmbedAnalyticsEvent,
  type WebsiteEmbedAnalyticsInput,
  type WebsiteEmbedAnalyticsMessage,
} from '@/lib/embed-analytics'
import { publicChatApi } from '@/lib/api'

vi.mock('@/components/chat/public-chat-shell', () => ({
  PublicChatShell: () => null,
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
  readStoredPublicSessionToken: vi.fn(() => 'public-session-token'),
  storeEmbedBootstrapSession: vi.fn(),
}))

const publicChatApiMock = vi.mocked(publicChatApi)

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

function ChatSendDriver({ message }: { message: string }) {
  const chat = useAnonymousChat()
  const didSendRef = useRef(false)

  useEffect(() => {
    if (chat.isHydrating || didSendRef.current) {
      return
    }

    didSendRef.current = true
    void chat.sendMessage(message, { method: 'typed' })
  }, [chat, message])

  return null
}

const renderEmbeddedProvider = ({
  container,
  embedSessionId,
  onPostedMessage,
}: {
  container: HTMLElement
  embedSessionId: string
  onPostedMessage: (message: WebsiteEmbedAnalyticsMessage) => void
}) => {
  const root = createRoot(container)
  const parent = {
    postMessage: vi.fn((message: WebsiteEmbedAnalyticsMessage) => onPostedMessage(message)),
  }
  const onAnalyticsEvent = (event: WebsiteEmbedAnalyticsInput) => {
    postWebsiteEmbedAnalyticsEvent({
      window: { parent },
      ...event,
      properties: {
        ...event.properties,
        embedSessionId,
      },
    })
  }

  act(() => {
    root.render(
      <AnonymousChatProvider
        token="public-chat-token"
        sessionChannel={null}
        onAnalyticsEvent={onAnalyticsEvent}
      >
        <ChatSendDriver message="Hello" />
      </AnonymousChatProvider>,
    )
  })

  return root
}

describe('embedded chat analytics lifecycle', () => {
  let container: HTMLDivElement
  let root: Root | null
  let originalParent: WindowProxy

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = null
    originalParent = window.parent
    publicChatApiMock.listConversations.mockResolvedValue(baseConversationList)
    publicChatApiMock.streamConversationEvents.mockImplementation(
      () => new Promise<void>(() => {}),
    )
    publicChatApiMock.streamMessage.mockReset()
    publicChatApiMock.tailConversation.mockResolvedValue({ messages: [], cursor: null })
  })

  afterEach(() => {
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

  it('emits chat started and completed once with the embed session id', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = {
        conversationId: 'conversation-1',
        answer: 'Answer text',
        citations: [{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source' }],
      suggestions: [{ text: 'Follow up?', kind: 'follow_up' }],
      }

      handlers?.onConversation?.({ conversationId: completion.conversationId })
      handlers?.onDone?.(completion)
      return completion
    })

    const postedMessages: WebsiteEmbedAnalyticsMessage[] = []
    root = renderEmbeddedProvider({
      container,
      embedSessionId: 'embed-session-1',
      onPostedMessage: (message) => postedMessages.push(message),
    })

    await waitFor(() => {
      expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1)
      expect(postedMessages.filter((message) => message.type === WEBSITE_EMBED_ANALYTICS_MESSAGE)).toHaveLength(2)
    })

    expect(postedMessages.map((message) => message.event)).toEqual(['chat.started', 'chat.completed'])
    expect(postedMessages[0]).toEqual(expect.objectContaining({
      event: 'chat.started',
      properties: expect.objectContaining({
        embedSessionId: 'embed-session-1',
        inputMethod: 'typed',
      }),
    }))
    expect(postedMessages[1]).toEqual(expect.objectContaining({
      event: 'chat.completed',
      subjectId: 'conversation-1',
      properties: expect.objectContaining({
        citationCount: 1,
        embedSessionId: 'embed-session-1',
        hasAnswer: true,
        inputMethod: 'typed',
        suggestionCount: 1,
      }),
    }))
  })

  it('emits recovered completions once with citation and suggestion counts', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = {
        conversationId: 'conversation-recovered',
        answer: '',
        citations: [],
        suggestions: [],
      }

      handlers?.onConversation?.({ conversationId: completion.conversationId })
      handlers?.onDone?.(completion)
      return completion
    })
    publicChatApiMock.getConversationDetail.mockResolvedValue({
      conversationId: 'conversation-recovered',
      workspaceId: 'workspace-1',
      agentId: null,
      sourceChannel: 'website_embed',
      sourceOrigin: 'https://site.example',
      channelContext: null,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      messagesTotal: 2,
      messageWindowOffset: 0,
      messageWindowLimit: 50,
      hasOlderMessages: false,
      nextCursor: null,
      tailCursor: 'assistant-recovered-cursor',
      messages: [
        {
          id: 'assistant-recovered',
          role: 'assistant',
          source: 'ai_agent',
          content: 'Recovered answer.',
          createdAt: '2026-05-27T10:00:00.000Z',
          citations: [{ documentId: 'doc-1', chunkId: 'chunk-1', title: 'Source' }],
          suggestions: [{ text: 'Recovered follow up?', kind: 'follow_up' }],
        },
      ],
    })

    const postedMessages: WebsiteEmbedAnalyticsMessage[] = []
    root = renderEmbeddedProvider({
      container,
      embedSessionId: 'embed-session-3',
      onPostedMessage: (message) => postedMessages.push(message),
    })

    await waitFor(() => {
      expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1)
      expect(publicChatApiMock.getConversationDetail).toHaveBeenCalledTimes(1)
      expect(postedMessages.filter((message) => message.type === WEBSITE_EMBED_ANALYTICS_MESSAGE)).toHaveLength(2)
    })

    expect(postedMessages.map((message) => message.event)).toEqual(['chat.started', 'chat.completed'])
    expect(postedMessages[1]).toEqual(expect.objectContaining({
      event: 'chat.completed',
      subjectId: 'conversation-recovered',
      properties: expect.objectContaining({
        citationCount: 1,
        embedSessionId: 'embed-session-3',
        hasAnswer: true,
        recovered: true,
        suggestionCount: 1,
      }),
    }))
  })

  it('emits empty answers without recovery as failed, not completed', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = {
        conversationId: 'conversation-empty',
        answer: '',
        citations: [],
        suggestions: [],
      }

      handlers?.onConversation?.({ conversationId: completion.conversationId })
      handlers?.onDone?.(completion)
      return completion
    })
    publicChatApiMock.getConversationDetail.mockResolvedValue({
      conversationId: 'conversation-empty',
      workspaceId: 'workspace-1',
      agentId: null,
      sourceChannel: 'website_embed',
      sourceOrigin: 'https://site.example',
      channelContext: null,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      messagesTotal: 1,
      messageWindowOffset: 0,
      messageWindowLimit: 50,
      hasOlderMessages: false,
      nextCursor: null,
      tailCursor: 'conversation-empty-cursor',
      messages: [],
    })

    const postedMessages: WebsiteEmbedAnalyticsMessage[] = []
    root = renderEmbeddedProvider({
      container,
      embedSessionId: 'embed-session-4',
      onPostedMessage: (message) => postedMessages.push(message),
    })

    await waitFor(() => {
      expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1)
      expect(publicChatApiMock.getConversationDetail).toHaveBeenCalledTimes(1)
      expect(postedMessages.filter((message) => message.type === WEBSITE_EMBED_ANALYTICS_MESSAGE)).toHaveLength(2)
    })

    expect(postedMessages.map((message) => message.event)).toEqual(['chat.started', 'chat.failed'])
    expect(postedMessages[1]).toEqual(expect.objectContaining({
      event: 'chat.failed',
      subjectId: 'conversation-empty',
      properties: expect.objectContaining({
        embedSessionId: 'embed-session-4',
        errorCode: 'empty_answer',
        hasAnswer: false,
        rateLimited: false,
        recovered: false,
      }),
    }))
  })

  it('emits chat started and failed once with the embed session id', async () => {
    publicChatApiMock.streamMessage.mockRejectedValue({
      error: {
        code: 'provider_unavailable',
        message: 'Provider unavailable.',
      },
    })

    const postedMessages: WebsiteEmbedAnalyticsMessage[] = []
    root = renderEmbeddedProvider({
      container,
      embedSessionId: 'embed-session-2',
      onPostedMessage: (message) => postedMessages.push(message),
    })

    await waitFor(() => {
      expect(publicChatApiMock.streamMessage).toHaveBeenCalledTimes(1)
      expect(postedMessages.filter((message) => message.type === WEBSITE_EMBED_ANALYTICS_MESSAGE)).toHaveLength(2)
    })

    expect(postedMessages.map((message) => message.event)).toEqual(['chat.started', 'chat.failed'])
    expect(postedMessages[0].properties).toEqual(expect.objectContaining({
      embedSessionId: 'embed-session-2',
      inputMethod: 'typed',
    }))
    expect(postedMessages[1]).toEqual(expect.objectContaining({
      event: 'chat.failed',
      properties: expect.objectContaining({
        embedSessionId: 'embed-session-2',
        errorCode: 'provider_unavailable',
        inputMethod: 'typed',
        rateLimited: false,
      }),
    }))
  })

  it('emits website embed loaded once for duplicate session messages', async () => {
    const parent = {
      postMessage: vi.fn(),
    }
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: parent,
    })

    root = createRoot(container)
    act(() => {
      root?.render(<EmbeddedChatFrame token="embed-token" />)
    })

    const sessionMessage = new MessageEvent('message', {
      data: {
        type: 'radioso:embed:session',
        session: {
          workspaceName: 'Acme',
          publicChatToken: 'public-chat-token',
          publicSessionId: 'embed-session-5',
          publicSessionToken: 'session-token',
          expiresAt: '2026-05-27T11:00:00.000Z',
          resumeToken: 'resume-token',
          resumeExpiresAt: '2026-06-27T11:00:00.000Z',
        },
      },
    })
    Object.defineProperty(sessionMessage, 'source', {
      value: parent,
    })

    act(() => {
      window.dispatchEvent(sessionMessage)
      window.dispatchEvent(sessionMessage)
    })

    await waitFor(() => {
      const analyticsMessages = parent.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message?.type === WEBSITE_EMBED_ANALYTICS_MESSAGE)
      expect(analyticsMessages).toHaveLength(1)
      expect(analyticsMessages[0]).toEqual(expect.objectContaining({
        event: 'website_embed.loaded',
        subjectId: 'embed-session-5',
      }))
    })

  })
})
