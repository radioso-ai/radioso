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
import { createClientId } from '@/lib/client-id'
import {
  clearStoredAnonymousSession,
  publicChatApi,
  readStoredAnonymousSessionId,
  readStoredPublicSessionToken,
  type AnswerSegment,
  type Citation,
  type ChatSuggestion,
  type ChatConversationDetail,
  type ChatStreamCompletion,
  type ChatUserInputMetadata,
  type ErrorResponse,
  type RetrievalInfo,
  type RetrievalTrace,
  type WebsiteEmbedPageContext,
} from '@/lib/api'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  inputMetadata?: ChatUserInputMetadata
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  suggestions?: ChatSuggestion[]
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
  persistedAssistantMessageId?: string
  status: 'complete' | 'streaming' | 'error'
}

interface AnonymousChatContextValue {
  messages: ChatMessage[]
  conversationId?: string
  workspaceName: string | null
  publicSessionActions: Record<string, unknown>
  isLoading: boolean
  isHydrating: boolean
  isLoadingOlderMessages: boolean
  isUnavailable: boolean
  hasOlderMessages: boolean
  rateLimitError: string | null
  retryAfterSeconds: number | null
  loadOlderMessages: () => Promise<void>
  sendMessage: (content: string, inputMetadata?: ChatUserInputMetadata) => Promise<void>
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
      inputMetadata: message.inputMetadata,
      citations: message.citations,
      answerSegments: message.answerSegments,
      suggestions: message.suggestions,
      retrievalInfo: message.debug?.retrievalInfo,
      retrievalTrace: message.debug?.retrievalTrace,
      persistedAssistantMessageId: message.role === 'assistant' ? message.id : undefined,
      status: 'complete' as const,
    }))

const clearMessageSuggestions = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) =>
    message.suggestions && message.suggestions.length > 0
      ? {
          ...message,
          suggestions: undefined,
        }
      : message,
  )

const restoreMessageSuggestions = (
  messages: ChatMessage[],
  previousMessages: ChatMessage[],
): ChatMessage[] => {
  const suggestionsByMessageId = new Map(
    previousMessages
      .filter((message) => message.suggestions && message.suggestions.length > 0)
      .map((message) => [message.id, message.suggestions]),
  )

  return messages.map((message) =>
    suggestionsByMessageId.has(message.id)
      ? {
          ...message,
          suggestions: suggestionsByMessageId.get(message.id),
        }
      : message,
  )
}

const getLatestAssistantMessage = (detail: ChatConversationDetail): ChatMessage | null => {
  const assistantMessages = toChatMessages(detail).filter((message) => message.role === 'assistant')
  return assistantMessages.at(-1) ?? null
}

const INITIAL_MESSAGE_WINDOW_SIZE = 10
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
  pageContext,
}: {
  localeOverride?: string | null
  pageContext?: WebsiteEmbedPageContext | null
  browserLocales?: readonly string[]
}) => {
  if (isValidLocaleHint(localeOverride)) {
    return localeOverride.trim()
  }

  if (isValidLocaleHint(pageContext?.pageLocale)) {
    return pageContext.pageLocale.trim()
  }

  if (isValidLocaleHint(pageContext?.browserLocale)) {
    return pageContext.browserLocale.trim()
  }

  return undefined
}

export function AnonymousChatProvider({
  token,
  sessionChannel,
  initialActions,
  localeOverride,
  pageContext,
  children,
}: {
  token: string
  sessionChannel?: 'anonymous_link' | null
  initialActions?: Record<string, unknown> | null
  localeOverride?: string | null
  pageContext?: WebsiteEmbedPageContext | null
  children: ReactNode
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [publicSessionActions, setPublicSessionActions] = useState<Record<string, unknown>>(
    initialActions && typeof initialActions === 'object' && !Array.isArray(initialActions) ? initialActions : {},
  )
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [isHydrating, setIsHydrating] = useState(true)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  const [isUnavailable, setIsUnavailable] = useState(false)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [nextMessageCursor, setNextMessageCursor] = useState<string | null>(null)
  const [rateLimitError, setRateLimitError] = useState<string | null>(null)
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null)

  const createPublicLaunchSession = useCallback(
    async (input?: { resetSession?: boolean }) => {
      if (!sessionChannel) {
        return null
      }

      const session = await publicChatApi.createSession(token, {
        channel: sessionChannel,
        anonymousSessionId: input?.resetSession ? null : readStoredAnonymousSessionId(token),
        pageContext,
      })
      setPublicSessionActions(session.actions ?? {})
      return session
    },
    [pageContext, sessionChannel, token],
  )

  const ensurePublicLaunchSession = useCallback(async () => {
    if (!sessionChannel || readStoredPublicSessionToken(token)) {
      return
    }

    await createPublicLaunchSession()
  }, [createPublicLaunchSession, sessionChannel, token])

  const withPublicSessionRetry = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      await ensurePublicLaunchSession()

      try {
        return await operation()
      } catch (error) {
        if (sessionChannel && getErrorResponse(error)?.code === 'not_found') {
          clearStoredAnonymousSession(token)
          await createPublicLaunchSession({ resetSession: true })
          return operation()
        }

        throw error
      }
    },
    [createPublicLaunchSession, ensurePublicLaunchSession, sessionChannel, token],
  )

  const hydrateConversation = useCallback(async () => {
    setIsHydrating(true)
    setIsUnavailable(false)
    setMessages([])
    setWorkspaceName(null)
    setPublicSessionActions(
      initialActions && typeof initialActions === 'object' && !Array.isArray(initialActions) ? initialActions : {},
    )
    setConversationId(undefined)
    setHasOlderMessages(false)
    setNextMessageCursor(null)
    setRateLimitError(null)
    setRetryAfterSeconds(null)

    try {
      await createPublicLaunchSession()

      const response = await withPublicSessionRetry(() => publicChatApi.listConversations(token, { limit: 1 }))
      setWorkspaceName(response.workspaceName ?? null)

      if (response.conversations.length === 0) {
        if (response.assistantBootstrapActive) {
          const bootstrap = await withPublicSessionRetry(() =>
            publicChatApi.bootstrapConversation(token, {
              stream: false,
              startConversation: true,
              userExpectedLocale: resolveAnonymousChatBootstrapLocale({
                localeOverride,
                pageContext,
                browserLocales:
                  typeof navigator !== 'undefined'
                    ? [navigator.languages?.[0] ?? navigator.language].filter((value): value is string => Boolean(value))
                    : [],
              }),
              pageContext,
            }),
          )

          if (bootstrap?.answer) {
            if (bootstrap.conversationId) {
              setConversationId(bootstrap.conversationId)
            }
            setMessages([
              {
                id: createClientId('public-chat-assistant'),
                role: 'assistant',
                content: bootstrap.answer,
                createdAt: new Date().toISOString(),
                citations: bootstrap.citations,
                answerSegments: bootstrap.answerSegments,
                retrievalInfo: bootstrap.retrievalInfo,
                retrievalTrace: bootstrap.retrievalTrace,
                persistedAssistantMessageId: bootstrap.assistantMessageId,
                status: 'complete',
              },
            ])
          }
        }
        return
      }

      const detail = await withPublicSessionRetry(() =>
        publicChatApi.getConversationDetail(token, response.conversations[0].id, {
          limit: INITIAL_MESSAGE_WINDOW_SIZE,
        }),
      )

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
  }, [createPublicLaunchSession, initialActions, localeOverride, pageContext, token, withPublicSessionRetry])

  useEffect(() => {
    let cancelled = false

    if (!cancelled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrates persisted public conversation state after mount/token changes.
      void hydrateConversation()
    }

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
                persistedAssistantMessageId: completion.assistantMessageId ?? message.persistedAssistantMessageId,
                content: completion.answer ?? message.content,
                citations: completion.citations,
                answerSegments: completion.answerSegments,
                suggestions: completion.suggestions,
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
                suggestions: assistantMessage.suggestions,
                retrievalInfo: assistantMessage.retrievalInfo,
                retrievalTrace: assistantMessage.retrievalTrace,
                persistedAssistantMessageId: assistantMessage.persistedAssistantMessageId ?? assistantMessage.id,
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
    async (content: string, inputMetadata?: ChatUserInputMetadata) => {
      const query = content.trim()
      if (!query || isLoading || isHydrating || isUnavailable) return
      const previousMessages = messages

      setRateLimitError(null)
      setRetryAfterSeconds(null)

      const userMessage: ChatMessage = {
        id: createClientId('public-chat-user'),
        role: 'user',
        content: query,
        createdAt: new Date().toISOString(),
        inputMetadata,
        status: 'complete',
      }

      const assistantMessageId = createClientId('public-chat-assistant')
      const assistantCreatedAt = new Date().toISOString()

      setIsLoading(true)
      setMessages((prev) => [
        ...clearMessageSuggestions(prev),
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

        const completion = await withPublicSessionRetry(() =>
          publicChatApi.streamMessage(
            token,
            {
              message: query,
              stream: true,
              conversationId,
              inputMetadata,
              userExpectedLocale: resolveAnonymousChatBootstrapLocale({
                localeOverride,
                pageContext,
              }),
              pageContext,
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
              onSuggestions: ({ suggestions }) => {
                setMessages((prev) =>
                  prev.map((message) =>
                    message.id === assistantMessageId
                      ? {
                          ...message,
                          suggestions,
                        }
                      : message,
                  ),
                )
              },
            },
          ),
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
            suggestions: completion.suggestions,
            retrievalInfo: completion.retrievalInfo,
          })
        }
      } catch (error) {
        const rateLimit = isRateLimitError(error)
        if (rateLimit) {
          setRateLimitError(rateLimit.message)
          setRetryAfterSeconds(rateLimit.retryAfterSeconds)
          setMessages((prev) =>
            restoreMessageSuggestions(
              prev.filter((message) => message.id !== assistantMessageId && message.id !== userMessage.id),
              previousMessages,
            ),
          )
          setIsLoading(false)
          return
        }

        if (getErrorResponse(error)?.code === 'not_found') {
          setIsUnavailable(true)
          setMessages(previousMessages)
          setIsLoading(false)
          return
        }

        const errorMessage = getErrorMessage(error)
        setMessages((prev) =>
          restoreMessageSuggestions(
            prev.map((message) => {
              if (message.id !== assistantMessageId) return message
              return {
                ...message,
                content: message.content || errorMessage,
                status: 'error' as const,
                citations: [] as Citation[],
                answerSegments: undefined,
                suggestions: undefined,
              }
            }),
            previousMessages,
          ),
        )
        setIsLoading(false)
      }
    },
    [applyCompletion, conversationId, isHydrating, isLoading, isUnavailable, localeOverride, messages, pageContext, recoverAssistantMessage, token, withPublicSessionRetry],
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
      conversationId,
      workspaceName,
      publicSessionActions,
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
      conversationId,
      workspaceName,
      publicSessionActions,
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
