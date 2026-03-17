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

interface ChatSession {
  conversationId?: string
  messages: ChatMessage[]
  isLoading: boolean
}

interface ChatContextValue {
  getSession: (workspaceId: string) => ChatSession
  sendMessage: (workspaceId: string, content: string) => Promise<void>
}

const EMPTY_SESSION: ChatSession = {
  messages: [],
  isLoading: false,
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
                content: completion.answer ?? message.content,
                citations: completion.citations,
                answerSegments: completion.answerSegments,
                retrievalInfo: completion.retrievalInfo,
                status: 'complete',
              }
            : message,
        ),
      }))
    },
    [updateSession],
  )

  const sendMessage = useCallback(
    async (accountId: string, content: string) => {
      const query = content.trim()

      if (!query) {
        return
      }

      const currentSession = ensureSession(sessions, accountId)

      if (currentSession.isLoading) {
        return
      }

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: query,
        status: 'complete',
      }

      const assistantMessageId = crypto.randomUUID()

      updateSession(accountId, (session) => ({
        ...session,
        isLoading: true,
        messages: [
          ...session.messages,
          userMessage,
          {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
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
          },
        )

        if (!didComplete) {
          applyCompletion(accountId, assistantMessageId, {
            conversationId: completion.conversationId,
            answer: completion.answer,
            citations: completion.citations,
            answerSegments: completion.answerSegments,
            retrievalInfo: completion.retrievalInfo,
          })
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error)

        updateSession(accountId, (session) => {
          const nextMessages = session.messages.map((message) => {
            if (message.id !== assistantMessageId) {
              return message
            }

            return {
              ...message,
              content: message.content || errorMessage,
              status: 'error' as const,
              citations: [] as Citation[],
              answerSegments: undefined,
            }
          })

          return {
            ...session,
            isLoading: false,
            messages: nextMessages,
          }
        })
      }
    },
    [applyCompletion, sessions, updateSession],
  )

  const value = useMemo<ChatContextValue>(
    () => ({
      getSession,
      sendMessage,
    }),
    [getSession, sendMessage],
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
    sendMessage: (content: string) => context.sendMessage(workspaceId, content),
  }
}
