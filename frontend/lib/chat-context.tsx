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
  agentsApi,
  generalSettingsApi,
  type AnswerFeedbackState,
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
  answerFeedback?: AnswerFeedbackState
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
  persistedAssistantMessageId?: string
  status: 'complete' | 'streaming' | 'error'
}

interface ChatSession {
  agentId?: string
  conversationId?: string
  messages: ChatMessage[]
  isLoading: boolean
  isInitialized: boolean
  isBootstrapping: boolean
}

interface ChatContextValue {
  getSession: (workspaceId: string, agentId?: string) => ChatSession
  initializeSession: (workspaceId: string, userExpectedLocale?: string, agentId?: string) => Promise<void>
  sendMessage: (workspaceId: string, content: string, inputMetadata?: ChatUserInputMetadata, agentId?: string) => Promise<boolean>
  startNewChat: (workspaceId: string, userExpectedLocale?: string, agentId?: string) => Promise<void>
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
  agentId?: string,
): ChatSession => {
  const session = sessions[accountId]
  if (!session) {
    return EMPTY_SESSION
  }
  if (agentId && session.agentId !== agentId) {
    return EMPTY_SESSION
  }
  return session
}

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

const getAssistantBootstrapActive = async (agentId?: string) => {
  if (agentId) {
    return (await agentsApi.getAgent(agentId)).assistantBootstrapActive
  }
  return (await generalSettingsApi.getGeneralSettings()).assistantBootstrapActive
}

class AgentMismatchError extends Error {}

const assertSelectedAgentCompletion = (
  selectedAgentId: string | undefined,
  completionAgentId: string | undefined,
) => {
  if (selectedAgentId && completionAgentId && selectedAgentId !== completionAgentId) {
    throw new AgentMismatchError(
      'The response came from a different agent. Please start a new chat for the selected agent.',
    )
  }
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Record<string, ChatSession>>({})

  const getSession = useCallback(
    (accountId: string, agentId?: string) => ensureSession(sessions, accountId, agentId),
    [sessions],
  )

  const updateSession = useCallback(
    (
      accountId: string,
      agentId: string | undefined,
      updater: (session: ChatSession) => ChatSession,
    ) => {
      setSessions((currentSessions) => {
        const currentSession = ensureSession(currentSessions, accountId, agentId)
        return {
          ...currentSessions,
          [accountId]: {
            ...updater(currentSession),
            ...(agentId ? { agentId } : {}),
          },
        }
      })
    },
    [],
  )

  const applyCompletion = useCallback(
    (accountId: string, agentId: string | undefined, assistantMessageId: string, completion: ChatStreamCompletion) => {
      updateSession(accountId, agentId, (session) => ({
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
    async (accountId: string, content: string, inputMetadata?: ChatUserInputMetadata, agentId?: string) => {
      const query = content.trim()

      if (!query) {
        return false
      }

      const currentSession = ensureSession(sessions, accountId, agentId)
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

      updateSession(accountId, agentId, (session) => ({
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
            agentId,
            stream: true,
            conversationId: currentSession.conversationId,
            inputMetadata,
            userExpectedLocale: resolveBrowserLocale(),
          },
          {
            onConversation: ({ conversationId }) => {
              updateSession(accountId, agentId, (session) => ({
                ...session,
                conversationId,
              }))
            },
            onChunk: ({ text }) => {
              updateSession(accountId, agentId, (session) => ({
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
              assertSelectedAgentCompletion(agentId, completion.agentId)
              didComplete = true
              applyCompletion(accountId, agentId, assistantMessageId, completion)
            },
            onSuggestions: ({ suggestions }) => {
              updateSession(accountId, agentId, (session) => ({
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
          assertSelectedAgentCompletion(agentId, completion.agentId)
          applyCompletion(accountId, agentId, assistantMessageId, {
            conversationId: completion.conversationId,
            agentId: completion.agentId,
            agentName: completion.agentName,
            route: completion.route,
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
        const replaceAssistantContent = error instanceof AgentMismatchError

        updateSession(accountId, agentId, (session) => {
          const nextMessages = restoreMessageSuggestions(
            session.messages.map((message) => {
              if (message.id !== assistantMessageId) {
                return message
              }

              return {
                ...message,
                content: replaceAssistantContent ? errorMessage : message.content || errorMessage,
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
    async (accountId: string, userExpectedLocale?: string, agentId?: string) => {
      const currentSession = ensureSession(sessions, accountId, agentId)
      if (
        currentSession.isInitialized ||
        currentSession.isLoading ||
        currentSession.isBootstrapping ||
        currentSession.messages.length > 0
      ) {
        return
      }

      updateSession(accountId, agentId, (session) => ({
        ...session,
        isBootstrapping: true,
      }))

      try {
        if (!await getAssistantBootstrapActive(agentId)) {
          updateSession(accountId, agentId, (session) => ({
            ...session,
            isInitialized: true,
          }))
          return
        }

        const bootstrap = await chatApi.bootstrapConversation({
          stream: false,
          agentId,
          bootstrapGreeting: true,
          userExpectedLocale,
        })

        if (!bootstrap?.answer) {
          updateSession(accountId, agentId, (session) => ({
            ...session,
            isInitialized: true,
          }))
          return
        }

        updateSession(accountId, agentId, (session) => ({
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
        updateSession(accountId, agentId, (session) => ({
          ...session,
          isInitialized: false,
        }))
      } finally {
        updateSession(accountId, agentId, (session) => ({
          ...session,
          isBootstrapping: false,
        }))
      }
    },
    [sessions, updateSession],
  )

  const startNewChat = useCallback(
    async (accountId: string, userExpectedLocale?: string, agentId?: string) => {
      const currentSession = ensureSession(sessions, accountId, agentId)
      if (currentSession.isLoading || currentSession.isBootstrapping) {
        return
      }

      updateSession(accountId, agentId, () => ({
        ...EMPTY_SESSION,
        isBootstrapping: true,
      }))

      try {
        if (!await getAssistantBootstrapActive(agentId)) {
          updateSession(accountId, agentId, () => ({
            ...EMPTY_SESSION,
            isInitialized: true,
          }))
          return
        }

        const bootstrap = await chatApi.bootstrapConversation({
          stream: false,
          agentId,
          bootstrapGreeting: true,
          userExpectedLocale,
        })

        if (!bootstrap?.answer) {
          updateSession(accountId, agentId, () => ({
            ...EMPTY_SESSION,
            isInitialized: true,
          }))
          return
        }

        updateSession(accountId, agentId, () => ({
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
        updateSession(accountId, agentId, () => ({
          ...EMPTY_SESSION,
        }))
      } finally {
        updateSession(accountId, agentId, (session) => ({
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

export const useChatSession = (workspaceId: string, agentId?: string) => {
  const context = useContext(ChatContext)

  if (!context) {
    throw new Error('useChatSession must be used within a ChatProvider')
  }

  return {
    ...context.getSession(workspaceId, agentId),
    initializeSession: (userExpectedLocale?: string) =>
      context.initializeSession(workspaceId, userExpectedLocale, agentId),
    sendMessage: (content: string, inputMetadata?: ChatUserInputMetadata) => context.sendMessage(workspaceId, content, inputMetadata, agentId),
    startNewChat: (userExpectedLocale?: string) =>
      context.startNewChat(workspaceId, userExpectedLocale, agentId),
  }
}
