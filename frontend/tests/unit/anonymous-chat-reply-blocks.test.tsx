/* @vitest-environment jsdom */

import { useEffect, useRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnonymousChatProvider, type ChatMessage, useAnonymousChat } from '@/lib/anonymous-chat-context'
import { publicChatApi } from '@/lib/api'
import type { ChatConversationDetail, ClientContextCapabilities, ReplyBlock } from '@/lib/api'

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
  workspaceName: 'Guest house',
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

const gallery: ReplyBlock = {
  type: 'item_list',
  id: 'block-1',
  layout: 'grid',
  selection: 'none',
  caption: 'Rooms at the guest house',
  items: [{
    key: 'image-1',
    title: 'Garden room',
    image: {
      src: 'https://app.example/backend/api/v1/public/reply-images/image-1/640',
      alt: 'A bright room opening onto the garden',
      width: 640,
      height: 480,
    },
    actions: [{ type: 'open', url: 'https://stay.example/rooms/garden' }],
  }],
}

const historyDetail = (): ChatConversationDetail => ({
  conversationId: 'conversation-1',
  workspaceId: 'workspace-1',
  agentId: null,
  sourceChannel: 'website_embed',
  callerKind: 'human',
  sourceOrigin: 'https://stay.example',
  channelContext: null,
  title: null,
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
  messages: [{
    id: 'assistant-1',
    role: 'assistant',
    source: 'ai_agent',
    content: 'Here are the rooms.',
    createdAt: '2026-06-01T10:00:00.000Z',
    blocks: [gallery],
  }],
})

const pageRead: ClientContextCapabilities['page.read'] = {
  available: true,
  mode: 'metadata',
  supportedOperations: ['metadata'],
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

function ChatProbe({ sendMessage, onMessages }: { sendMessage?: string; onMessages: (messages: ChatMessage[]) => void }) {
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

const renderProvider = ({ onMessages, sendMessage }: { onMessages: (messages: ChatMessage[]) => void; sendMessage?: string }) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <AnonymousChatProvider token="public-chat-token" sessionChannel={null} clientContextCapabilities={{ 'page.read': pageRead }}>
        <ChatProbe onMessages={onMessages} sendMessage={sendMessage} />
      </AnonymousChatProvider>,
    )
  })
  return { container, root }
}

const latestAssistant = (messages: ChatMessage[]) =>
  messages.filter((message) => message.role === 'assistant').at(-1)

describe('anonymous chat reply blocks', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null

  beforeEach(() => {
    mounted = null
    publicChatApiMock.listConversations.mockResolvedValue(conversationList)
    publicChatApiMock.bootstrapConversation.mockResolvedValue(undefined)
    publicChatApiMock.streamConversationEvents.mockImplementation(() => new Promise<void>(() => {}))
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

  it('declares the blocks it renders beside the host page capabilities, and shows the blocks a reply carries', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = { conversationId: 'conversation-1', assistantMessageId: 'assistant-1', answer: 'Here are the rooms.', blocks: [gallery] }
      handlers?.onConversation?.({ conversationId: 'conversation-1' })
      handlers?.onBlock?.({ conversationId: 'conversation-1', assistantMessageId: 'assistant-1', block: gallery, blocks: [gallery] })
      handlers?.onDone?.(completion)
      return completion
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({ sendMessage: 'What do the rooms look like?', onMessages: (messages) => { latestMessages = messages } })

    await waitFor(() => {
      expect(latestAssistant(latestMessages)).toMatchObject({ status: 'complete', blocks: [gallery] })
    })
    expect(publicChatApiMock.streamMessage.mock.calls[0][1].clientContextCapabilities).toEqual({
      'page.read': pageRead,
      'reply.blocks': { item_list: { layouts: ['carousel', 'grid'] } },
    })
  })

  it('drops streamed blocks when a teammate holds the conversation', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = {
        conversationId: 'conversation-1',
        answer: 'A teammate is joining.',
        ownership: { state: 'human_owned' as const, suppressed: true },
      }
      handlers?.onBlock?.({ block: gallery, blocks: [gallery] })
      handlers?.onDone?.(completion)
      return completion
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({ sendMessage: 'What do the rooms look like?', onMessages: (messages) => { latestMessages = messages } })

    await waitFor(() => {
      expect(latestAssistant(latestMessages)).toMatchObject({ status: 'complete', content: 'A teammate is joining.' })
    })
    expect(latestAssistant(latestMessages)?.blocks).toBeUndefined()
  })

  it('shows the blocks the stream has handed over before the reply completes', async () => {
    const revised = { ...gallery, caption: 'Rooms with a garden view' }
    const map: ReplyBlock = { ...gallery, id: 'block-2', layout: 'carousel', caption: 'How to find us' }
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      handlers?.onConversation?.({ conversationId: 'conversation-1' })
      handlers?.onChunk?.({ text: 'Here are the rooms.' })
      handlers?.onBlock?.({ block: revised, blocks: [revised, map] })
      return new Promise(() => {})
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({ sendMessage: 'What do the rooms look like?', onMessages: (messages) => { latestMessages = messages } })

    await waitFor(() => {
      expect(latestAssistant(latestMessages)?.blocks).toEqual([revised, map])
    })
    expect(latestAssistant(latestMessages)?.status).not.toBe('complete')
  })

  it('shows the blocks the done event carries when the stream sent none before it', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      const completion = { conversationId: 'conversation-1', assistantMessageId: 'assistant-1', answer: 'Here are the rooms.', blocks: [gallery] }
      handlers?.onConversation?.({ conversationId: 'conversation-1' })
      handlers?.onChunk?.({ text: 'Here are the rooms.' })
      handlers?.onDone?.(completion)
      return completion
    })

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({ sendMessage: 'What do the rooms look like?', onMessages: (messages) => { latestMessages = messages } })

    await waitFor(() => {
      expect(latestAssistant(latestMessages)).toMatchObject({ status: 'complete', blocks: [gallery] })
    })
  })

  it('shows the blocks of a reply it recovers from history when the stream ends without an answer', async () => {
    publicChatApiMock.streamMessage.mockImplementation(async (_token, _data, handlers) => {
      handlers?.onConversation?.({ conversationId: 'conversation-1' })
      return { conversationId: 'conversation-1', answer: '' }
    })
    publicChatApiMock.getConversationDetail.mockResolvedValue(historyDetail())

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({ sendMessage: 'What do the rooms look like?', onMessages: (messages) => { latestMessages = messages } })

    await waitFor(() => {
      expect(latestAssistant(latestMessages)).toMatchObject({ status: 'complete', content: 'Here are the rooms.', blocks: [gallery] })
    })
  })

  it('keeps the blocks of a reply read back from history', async () => {
    publicChatApiMock.listConversations.mockResolvedValue({
      ...conversationList,
      conversations: [{
        id: 'conversation-1',
        agentId: null,
        agentName: null,
        agentInternalName: null,
        sourceChannel: 'website_embed',
        callerKind: 'human',
        sourceOrigin: 'https://stay.example',
        channelContext: null,
        anonymousSessionId: null,
        entryPageUrl: null,
        visitorCountry: null,
        title: null,
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:00:00.000Z',
        messageCount: 1,
        userMessageCount: 0,
        assistantMessageCount: 1,
        preview: 'Here are the rooms.',
      }],
    })
    publicChatApiMock.getConversationDetail.mockResolvedValue(historyDetail())

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({ onMessages: (messages) => { latestMessages = messages } })

    await waitFor(() => {
      expect(latestAssistant(latestMessages)?.blocks).toEqual([gallery])
    })
  })
})
