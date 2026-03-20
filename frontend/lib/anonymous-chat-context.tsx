'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import {
  publicChatApi,
  type AnswerSegment,
  type Citation,
  type ChatConversationDetail,
  type ChatStreamCompletion,
  type ErrorResponse,
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
  workspaceName: string | null
  isLoading: boolean
  isHydrating: boolean
  isUnavailable: boolean
  rateLimitError: string | null
  retryAfterSeconds: number | null
  sendMessage: (content: string) => Promise<void>
}

const AnonymousChatContext = createContext<AnonymousChatContextValue | null>(null)

const getErrorResponse = (error: unknown): ErrorResponse['error'] | null => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'code' in error.error &&
    typeof error.error.code === 'string' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error as ErrorResponse['error']
  }

  return null
}

const getErrorMessage = (error: unknown) => {
  const structuredError = getErrorResponse(error)
  if (structuredError) {
    return structuredError.message
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Sorry, something went wrong. Please try again.'
}

const isRateLimitError = (error: unknown): { message: string; retryAfterSeconds: number } | null => {
  const structuredError = getErrorResponse(error)
  if (structuredError?.code !== 'rate_limit_exceeded') {
    return null
  }

  return {
    message: structuredError.message,
    retryAfterSeconds: Number(structuredError.retryAfterSeconds ?? 60),
  }
}

const toChatMessages = (detail: ChatConversationDetail): ChatMessage[] =>
  detail.messages
    .filter((message): message is typeof message & { role: 'user' | 'assistant' } => message.role !== 'system')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      citations: message.citations,
      answerSegments: message.answerSegments,
      retrievalInfo: message.debug?.retrievalInfo,
      status: 'complete' as const,
    }))

const getLatestAssistantMessage = (detail: ChatConversationDetail): ChatMessage | null => {
  const assistantMessages = toChatMessages(detail).filter((message) => message.role === 'assistant')
  return assistantMessages.at(-1) ?? null
}

export function AnonymousChatProvider({
  token,
  children,
}: {
  token: string
  children: ReactNode
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [isHydrating, setIsHydrating] = useState(true)
  const [isUnavailable, setIsUnavailable] = useState(false)
  const [rateLimitError, setRateLimitError] = useState<string | null>(null)
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    const hydrateConversation = async () => {
      setIsHydrating(true)
      setIsUnavailable(false)
      setMessages([])
      setWorkspaceName(null)
      setConversationId(undefined)
      setRateLimitError(null)
      setRetryAfterSeconds(null)

      try {
        const response = await publicChatApi.listConversations(token)
        if (cancelled) return

        setWorkspaceName(response.workspaceName ?? null)

        if (response.conversations.length === 0) {
          setIsHydrating(false)
          return
        }

        const detail = await publicChatApi.getConversationDetail(token, response.conversations[0].id)
        if (cancelled) return

        setConversationId(detail.conversationId)
        setMessages(toChatMessages(detail))
      } catch (error) {
        if (cancelled) return
        const structuredError = getErrorResponse(error)
        if (structuredError?.code === 'not_found') {
          setIsUnavailable(true)
        }
      } finally {
        if (!cancelled) {
          setIsHydrating(false)
        }
      }
    }

    void hydrateConversation()

    return () => {
      cancelled = true
    }
  }, [token])

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

  const recoverAssistantMessage = useCallback(
    async (nextConversationId: string | undefined, assistantMessageId: string) => {
      if (!nextConversationId) {
        return false
      }

      const detail = await publicChatApi.getConversationDetail(token, nextConversationId)
      const assistantMessage = getLatestAssistantMessage(detail)
      if (!assistantMessage) {
        return false
      }

      setConversationId(detail.conversationId)
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: assistantMessage.content,
                citations: assistantMessage.citations,
                answerSegments: assistantMessage.answerSegments,
                retrievalInfo: assistantMessage.retrievalInfo,
                status: 'complete' as const,
              }
            : message,
        ),
      )
      setIsLoading(false)
      return true
    },
    [token],
  )

  const sendMessage = useCallback(
    async (content: string) => {
      const query = content.trim()
      if (!query || isLoading || isHydrating || isUnavailable) return

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

        const nextConversationId = completion.conversationId ?? conversationId
        const needsRecovery = !completion.answer?.trim()

        if (needsRecovery) {
          const recovered = await recoverAssistantMessage(nextConversationId, assistantMessageId)
          if (recovered) {
            return
          }
        }

        if (!didComplete) {
          applyCompletion(assistantMessageId, {
            conversationId: nextConversationId,
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
          setMessages((prev) => prev.filter((message) => message.id !== assistantMessageId && message.id !== userMessage.id))
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
    [applyCompletion, conversationId, isHydrating, isLoading, isUnavailable, recoverAssistantMessage, token],
  )

  const value = useMemo<AnonymousChatContextValue>(
    () => ({
      messages,
      workspaceName,
      isLoading,
      isHydrating,
      isUnavailable,
      rateLimitError,
      retryAfterSeconds,
      sendMessage,
    }),
    [messages, workspaceName, isLoading, isHydrating, isUnavailable, rateLimitError, retryAfterSeconds, sendMessage],
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
