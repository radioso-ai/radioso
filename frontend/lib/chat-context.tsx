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
  chatApi,
  generalSettingsApi,
  type AnswerSegment,
  type Citation,
  type ChatSuggestion,
  type ChatStreamCompletion,
  type ChatUserInputMetadata,
  type RetrievalInfo,
  type RetrievalTrace,
} from '@/lib/api'
import { createClientId } from '@/lib/client-id'

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

interface ChatSession {
  conversationId?: string
  messages: ChatMessage[]
  isLoading: boolean
  isInitialized: boolean
  isBootstrapping: boolean
}

interface ChatContextValue {
  getSession: (workspaceId: string) => ChatSession
  initializeSession: (workspaceId: string, userExpectedLocale?: string) => Promise<void>
  sendMessage: (workspaceId: string, content: string, inputMetadata?: ChatUserInputMetadata) => Promise<boolean>
  startNewChat: (workspaceId: string, userExpectedLocale?: string) => Promise<void>
}

const EMPTY_SESSION: ChatSession = {
  messages: [],
  isLoading: false,
  isInitialized: false,
  isBootstrapping: false,
}

const ChatContext = createContext<ChatContextValue | null>(null)

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

const ensureSession = (
  sessions: Record<string, ChatSession>,
  accountId: string,
): ChatSession => sessions[accountId] ?? EMPTY_SESSION

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

const resolveBrowserLocale = (): string | undefined =>
  typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language : undefined

export function ChatProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Record<string, ChatSession>>({})

  const getSession = useCallback(
    (accountId: string) => ensureSession(sessions, accountId),
    [sessions],
  )

  const updateSession = useCallback(
    (
      accountId: string,
      updater: (session: ChatSession) => ChatSession,
    ) => {
      setSessions((currentSessions) => {
        const currentSession = ensureSession(currentSessions, accountId)
        return {
          ...currentSessions,
          [accountId]: updater(currentSession),
        }
      })
    },
    [],
  )

  const applyCompletion = useCallback(
    (accountId: string, assistantMessageId: string, completion: ChatStreamCompletion) => {
      updateSession(accountId, (session) => ({
        ...session,
        conversationId: completion.conversationId ?? session.conversationId,
        isLoading: false,
        messages: session.messages.map((message) =>
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
                status: 'complete',
              }
            : message,
        ),
      }))
    },
    [updateSession],
  )

  const sendMessage = useCallback(
    async (accountId: string, content: string, inputMetadata?: ChatUserInputMetadata) => {
      const query = content.trim()

      if (!query) {
        return false
      }

      const currentSession = ensureSession(sessions, accountId)
      const previousMessages = currentSession.messages

      if (currentSession.isLoading || currentSession.isBootstrapping) {
        return false
      }

      const userMessage: ChatMessage = {
        id: createClientId('chat-user'),
        role: 'user',
        content: query,
        createdAt: new Date().toISOString(),
        inputMetadata,
        status: 'complete',
      }

      const assistantMessageId = createClientId('chat-assistant')
      const assistantCreatedAt = new Date().toISOString()

      updateSession(accountId, (session) => ({
        ...session,
        isLoading: true,
        messages: [
          ...clearMessageSuggestions(session.messages),
          userMessage,
          {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            createdAt: assistantCreatedAt,
            status: 'streaming',
          },
        ],
      }))

      try {
        let didComplete = false

        const completion = await chatApi.streamChatResponse(
          {
            query,
            stream: true,
            conversationId: currentSession.conversationId,
            inputMetadata,
            userExpectedLocale: resolveBrowserLocale(),
          },
          {
            onConversation: ({ conversationId }) => {
              updateSession(accountId, (session) => ({
                ...session,
                conversationId,
              }))
            },
            onChunk: ({ text }) => {
              updateSession(accountId, (session) => ({
                ...session,
                messages: session.messages.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        content: `${message.content}${text}`,
                      }
                    : message,
                ),
              }))
            },
            onDone: (completion) => {
              didComplete = true
              applyCompletion(accountId, assistantMessageId, completion)
            },
            onSuggestions: ({ suggestions }) => {
              updateSession(accountId, (session) => ({
                ...session,
                messages: session.messages.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        suggestions,
                      }
                    : message,
                ),
              }))
            },
          },
        )

        if (!didComplete) {
          applyCompletion(accountId, assistantMessageId, {
            conversationId: completion.conversationId,
            answer: completion.answer,
            citations: completion.citations,
            answerSegments: completion.answerSegments,
            suggestions: completion.suggestions,
            retrievalInfo: completion.retrievalInfo,
            retrievalTrace: completion.retrievalTrace,
          })
        }

        return true
      } catch (error) {
        const errorMessage = getErrorMessage(error)

        updateSession(accountId, (session) => {
          const nextMessages = restoreMessageSuggestions(
            session.messages.map((message) => {
              if (message.id !== assistantMessageId) {
                return message
              }

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
          )

          return {
            ...session,
            isLoading: false,
            messages: nextMessages,
          }
        })

        return false
      }
    },
    [applyCompletion, sessions, updateSession],
  )

  const initializeSession = useCallback(
    async (accountId: string, userExpectedLocale?: string) => {
      const currentSession = ensureSession(sessions, accountId)
      if (
        currentSession.isInitialized ||
        currentSession.isLoading ||
        currentSession.isBootstrapping ||
        currentSession.messages.length > 0
      ) {
        return
      }

      updateSession(accountId, (session) => ({
        ...session,
        isBootstrapping: true,
      }))

      try {
        const settings = await generalSettingsApi.getGeneralSettings()
        if (!settings.assistantBootstrapActive) {
          updateSession(accountId, (session) => ({
            ...session,
            isInitialized: true,
          }))
          return
        }

        const bootstrap = await chatApi.bootstrapConversation({
          stream: false,
          bootstrapGreeting: true,
          userExpectedLocale,
        })

        if (!bootstrap?.answer) {
          updateSession(accountId, (session) => ({
            ...session,
            isInitialized: true,
          }))
          return
        }

        updateSession(accountId, (session) => ({
          ...(session.messages.length > 0 || session.conversationId
            ? {
                ...session,
                isInitialized: true,
              }
            : {
                ...session,
                ...(bootstrap.conversationId ? { conversationId: bootstrap.conversationId } : {}),
                messages: [
                  {
                    id: createClientId('chat-assistant'),
                    role: 'assistant',
                    content: bootstrap.answer,
                    createdAt: new Date().toISOString(),
                    citations: bootstrap.citations,
                    answerSegments: bootstrap.answerSegments,
                    suggestions: bootstrap.suggestions,
                    retrievalInfo: bootstrap.retrievalInfo,
                    retrievalTrace: bootstrap.retrievalTrace,
                    persistedAssistantMessageId: bootstrap.assistantMessageId,
                    status: 'complete' as const,
                  },
                ],
                isInitialized: true,
              }),
        }))
      } catch {
        // Silent-start fallback is intentional when bootstrap startup fails.
        updateSession(accountId, (session) => ({
          ...session,
          isInitialized: false,
        }))
      } finally {
        updateSession(accountId, (session) => ({
          ...session,
          isBootstrapping: false,
        }))
      }
    },
    [sessions, updateSession],
  )

  const startNewChat = useCallback(
    async (accountId: string, userExpectedLocale?: string) => {
      const currentSession = ensureSession(sessions, accountId)
      if (currentSession.isLoading || currentSession.isBootstrapping) {
        return
      }

      updateSession(accountId, () => ({
        ...EMPTY_SESSION,
        isBootstrapping: true,
      }))

      try {
        const settings = await generalSettingsApi.getGeneralSettings()
        if (!settings.assistantBootstrapActive) {
          updateSession(accountId, () => ({
            ...EMPTY_SESSION,
            isInitialized: true,
          }))
          return
        }

        const bootstrap = await chatApi.bootstrapConversation({
          stream: false,
          bootstrapGreeting: true,
          userExpectedLocale,
        })

        if (!bootstrap?.answer) {
          updateSession(accountId, () => ({
            ...EMPTY_SESSION,
            isInitialized: true,
          }))
          return
        }

        updateSession(accountId, () => ({
          ...(bootstrap.conversationId ? { conversationId: bootstrap.conversationId } : {}),
          messages: [
            {
              id: createClientId('chat-assistant'),
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
          ],
          isLoading: false,
          isInitialized: true,
          isBootstrapping: false,
        }))
      } catch {
        updateSession(accountId, () => ({
          ...EMPTY_SESSION,
        }))
      } finally {
        updateSession(accountId, (session) => ({
          ...session,
          isBootstrapping: false,
        }))
      }
    },
    [sessions, updateSession],
  )

  const value = useMemo<ChatContextValue>(
    () => ({
      getSession,
      initializeSession,
      sendMessage,
      startNewChat,
    }),
    [getSession, initializeSession, sendMessage, startNewChat],
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export const useChatSession = (workspaceId: string) => {
  const context = useContext(ChatContext)

  if (!context) {
    throw new Error('useChatSession must be used within a ChatProvider')
  }

  return {
    ...context.getSession(workspaceId),
    initializeSession: (userExpectedLocale?: string) =>
      context.initializeSession(workspaceId, userExpectedLocale),
    sendMessage: (content: string, inputMetadata?: ChatUserInputMetadata) => context.sendMessage(workspaceId, content, inputMetadata),
    startNewChat: (userExpectedLocale?: string) =>
      context.startNewChat(workspaceId, userExpectedLocale),
  }
}
