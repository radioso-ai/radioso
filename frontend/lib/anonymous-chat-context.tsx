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

import { normalizeWebsiteEmbedLocale } from '@/lib/embed-widget'
import {
  clearStoredAnonymousSession,
  publicChatApi,
  type AnswerSegment,
  type Citation,
  type ChatConversationDetail,
  type ChatStreamCompletion,
  type ErrorResponse,
  type RetrievalInfo,
  type RetrievalTrace,
} from '@/lib/api'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
  status: 'complete' | 'streaming' | 'error'
}

interface AnonymousChatContextValue {
  messages: ChatMessage[]
  workspaceName: string | null
  isLoading: boolean
  isHydrating: boolean
  isLoadingOlderMessages: boolean
  isUnavailable: boolean
  hasOlderMessages: boolean
  rateLimitError: string | null
  retryAfterSeconds: number | null
  loadOlderMessages: () => Promise<void>
  sendMessage: (content: string) => Promise<void>
  startNewChat: () => Promise<void>
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
      createdAt: message.createdAt,
      citations: message.citations,
      answerSegments: message.answerSegments,
      retrievalInfo: message.debug?.retrievalInfo,
      retrievalTrace: message.debug?.retrievalTrace,
      status: 'complete' as const,
    }))

const getLatestAssistantMessage = (detail: ChatConversationDetail): ChatMessage | null => {
  const assistantMessages = toChatMessages(detail).filter((message) => message.role === 'assistant')
  return assistantMessages.at(-1) ?? null
}

const MESSAGE_WINDOW_SIZE = 50
const isValidLocaleHint = (value: string | null | undefined): value is string => {
  if (!value) {
    return false
  }

  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 35 && normalizeWebsiteEmbedLocale(trimmed) !== null
}

export const resolveAnonymousChatBootstrapLocale = ({
  localeOverride,
  browserLocales,
}: {
  localeOverride?: string | null
  browserLocales?: readonly string[]
}) => {
  if (isValidLocaleHint(localeOverride)) {
    return localeOverride.trim()
  }

  for (const locale of browserLocales ?? []) {
    if (isValidLocaleHint(locale)) {
      return locale.trim()
    }
  }

  return undefined
}

export function AnonymousChatProvider({
  token,
  localeOverride,
  children,
}: {
  token: string
  localeOverride?: string | null
  children: ReactNode
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [isHydrating, setIsHydrating] = useState(true)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  const [isUnavailable, setIsUnavailable] = useState(false)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [nextMessageCursor, setNextMessageCursor] = useState<string | null>(null)
  const [rateLimitError, setRateLimitError] = useState<string | null>(null)
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null)

  const hydrateConversation = useCallback(async () => {
    setIsHydrating(true)
    setIsUnavailable(false)
    setMessages([])
    setWorkspaceName(null)
    setConversationId(undefined)
    setHasOlderMessages(false)
    setNextMessageCursor(null)
    setRateLimitError(null)
    setRetryAfterSeconds(null)

    try {
      const response = await publicChatApi.listConversations(token, { limit: 1 })
      setWorkspaceName(response.workspaceName ?? null)

      if (response.conversations.length === 0) {
        if (response.assistantBootstrapActive) {
          const bootstrap = await publicChatApi.bootstrapConversation(token, {
            stream: false,
            bootstrapGreeting: true,
            userExpectedLocale: resolveAnonymousChatBootstrapLocale({
              localeOverride,
              browserLocales:
                typeof navigator !== 'undefined'
                  ? [navigator.languages?.[0] ?? navigator.language].filter((value): value is string => Boolean(value))
                  : [],
            }),
          })

          if (bootstrap?.answer) {
            setConversationId(bootstrap.conversationId)
            setMessages([
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: bootstrap.answer,
                createdAt: new Date().toISOString(),
                citations: bootstrap.citations,
                answerSegments: bootstrap.answerSegments,
                retrievalInfo: bootstrap.retrievalInfo,
                retrievalTrace: bootstrap.retrievalTrace,
                status: 'complete',
              },
            ])
          }
        }
        return
      }

      const detail = await publicChatApi.getConversationDetail(token, response.conversations[0].id, {
        limit: MESSAGE_WINDOW_SIZE,
      })

      setConversationId(detail.conversationId)
      setMessages(toChatMessages(detail))
      setHasOlderMessages(detail.hasOlderMessages)
      setNextMessageCursor(detail.nextCursor)
    } catch (error) {
      const structuredError = getErrorResponse(error)
      if (structuredError?.code === 'not_found') {
        setIsUnavailable(true)
      }
    } finally {
      setIsHydrating(false)
    }
  }, [localeOverride, token])

  useEffect(() => {
    let cancelled = false

    void hydrateConversation().then(() => {
      if (cancelled) {
        return
      }
    })

    return () => {
      cancelled = true
    }
  }, [hydrateConversation])

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
                retrievalTrace: completion.retrievalTrace,
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

      const detail = await publicChatApi.getConversationDetail(token, nextConversationId, {
        limit: MESSAGE_WINDOW_SIZE,
      })
      const assistantMessage = getLatestAssistantMessage(detail)
      if (!assistantMessage) {
        return false
      }

      setConversationId(detail.conversationId)
      setHasOlderMessages(detail.hasOlderMessages)
      setNextMessageCursor(detail.nextCursor)
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: assistantMessage.content,
                citations: assistantMessage.citations,
                answerSegments: assistantMessage.answerSegments,
                retrievalInfo: assistantMessage.retrievalInfo,
                retrievalTrace: assistantMessage.retrievalTrace,
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
        createdAt: new Date().toISOString(),
        status: 'complete',
      }

      const assistantMessageId = crypto.randomUUID()
      const assistantCreatedAt = new Date().toISOString()

      setIsLoading(true)
      setMessages((prev) => [
        ...prev,
        userMessage,
        {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          createdAt: assistantCreatedAt,
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

  const loadOlderMessages = useCallback(async () => {
    if (!conversationId || isLoadingOlderMessages || !hasOlderMessages || !nextMessageCursor) {
      return
    }

    setIsLoadingOlderMessages(true)

    try {
      const detail = await publicChatApi.getConversationDetail(token, conversationId, {
        limit: MESSAGE_WINDOW_SIZE,
        cursor: nextMessageCursor,
      })
      const olderMessages = toChatMessages(detail)
      setMessages((current) => {
        const seen = new Set(current.map((message) => message.id))
        const nextOlder = olderMessages.filter((message) => !seen.has(message.id))
        return [...nextOlder, ...current]
      })
      setHasOlderMessages(detail.hasOlderMessages)
      setNextMessageCursor(detail.nextCursor)
    } finally {
      setIsLoadingOlderMessages(false)
    }
  }, [conversationId, hasOlderMessages, isLoadingOlderMessages, nextMessageCursor, token])

  const startNewChat = useCallback(async () => {
    if (isLoading || isHydrating || isLoadingOlderMessages) {
      return
    }

    clearStoredAnonymousSession(token)
    await hydrateConversation()
  }, [hydrateConversation, isHydrating, isLoading, isLoadingOlderMessages, token])

  const value = useMemo<AnonymousChatContextValue>(
    () => ({
      messages,
      workspaceName,
      isLoading,
      isHydrating,
      isLoadingOlderMessages,
      isUnavailable,
      hasOlderMessages,
      rateLimitError,
      retryAfterSeconds,
      loadOlderMessages,
      sendMessage,
      startNewChat,
    }),
    [
      messages,
      workspaceName,
      isLoading,
      isHydrating,
      isLoadingOlderMessages,
      isUnavailable,
      hasOlderMessages,
      rateLimitError,
      retryAfterSeconds,
      loadOlderMessages,
      sendMessage,
      startNewChat,
    ],
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
