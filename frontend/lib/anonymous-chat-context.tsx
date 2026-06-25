'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { normalizeWebsiteEmbedLocale, type WebsiteEmbedThemeOverrides } from '@/lib/embed-widget'
import { createClientId } from '@/lib/client-id'
import { contrastRatio, mixHex, mixHexRgba, pickForeground, relativeLuminance } from '@/lib/color'
import { consumePublicChatSessionHandoffHash } from '@/lib/public-chat-session-handoff'

const MIN_LEGIBLE_CONTRAST = 3
const ensureLegibleForeground = (background: string, foreground: string) =>
  contrastRatio(background, foreground) >= MIN_LEGIBLE_CONTRAST ? foreground : pickForeground(background)
import {
  clearStoredAnonymousSession,
  publicChatApi,
  readStoredAnonymousSessionId,
  readStoredEffectivePublicChatToken,
  readStoredPublicSessionResumeToken,
  readStoredPublicSessionToken,
  type AgentBrandingSettings,
  type AnswerFeedbackEntry,
  type AnswerFeedbackState,
  type AnswerSegment,
  type Citation,
  type ChatSuggestion,
  type ChatConversationDetail,
  type ChatStreamCompletion,
  type ChatUserInputMetadata,
  type PublicChatIntakeAction,
  type ErrorResponse,
  type ActivitySummary,
  type ActivityTrace,
  type SkillStreamPayload,
  type WebsiteEmbedPageContext,
  type WebsiteEmbedThemeSettings,
} from '@/lib/api'
import type { WebsiteEmbedAnalyticsInput } from '@/lib/embed-analytics'

export const deriveThemeOverridesFromModel = (theme?: WebsiteEmbedThemeSettings | null): WebsiteEmbedThemeOverrides | null => {
  if (!theme) {
    return null
  }
  const surface = theme.surface
  const brand = theme.brand
  const text = ensureLegibleForeground(surface, theme.text)
  const brandText = ensureLegibleForeground(brand, theme.brandText)

  const isSurfaceDark = relativeLuminance(surface) < 0.5
  const shadowSurface = isSurfaceDark
    ? '0 24px 60px rgba(0, 0, 0, 0.55)'
    : '0 24px 60px rgba(15, 23, 42, 0.28)'
  const shadowBrand = relativeLuminance(brand) < 0.5
    ? '0 18px 40px rgba(0, 0, 0, 0.45)'
    : '0 18px 40px rgba(15, 23, 42, 0.24)'

  return {
    launcherBackground: brand,
    launcherForeground: brandText,
    launcherBorder: mixHexRgba(brand, brandText, 0.16, 0.5),
    launcherShadow: shadowBrand,
    panelBackground: surface,
    panelForeground: text,
    panelBorder: mixHexRgba(surface, text, 0.18, 0.55),
    panelShadow: shadowSurface,
    accent: brand,
    accentForeground: brandText,
    mutedBackground: mixHex(surface, text, 0.06),
    mutedForeground: mixHex(text, surface, 0.45),
    inputBackground: surface,
    inputForeground: text,
    inputBorder: mixHex(surface, text, 0.2),
    inputPlaceholder: mixHex(text, surface, 0.5),
    assistantBubbleBackground: mixHex(surface, text, 0.04),
    assistantBubbleForeground: text,
    userBubbleBackground: brand,
    userBubbleForeground: brandText,
  }
}

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
  answerFeedbackEntries?: AnswerFeedbackEntry[]
  activitySummary?: ActivitySummary
  activityTrace?: ActivityTrace
  persistedAssistantMessageId?: string
  status: 'complete' | 'streaming' | 'error'
  skill?: SkillStreamPayload
  /** Message provenance, so the visitor can tell a human operator reply from the AI. */
  source?: ChatConversationDetail['messages'][number]['source']
  /** Display name of the human operator who sent this reply (takeover). */
  operatorDisplayName?: string
}

interface AnonymousChatContextValue {
  publicChatToken: string
  messages: ChatMessage[]
  conversationId?: string
  workspaceName: string | null
  assistantAvatarUrl: string | null
  assistantLinkUtmEnabled: boolean
  citationDisplayEnabled: boolean
  assistantTheme: WebsiteEmbedThemeOverrides | null
  branding: AgentBrandingSettings | null
  intakeActions: PublicChatIntakeAction[]
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
  trackAnalyticsEvent: (event: WebsiteEmbedAnalyticsInput) => void
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

const resolveOwnFeedback = (
  entries: AnswerFeedbackEntry[] | undefined,
  anonymousSessionId: string | null | undefined,
): AnswerFeedbackState | undefined => {
  const entry = entries?.find((feedback) =>
    feedback.actorType === 'anonymous_user' &&
    feedback.anonymousSessionId === anonymousSessionId,
  )
  return entry ? { value: entry.value, comment: entry.comment } : undefined
}

const stripPublicSuggestionCitation = (suggestion: ChatSuggestion): ChatSuggestion => {
  const publicSuggestion = { ...suggestion }
  delete publicSuggestion.citation
  return publicSuggestion
}

const stripPublicSuggestionCitations = (suggestions?: ChatSuggestion[]) =>
  suggestions?.map(stripPublicSuggestionCitation)

const toPublicAnswerSegments = (answerSegments?: AnswerSegment[]) =>
  answerSegments?.map((segment) => ({
    text: segment.text,
    ...(segment.citationIndices ? { citationIndices: segment.citationIndices } : {}),
  }))

const toChatMessagesFromTurns = (
  messages: ChatConversationDetail['messages'],
  anonymousSessionId?: string | null,
): ChatMessage[] =>
  messages
    .filter((message): message is typeof message & { role: 'user' | 'assistant' } => message.role !== 'system')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      inputMetadata: message.inputMetadata,
      citations: message.citations,
      answerSegments: toPublicAnswerSegments(message.answerSegments),
      suggestions: stripPublicSuggestionCitations(message.suggestions),
      answerFeedback: message.role === 'assistant'
        ? resolveOwnFeedback(message.answerFeedbackEntries, anonymousSessionId)
        : undefined,
      answerFeedbackEntries: message.role === 'assistant' ? message.answerFeedbackEntries : undefined,
      activitySummary: message.debug?.activitySummary,
      activityTrace: message.debug?.activityTrace,
      persistedAssistantMessageId: message.role === 'assistant' ? message.id : undefined,
      status: 'complete' as const,
      source: message.source,
      operatorDisplayName: message.operatorDisplayName,
    }))

const toChatMessages = (
  detail: ChatConversationDetail,
  anonymousSessionId?: string | null,
): ChatMessage[] => toChatMessagesFromTurns(detail.messages, anonymousSessionId)

const isHumanAgentReply = (message: ChatConversationDetail['messages'][number]) =>
  message.role === 'assistant' &&
  (message.source === 'human_agent' || message.source === 'human_agent_on_behalf_of_ai_agent')

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

const getLatestAssistantMessage = (
  detail: ChatConversationDetail,
  anonymousSessionId?: string | null,
): ChatMessage | null => {
  const assistantMessages = toChatMessages(detail, anonymousSessionId).filter((message) => message.role === 'assistant')
  return assistantMessages.at(-1) ?? null
}

const INITIAL_MESSAGE_WINDOW_SIZE = 10
const MESSAGE_WINDOW_SIZE = 50
export const PUBLIC_CHAT_EVENT_RECONNECT_DELAY_MS = 2_500
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
  consumeSessionHandoff,
  localeOverride,
  pageContext,
  signedIdentity,
  onAnalyticsEvent,
  children,
}: {
  token: string
  sessionChannel?: 'anonymous_link' | null
  consumeSessionHandoff?: boolean
  localeOverride?: string | null
  pageContext?: WebsiteEmbedPageContext | null
  signedIdentity?: string | null
  onAnalyticsEvent?: (event: WebsiteEmbedAnalyticsInput) => void
  children: ReactNode
}) {
  const [effectivePublicChatToken, setEffectivePublicChatToken] = useState(() => readStoredEffectivePublicChatToken(token) ?? token)
  const publicChatTokenRef = useRef(effectivePublicChatToken)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [assistantAvatarUrl, setAssistantAvatarUrl] = useState<string | null>(null)
  const [assistantLinkUtmEnabled, setAssistantLinkUtmEnabled] = useState(true)
  const [citationDisplayEnabled, setCitationDisplayEnabled] = useState(true)
  const [assistantTheme, setAssistantTheme] = useState<WebsiteEmbedThemeOverrides | null>(null)
  const [branding, setBranding] = useState<AgentBrandingSettings | null>(null)
  const [intakeActions, setIntakeActions] = useState<PublicChatIntakeAction[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [bootstrapGreetingId, setBootstrapGreetingId] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [isHydrating, setIsHydrating] = useState(true)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  const [isUnavailable, setIsUnavailable] = useState(false)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [nextMessageCursor, setNextMessageCursor] = useState<string | null>(null)
  const [rateLimitError, setRateLimitError] = useState<string | null>(null)
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null)
  const tailCursorRef = useRef<string | null>(null)

  const createPublicLaunchSession = useCallback(
    async (input?: { resetSession?: boolean }) => {
      if (!sessionChannel) {
        return null
      }

      const activeToken = publicChatTokenRef.current
      const session = await publicChatApi.createSession(activeToken, {
        channel: sessionChannel,
        resumeToken: input?.resetSession ? null : readStoredPublicSessionResumeToken(activeToken),
        pageContext,
      })
      publicChatTokenRef.current = session.publicChatToken
      setEffectivePublicChatToken(session.publicChatToken)
      setAssistantAvatarUrl(session.assistantAvatarUrl ?? null)
      setAssistantLinkUtmEnabled(session.assistantLinkUtmEnabled ?? true)
      setCitationDisplayEnabled(session.citationDisplayEnabled ?? true)
      setAssistantTheme(deriveThemeOverridesFromModel(session.theme))
      setBranding(session.branding ?? null)
      setIntakeActions(session.intakeActions ?? [])
      return session
    },
    [pageContext, sessionChannel],
  )

  const ensurePublicLaunchSession = useCallback(async (): Promise<string> => {
    const activeToken = publicChatTokenRef.current
    if (!sessionChannel || readStoredPublicSessionToken(activeToken)) {
      return activeToken
    }

    const session = await createPublicLaunchSession()
    return session?.publicChatToken ?? activeToken
  }, [createPublicLaunchSession, sessionChannel])

  const withPublicSessionRetry = useCallback(
    async <T,>(operation: (activeToken: string) => Promise<T>): Promise<T> => {
      const activeToken = await ensurePublicLaunchSession()

      try {
        return await operation(activeToken)
      } catch (error) {
        if (sessionChannel && getErrorResponse(error)?.code === 'not_found') {
          clearStoredAnonymousSession(activeToken)
          const session = await createPublicLaunchSession({ resetSession: true })
          return operation(session?.publicChatToken ?? activeToken)
        }

        throw error
      }
    },
    [createPublicLaunchSession, ensurePublicLaunchSession, sessionChannel],
  )

  const hydrateConversation = useCallback(async () => {
    setIsHydrating(true)
    setIsUnavailable(false)
    setMessages([])
    setWorkspaceName(null)
    setAssistantAvatarUrl(null)
    setAssistantLinkUtmEnabled(true)
    setCitationDisplayEnabled(true)
    setAssistantTheme(null)
    setBranding(null)
    setIntakeActions([])
    setConversationId(undefined)
    setBootstrapGreetingId(undefined)
    setHasOlderMessages(false)
    setNextMessageCursor(null)
    tailCursorRef.current = null
    setRateLimitError(null)
    setRetryAfterSeconds(null)

    try {
      const response = await withPublicSessionRetry((activeToken) => publicChatApi.listConversations(activeToken, { limit: 1 }))
      setWorkspaceName(response.workspaceName ?? null)
      setAssistantAvatarUrl(response.assistantAvatarUrl ?? null)
      setAssistantLinkUtmEnabled(response.assistantLinkUtmEnabled ?? true)
      setCitationDisplayEnabled(response.citationDisplayEnabled ?? true)
      setAssistantTheme(deriveThemeOverridesFromModel(response.theme))
      setBranding(response.branding ?? null)
      setIntakeActions(response.intakeActions ?? [])

      if (response.conversations.length === 0) {
        if (response.assistantBootstrapActive) {
          const bootstrap = await withPublicSessionRetry((activeToken) =>
            publicChatApi.bootstrapConversation(activeToken, {
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
            } else {
              setBootstrapGreetingId(bootstrap.bootstrapGreetingId)
            }
            setMessages([
              {
                id: createClientId('public-chat-assistant'),
                role: 'assistant',
                content: bootstrap.answer,
                createdAt: new Date().toISOString(),
                citations: bootstrap.citations,
                answerSegments: toPublicAnswerSegments(bootstrap.answerSegments),
                suggestions: stripPublicSuggestionCitations(bootstrap.suggestions),
                activitySummary: bootstrap.activitySummary,
                activityTrace: bootstrap.activityTrace,
                persistedAssistantMessageId: bootstrap.assistantMessageId,
                status: 'complete',
              },
            ])
          }
        }
        return
      }

      let detailToken = publicChatTokenRef.current
      const detail = await withPublicSessionRetry((activeToken) => {
        detailToken = activeToken
        return publicChatApi.getConversationDetail(activeToken, response.conversations[0].id, {
          limit: INITIAL_MESSAGE_WINDOW_SIZE,
        })
      })

      setConversationId(detail.conversationId)
      setMessages(toChatMessages(detail, readStoredAnonymousSessionId(detailToken)))
      setHasOlderMessages(detail.hasOlderMessages)
      setNextMessageCursor(detail.nextCursor)
      tailCursorRef.current = detail.tailCursor
    } catch (error) {
      const structuredError = getErrorResponse(error)
      if (structuredError?.code === 'not_found') {
        setIsUnavailable(true)
      }
    } finally {
      setIsHydrating(false)
    }
  }, [localeOverride, pageContext, withPublicSessionRetry])

  useEffect(() => {
    let cancelled = false

    if (!cancelled) {
      if (consumeSessionHandoff) {
        consumePublicChatSessionHandoffHash(token)
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrates persisted public conversation state after mount/token changes.
      void hydrateConversation()
    }

    return () => {
      cancelled = true
    }
  }, [consumeSessionHandoff, hydrateConversation, token])

  const appendHumanReplies = useCallback((humanReplies: ChatConversationDetail['messages'], activeToken: string) => {
    if (humanReplies.length === 0) {
      return
    }

    const nextMessages = toChatMessagesFromTurns(humanReplies, readStoredAnonymousSessionId(activeToken))
    setMessages((current) => {
      const seenIds = new Set(current.flatMap((message) => [
        message.id,
        message.persistedAssistantMessageId,
      ]).filter((value): value is string => Boolean(value)))
      const unseen = nextMessages.filter((message) => !seenIds.has(message.id))
      return unseen.length > 0 ? [...clearMessageSuggestions(current), ...unseen] : current
    })
  }, [])

  const syncConversationSnapshot = useCallback(async (activeConversationId: string) => {
    let detailToken = publicChatTokenRef.current
    const detail = await withPublicSessionRetry((activeToken) => {
      detailToken = activeToken
      return publicChatApi.getConversationDetail(activeToken, activeConversationId, {
        limit: MESSAGE_WINDOW_SIZE,
      })
    })
    tailCursorRef.current = detail.tailCursor
    appendHumanReplies(detail.messages.filter(isHumanAgentReply), detailToken)
  }, [appendHumanReplies, withPublicSessionRetry])

  const refreshConversationTail = useCallback(async (activeConversationId: string) => {
    let tailToken = publicChatTokenRef.current
    const tail = await withPublicSessionRetry((activeToken) => {
      tailToken = activeToken
      return publicChatApi.tailConversation(activeToken, activeConversationId, {
        limit: 25,
        cursor: tailCursorRef.current,
      })
    })

    tailCursorRef.current = tail.cursor
    appendHumanReplies(tail.messages.filter(isHumanAgentReply), tailToken)
  }, [appendHumanReplies, withPublicSessionRetry])

  useEffect(() => {
    if (!conversationId || isHydrating || isUnavailable) {
      tailCursorRef.current = null
      return
    }

    let cancelled = false
    let refreshChain = Promise.resolve()
    let streamController: AbortController | null = null
    let reconnectTimer: ReturnType<typeof window.setTimeout> | null = null

    const handleStreamFailure = (error: unknown) => {
      if (cancelled) {
        return
      }
      if (getErrorResponse(error)?.code === 'not_found') {
        setIsUnavailable(true)
        return
      }
      reconnectTimer = window.setTimeout(connect, PUBLIC_CHAT_EVENT_RECONNECT_DELAY_MS)
    }
    const handleRefreshFailure = (error: unknown) => {
      if (!cancelled && getErrorResponse(error)?.code === 'not_found') {
        setIsUnavailable(true)
      }
    }

    const refreshFromTail = (includeSnapshot: boolean) => {
      refreshChain = refreshChain
        .then(async () => {
          if (cancelled) {
            return
          }
          if (includeSnapshot && tailCursorRef.current === null) {
            await syncConversationSnapshot(conversationId)
          }
          if (!cancelled) {
            await refreshConversationTail(conversationId)
          }
        })
        .catch(handleRefreshFailure)
    }

    function connect() {
      if (cancelled) {
        return
      }
      streamController = new AbortController()
      void withPublicSessionRetry((activeToken) =>
        publicChatApi.streamConversationEvents(
          activeToken,
          conversationId,
          {
            onEvent: (event) => {
              if (event.conversationId !== conversationId) {
                return
              }
              if (event.type === 'ready') {
                refreshFromTail(true)
                return
              }
              if (event.type === 'message.created') {
                refreshFromTail(false)
              }
            },
          },
          { signal: streamController?.signal },
        ),
      )
        .then(() => {
          if (!cancelled) {
            reconnectTimer = window.setTimeout(connect, PUBLIC_CHAT_EVENT_RECONNECT_DELAY_MS)
          }
        })
        .catch((error) => {
          if (streamController?.signal.aborted) {
            return
          }
          handleStreamFailure(error)
        })
    }

    connect()

    return () => {
      cancelled = true
      streamController?.abort()
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
      }
    }
  }, [
    conversationId,
    isHydrating,
    isUnavailable,
    refreshConversationTail,
    syncConversationSnapshot,
    withPublicSessionRetry,
  ])

  const applyCompletion = useCallback(
    (assistantMessageId: string, completion: ChatStreamCompletion) => {
      if (completion.conversationId) {
        setConversationId(completion.conversationId)
        setBootstrapGreetingId(undefined)
      }
      setIsLoading(false)
      if (completion.ownership?.state === 'human_owned' && completion.ownership.suppressed) {
        // Human-owned turn: the backend suppressed the AI and returns a localized
        // "a teammate is joining, please wait" line in `answer`. Show it; if it fell
        // back to empty, drop the placeholder rather than render an empty bubble.
        const waitingMessage = completion.answer?.trim() ?? ''
        setMessages((prev) =>
          waitingMessage
            ? prev.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      content: waitingMessage,
                      citations: [],
                      answerSegments: [],
                      suggestions: [],
                      status: 'complete' as const,
                    }
                  : message,
              )
            : prev.filter((message) => message.id !== assistantMessageId),
        )
        return
      }
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                persistedAssistantMessageId: completion.assistantMessageId ?? message.persistedAssistantMessageId,
                content: completion.answer ?? message.content,
                citations: completion.citations,
                answerSegments: toPublicAnswerSegments(completion.answerSegments),
                suggestions: stripPublicSuggestionCitations(completion.suggestions),
                activitySummary: completion.debug?.activitySummary,
                activityTrace: completion.debug?.activityTrace,
                skill: completion.skill ?? message.skill,
                status: 'complete' as const,
              }
            : message,
        ),
      )
    },
    [],
  )

  const recoverAssistantMessage = useCallback(
    async (nextConversationId: string | undefined, assistantMessageId: string, activeToken: string) => {
      if (!nextConversationId) {
        return null
      }

      const detail = await publicChatApi.getConversationDetail(activeToken, nextConversationId, {
        limit: MESSAGE_WINDOW_SIZE,
      })
      const assistantMessage = getLatestAssistantMessage(detail, readStoredAnonymousSessionId(activeToken))
      if (!assistantMessage) {
        return null
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
                answerSegments: toPublicAnswerSegments(assistantMessage.answerSegments),
                suggestions: stripPublicSuggestionCitations(assistantMessage.suggestions),
                answerFeedback: assistantMessage.answerFeedback,
                answerFeedbackEntries: assistantMessage.answerFeedbackEntries,
                activitySummary: assistantMessage.activitySummary,
                activityTrace: assistantMessage.activityTrace,
                persistedAssistantMessageId: assistantMessage.persistedAssistantMessageId ?? assistantMessage.id,
                status: 'complete' as const,
              }
            : message,
        ),
      )
      setIsLoading(false)
      return assistantMessage
    },
    [],
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
      const inputMethod = inputMetadata?.method ?? 'typed'

      onAnalyticsEvent?.({
        event: 'chat.started',
        subjectType: conversationId ? 'conversation' : undefined,
        subjectId: conversationId,
        properties: {
          inputMethod,
          hasExistingConversation: Boolean(conversationId),
        },
      })

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
        let activeRequestToken = publicChatTokenRef.current

        const completion = await withPublicSessionRetry((activeToken) => {
          activeRequestToken = activeToken
          return publicChatApi.streamMessage(
            activeToken,
            {
              message: query,
              stream: true,
              conversationId,
              bootstrapGreetingId: conversationId ? undefined : bootstrapGreetingId,
              inputMetadata,
              userExpectedLocale: resolveAnonymousChatBootstrapLocale({
                localeOverride,
                pageContext,
              }),
              pageContext,
              signedIdentity,
            },
            {
              onConversation: ({ conversationId: newId }) => {
                setConversationId(newId)
                setBootstrapGreetingId(undefined)
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
                          suggestions: stripPublicSuggestionCitations(suggestions),
                        }
                      : message,
                  ),
                )
              },
              onSkill: (skillPayload) => {
                setMessages((prev) =>
                  prev.map((message) =>
                    message.id === assistantMessageId
                      ? {
                          ...message,
                          skill: {
                            skillName: skillPayload.skillName,
                            phase: skillPayload.phase,
                            display: skillPayload.display,
                            localizedTitle: skillPayload.localizedTitle,
                            receipt: skillPayload.receipt,
                          },
                        }
                      : message,
                  ),
                )
              },
            },
          )
        })

        const nextConversationId = completion.conversationId ?? conversationId
        const suppressedByHumanOwnership =
          completion.ownership?.state === 'human_owned' && completion.ownership.suppressed

        if (suppressedByHumanOwnership) {
          if (!didComplete) {
            applyCompletion(assistantMessageId, {
              conversationId: nextConversationId,
              answer: completion.answer,
              citations: completion.citations,
              answerSegments: completion.answerSegments,
              suggestions: completion.suggestions,
              ownership: completion.ownership,
              debug: completion.debug,
            })
          }
          onAnalyticsEvent?.({
            event: 'chat.completed',
            subjectType: 'conversation',
            subjectId: nextConversationId,
            properties: {
              inputMethod,
              citationCount: 0,
              hasAnswer: false,
              ownershipSuppressed: true,
              recovered: false,
              suggestionCount: 0,
            },
          })
          return
        }

        const needsRecovery = !completion.answer?.trim()

        if (needsRecovery) {
          const recovered = await recoverAssistantMessage(nextConversationId, assistantMessageId, activeRequestToken)
          if (recovered) {
            onAnalyticsEvent?.({
              event: 'chat.completed',
              subjectType: 'conversation',
              subjectId: nextConversationId,
              properties: {
                inputMethod,
                citationCount: recovered.citations?.length ?? 0,
                hasAnswer: Boolean(recovered.content.trim()),
                recovered: true,
                suggestionCount: recovered.suggestions?.length ?? 0,
              },
            })
            return
          }

          if (!didComplete) {
            applyCompletion(assistantMessageId, {
              conversationId: nextConversationId,
              answer: completion.answer,
              citations: completion.citations,
              answerSegments: completion.answerSegments,
              suggestions: completion.suggestions,
              debug: completion.debug,
            })
          }
          onAnalyticsEvent?.({
            event: 'chat.failed',
            subjectType: nextConversationId ? 'conversation' : undefined,
            subjectId: nextConversationId,
            properties: {
              inputMethod,
              errorCode: 'empty_answer',
              hasAnswer: false,
              rateLimited: false,
              recovered: false,
            },
          })
          return
        }

        if (!didComplete) {
          applyCompletion(assistantMessageId, {
            conversationId: nextConversationId,
            answer: completion.answer,
            citations: completion.citations,
            answerSegments: completion.answerSegments,
            suggestions: completion.suggestions,
            debug: completion.debug,
          })
        }
        onAnalyticsEvent?.({
          event: 'chat.completed',
          subjectType: 'conversation',
          subjectId: nextConversationId,
          properties: {
            inputMethod,
            citationCount: completion.citations?.length ?? 0,
            hasAnswer: Boolean(completion.answer?.trim()),
            suggestionCount: completion.suggestions?.length ?? 0,
            recovered: false,
          },
        })
      } catch (error) {
        const structuredError = getErrorResponse(error)
        const rateLimit = isRateLimitError(error)
        if (rateLimit) {
          onAnalyticsEvent?.({
            event: 'chat.failed',
            subjectType: conversationId ? 'conversation' : undefined,
            subjectId: conversationId,
            properties: {
              inputMethod,
              errorCode: structuredError?.code ?? 'rate_limit_exceeded',
              rateLimited: true,
              retryAfterSeconds: rateLimit.retryAfterSeconds,
            },
          })
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

        if (structuredError?.code === 'not_found') {
          onAnalyticsEvent?.({
            event: 'chat.failed',
            subjectType: conversationId ? 'conversation' : undefined,
            subjectId: conversationId,
            properties: {
              inputMethod,
              errorCode: structuredError.code,
              rateLimited: false,
            },
          })
          setIsUnavailable(true)
          setMessages(previousMessages)
          setIsLoading(false)
          return
        }

        const errorMessage = getErrorMessage(error)
        onAnalyticsEvent?.({
          event: 'chat.failed',
          subjectType: conversationId ? 'conversation' : undefined,
          subjectId: conversationId,
          properties: {
            inputMethod,
            errorCode: structuredError?.code ?? 'unknown_error',
            rateLimited: false,
          },
        })
        setMessages((prev) =>
          restoreMessageSuggestions(
            prev.map((message) => {
              if (message.id !== assistantMessageId) return message
              return {
                ...message,
                content: message.content || errorMessage,
                status: 'error' as const,
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
    [applyCompletion, bootstrapGreetingId, conversationId, isHydrating, isLoading, isUnavailable, localeOverride, messages, onAnalyticsEvent, pageContext, recoverAssistantMessage, signedIdentity, withPublicSessionRetry],
  )

  const loadOlderMessages = useCallback(async () => {
    if (!conversationId || isLoadingOlderMessages || !hasOlderMessages || !nextMessageCursor) {
      return
    }

    setIsLoadingOlderMessages(true)

    try {
      const activeToken = publicChatTokenRef.current
      const detail = await publicChatApi.getConversationDetail(activeToken, conversationId, {
        limit: MESSAGE_WINDOW_SIZE,
        cursor: nextMessageCursor,
      })
      const olderMessages = toChatMessages(detail, readStoredAnonymousSessionId(activeToken))
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
  }, [conversationId, hasOlderMessages, isLoadingOlderMessages, nextMessageCursor])

  const startNewChat = useCallback(async () => {
    if (isLoading || isHydrating || isLoadingOlderMessages) {
      return
    }

    clearStoredAnonymousSession(publicChatTokenRef.current)
    await hydrateConversation()
  }, [hydrateConversation, isHydrating, isLoading, isLoadingOlderMessages])

  const trackAnalyticsEvent = useCallback((event: WebsiteEmbedAnalyticsInput) => {
    onAnalyticsEvent?.(event)
  }, [onAnalyticsEvent])

  const value = useMemo<AnonymousChatContextValue>(
    () => ({
      publicChatToken: effectivePublicChatToken,
      messages,
      conversationId,
      workspaceName,
      assistantAvatarUrl,
      assistantLinkUtmEnabled,
      citationDisplayEnabled,
      assistantTheme,
      branding,
      intakeActions,
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
      trackAnalyticsEvent,
    }),
    [
      effectivePublicChatToken,
      messages,
      conversationId,
      workspaceName,
      assistantAvatarUrl,
      assistantLinkUtmEnabled,
      citationDisplayEnabled,
      assistantTheme,
      branding,
      intakeActions,
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
      trackAnalyticsEvent,
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
