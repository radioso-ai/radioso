'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import {
  publicChatApi,
  type AnswerSegment,
  type Citation,
  type ChatStreamCompletion,
  type RetrievalInfo,
} from '@/lib/api'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  retrievalInfo?: RetrievalInfo
  status: 'complete' | 'streaming' | 'error'
}

interface AnonymousChatContextValue {
  messages: ChatMessage[]
  isLoading: boolean
  rateLimitError: string | null
  retryAfterSeconds: number | null
  sendMessage: (content: string) => Promise<void>
}

const AnonymousChatContext = createContext<AnonymousChatContextValue | null>(null)

const getErrorMessage = (error: unknown) => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error.message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Sorry, something went wrong. Please try again.'
}

const isRateLimitError = (error: unknown): { message: string; retryAfterSeconds: number } | null => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'code' in error.error &&
    error.error.code === 'rate_limit_exceeded' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    const retryAfter = 'retryAfterSeconds' in error.error
      ? Number(error.error.retryAfterSeconds)
      : 60
    return { message: error.error.message, retryAfterSeconds: retryAfter }
  }
  return null
}

export function AnonymousChatProvider({
  token,
  children,
}: {
  token: string
  children: ReactNode
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [rateLimitError, setRateLimitError] = useState<string | null>(null)
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null)

  const applyCompletion = useCallback(
    (assistantMessageId: string, completion: ChatStreamCompletion) => {
      if (completion.conversationId) {
        setConversationId(completion.conversationId)
      }
      setIsLoading(false)
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: completion.answer ?? message.content,
                citations: completion.citations,
                answerSegments: completion.answerSegments,
                retrievalInfo: completion.retrievalInfo,
                status: 'complete' as const,
              }
            : message,
        ),
      )
    },
    [],
  )

  const sendMessage = useCallback(
    async (content: string) => {
      const query = content.trim()
      if (!query || isLoading) return

      setRateLimitError(null)
      setRetryAfterSeconds(null)

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: query,
        status: 'complete',
      }

      const assistantMessageId = crypto.randomUUID()

      setIsLoading(true)
      setMessages((prev) => [
        ...prev,
        userMessage,
        {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          status: 'streaming',
        },
      ])

      try {
        let didComplete = false

        const completion = await publicChatApi.streamMessage(
          token,
          {
            query,
            stream: true,
            conversationId,
          },
          {
            onConversation: ({ conversationId: newId }) => {
              setConversationId(newId)
            },
            onChunk: ({ text }) => {
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === assistantMessageId
                    ? { ...message, content: `${message.content}${text}` }
                    : message,
                ),
              )
            },
            onDone: (completion) => {
              didComplete = true
              applyCompletion(assistantMessageId, completion)
            },
          },
        )

        if (!didComplete) {
          applyCompletion(assistantMessageId, {
            conversationId: completion.conversationId,
            answer: completion.answer,
            citations: completion.citations,
            answerSegments: completion.answerSegments,
            retrievalInfo: completion.retrievalInfo,
          })
        }
      } catch (error) {
        const rateLimit = isRateLimitError(error)
        if (rateLimit) {
          setRateLimitError(rateLimit.message)
          setRetryAfterSeconds(rateLimit.retryAfterSeconds)
          // Remove the empty assistant message
          setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId))
          // Also remove the user message since it wasn't processed
          setMessages((prev) => prev.filter((m) => m.id !== userMessage.id))
          setIsLoading(false)
          return
        }

        const errorMessage = getErrorMessage(error)
        setMessages((prev) =>
          prev.map((message) => {
            if (message.id !== assistantMessageId) return message
            return {
              ...message,
              content: message.content || errorMessage,
              status: 'error' as const,
              citations: [] as Citation[],
              answerSegments: undefined,
            }
          }),
        )
        setIsLoading(false)
      }
    },
    [applyCompletion, conversationId, isLoading, token],
  )

  const value = useMemo<AnonymousChatContextValue>(
    () => ({
      messages,
      isLoading,
      rateLimitError,
      retryAfterSeconds,
      sendMessage,
    }),
    [messages, isLoading, rateLimitError, retryAfterSeconds, sendMessage],
  )

  return (
    <AnonymousChatContext.Provider value={value}>
      {children}
    </AnonymousChatContext.Provider>
  )
}

export const useAnonymousChat = () => {
  const context = useContext(AnonymousChatContext)

  if (!context) {
    throw new Error('useAnonymousChat must be used within an AnonymousChatProvider')
  }

  return context
}
