/* @vitest-environment jsdom */

import { useEffect, useRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatProvider, type ChatMessage, useChatSession } from '@/lib/chat-context'
import { chatApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  chatApi: {
    streamChatResponse: vi.fn(),
    bootstrapConversation: vi.fn(),
  },
  agentsApi: {},
  generalSettingsApi: {},
}))

const chatApiMock = vi.mocked(chatApi)

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

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

const WORKSPACE_ID = 'workspace-1'

function ChatProbe({
  sendMessage,
  onMessages,
}: {
  sendMessage?: string
  onMessages: (messages: ChatMessage[]) => void
}) {
  const chat = useChatSession(WORKSPACE_ID)
  const didSendRef = useRef(false)

  useEffect(() => {
    onMessages(chat.messages)
  }, [chat.messages, onMessages])

  useEffect(() => {
    if (!sendMessage || didSendRef.current) {
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
      <ChatProvider>
        <ChatProbe onMessages={onMessages} sendMessage={sendMessage} />
      </ChatProvider>,
    )
  })

  return { container, root }
}

describe('workspace chat HITL suppression', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null

  beforeEach(() => {
    mounted = null
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

  const mockSuppressedCompletion = (answer: string) => {
    chatApiMock.streamChatResponse.mockImplementation(async (_data, handlers) => {
      const completion = {
        conversationId: 'conversation-1',
        agentId: undefined,
        agentName: undefined,
        assistantMessageId: '',
        answer,
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
  }

  it('renders the localized waiting message when HITL suppresses AI output', async () => {
    mockSuppressedCompletion('Un compañero se está uniendo, por favor espera.')

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({
      sendMessage: 'thank you',
      onMessages: (messages) => {
        latestMessages = messages
      },
    })

    await waitFor(() => {
      expect(chatApiMock.streamChatResponse).toHaveBeenCalledTimes(1)
      expect(latestMessages.map((message) => message.content)).toEqual([
        'thank you',
        'Un compañero se está uniendo, por favor espera.',
      ])
    })

    const assistant = latestMessages.find((message) => message.role === 'assistant')
    expect(assistant?.status).toBe('complete')
  })

  it('drops the placeholder bubble when the suppressed turn has no waiting message', async () => {
    mockSuppressedCompletion('')

    let latestMessages: ChatMessage[] = []
    mounted = renderProvider({
      sendMessage: 'thank you',
      onMessages: (messages) => {
        latestMessages = messages
      },
    })

    await waitFor(() => {
      expect(chatApiMock.streamChatResponse).toHaveBeenCalledTimes(1)
      expect(latestMessages.map((message) => message.content)).toEqual(['thank you'])
    })

    expect(latestMessages.some((message) => message.role === 'assistant')).toBe(false)
  })
})
