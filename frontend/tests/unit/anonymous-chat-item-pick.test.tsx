/* @vitest-environment jsdom */

import { useEffect, useRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnonymousChatProvider, type ChatMessage, useAnonymousChat } from '@/lib/anonymous-chat-context'
import { publicChatApi } from '@/lib/api'
import type { ChatConversationDetail, ReplyBlock } from '@/lib/api'
import { itemPickMessage, replyPicks } from '@/lib/reply-blocks'

// A pick the server refuses (#1763) leaves the reply's cards as they were: the turn the chat drew
// for it goes, so the cards can be picked again, and when another card of that reply was picked
// already, the chat reads history again so it shows the server's pick.

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

const api = vi.mocked(publicChatApi)

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const tours: ReplyBlock = {
  type: 'item_list',
  id: 'b1',
  layout: 'carousel',
  selection: 'single',
  caption: 'Boat tours',
  items: ['Harbour Sunrise', 'Lighthouse Loop'].map((title, index) => ({
    key: `image-${index + 1}`,
    title,
    actions: [{ type: 'select' as const }],
  })),
}

const conversationList = {
  workspaceName: 'Harbour Tours',
  assistantAvatarUrl: null,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  theme: { brand: '#0f172a', brandText: '#f8fafc', surface: '#ffffff', text: '#0f172a' },
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  intakeActions: [],
  assistantBootstrapActive: false,
  conversations: [{
    id: 'conversation-1', agentId: null, agentName: null, agentInternalName: null, sourceChannel: 'website_embed',
    callerKind: 'human' as const, sourceOrigin: null, channelContext: null, anonymousSessionId: null, entryPageUrl: null,
    visitorCountry: null, title: null, createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z',
    messageCount: 1, userMessageCount: 0, assistantMessageCount: 1, preview: 'Two tours leave at dawn.',
  }],
  total: 1,
  nextCursor: null,
  hasMore: false,
}

const historyDetail = (messages: ChatConversationDetail['messages']): ChatConversationDetail => ({
  conversationId: 'conversation-1', workspaceId: 'workspace-1', agentId: null, sourceChannel: 'website_embed',
  callerKind: 'human', sourceOrigin: null, channelContext: null, title: null,
  createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z',
  messageCount: messages.length, userMessageCount: 0, assistantMessageCount: 1, messagesTotal: messages.length,
  messageWindowOffset: 0, messageWindowLimit: 10, hasOlderMessages: false, nextCursor: null, tailCursor: 'cursor', messages,
})

const cardsReply = {
  id: 'assistant-1', role: 'assistant' as const, source: 'ai_agent' as const, content: 'Two tours leave at dawn.',
  createdAt: '2026-11-13T10:00:00.000Z', blocks: [tours],
}
const pickOf = (itemKey: string) => ({ messageId: 'assistant-1', blockId: 'b1', itemKey })

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

/** Picks the second tour once the thread has loaded, as the Select button does. */
function PickProbe({ onMessages }: { onMessages: (messages: ChatMessage[]) => void }) {
  const chat = useAnonymousChat()
  const didPickRef = useRef(false)

  useEffect(() => {
    onMessages(chat.messages)
  }, [chat.messages, onMessages])

  useEffect(() => {
    if (chat.isHydrating || didPickRef.current || chat.messages.length === 0) return
    didPickRef.current = true
    void chat.sendMessage(...itemPickMessage(pickOf('image-2'), tours.items[1]))
  }, [chat])

  return null
}

describe('a pick the server refuses', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null
  let latest: ChatMessage[] = []

  const render = () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <AnonymousChatProvider token="public-chat-token" sessionChannel={null}>
          <PickProbe onMessages={(messages) => { latest = messages }} />
        </AnonymousChatProvider>,
      )
    })
    mounted = { container, root }
  }

  beforeEach(() => {
    latest = []
    api.listConversations.mockResolvedValue(conversationList)
    api.streamConversationEvents.mockImplementation(() => new Promise<void>(() => {}))
    api.tailConversation.mockResolvedValue({ messages: [], cursor: null })
  })

  afterEach(() => {
    if (mounted) {
      act(() => mounted?.root.unmount())
      mounted.container.remove()
      mounted = null
    }
    vi.clearAllMocks()
  })

  it('drops the turn of a card the server says the reply never showed, so the cards can be picked again', async () => {
    api.getConversationDetail.mockResolvedValue(historyDetail([cardsReply]))
    api.streamMessage.mockRejectedValue({ status: 400, error: { code: 'item_selection_invalid', message: 'No such card.' } })

    render()

    await waitFor(() => expect(api.streamMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(latest.map(({ id }) => id)).toEqual(['assistant-1']))
    expect(replyPicks(latest).size).toBe(0)
    expect(api.listConversations).toHaveBeenCalledTimes(1)
  })

  it('reads history again when another card of the reply was picked, and shows that pick', async () => {
    const serverPick = {
      id: 'user-2', role: 'user' as const, source: 'customer' as const, content: 'Harbour Sunrise',
      createdAt: '2026-11-13T10:01:00.000Z', inputMetadata: { method: 'item_select' as const, selection: pickOf('image-1') },
    }
    api.getConversationDetail
      .mockResolvedValueOnce(historyDetail([cardsReply]))
      .mockResolvedValue(historyDetail([cardsReply, serverPick]))
    api.streamMessage.mockRejectedValue({ status: 409, error: { code: 'item_already_selected', message: 'Already picked.' } })

    render()

    await waitFor(() => expect(replyPicks(latest).get('assistant-1')).toEqual({ blockId: 'b1', itemKey: 'image-1' }))
    expect(api.streamMessage).toHaveBeenCalledTimes(1)
    expect(latest.some((message) => message.status === 'error')).toBe(false)
  })
})
