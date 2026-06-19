'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { TypingIndicator } from '@/components/ui/typing-indicator'
import { Check, CircleCheckBig, Copy, PauseCircle, ThumbsDown, ThumbsUp, Workflow } from 'lucide-react'
import { DEFAULT_WEBSITE_EMBED_COPY, type WebsiteEmbedCopy, type WebsiteEmbedTheme } from '@/lib/embed-widget'
import { computeSkillGroupInfo } from '@/lib/skill-thread-grouping'
import type { RoutineThreadMarker } from '@/lib/routine-thread-grouping'
import { getSkillDisplay, type SkillCatalogDisplayEntry, type SkillDisplaySource } from '@/lib/skill-display'
import {
  AssistantMessageContent,
  type AssistantLinkClickAnalyticsInput,
  type CitationOpenResult,
  linkifyText,
} from './chat-citations'
import { SendToEvalAction } from './send-to-eval-action'
import { API_BASE } from '@/lib/api-client'
import {
  BeaconFrontendProductAnalyticsSink,
  createFrontendProductAnalyticsEmitter,
} from '@/lib/product-analytics'
import type { WebsiteEmbedAnalyticsInput } from '@/lib/embed-analytics'
import type {
  AnswerFeedbackEntry,
  AnswerFeedbackState,
  AnswerFeedbackValue,
  AnswerSegment,
  ChatSuggestion,
  ChatUserInputMetadata,
  Citation,
  SkillDisplayMetadata,
  SkillStreamPayload,
} from '@/lib/api'

type MessageSource = 'customer' | 'ai_agent' | 'human_agent' | 'human_agent_on_behalf_of_ai_agent' | 'system'

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
})

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})

const SUGGESTION_BUTTON_HOVER_CLASS =
  'radioso-suggestion-hover-highlight'

export const THEMED_SUGGESTION_BUTTON_CLASS =
  `border-[var(--suggestion-border)] bg-[var(--suggestion-bg)] text-[var(--suggestion-fg)] transition-colors ${SUGGESTION_BUTTON_HOVER_CLASS}`

export const getThemedSuggestionButtonStyle = (theme: WebsiteEmbedTheme): CSSProperties => ({
  '--suggestion-bg': theme.mutedBackground,
  '--suggestion-border': theme.panelBorder,
  '--suggestion-fg': theme.panelForeground,
} as CSSProperties)
type ChatLinkAnalyticsSurface = 'dashboard' | 'history' | 'eval' | 'public_chat' | 'embed'

const toAssistantUtmMedium = (assistantName?: string | null) => {
  const normalized = assistantName
    ?.trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')

  return `${normalized || 'assistant'}_agent`
}

export const appendAssistantLinkUtm = (href: string, assistantName?: string | null) => {
  try {
    const url = new URL(href)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return href
    }

    url.searchParams.set('utm_source', 'radioso')
    url.searchParams.set('utm_medium', toAssistantUtmMedium(assistantName))
    return url.toString()
  } catch {
    return href
  }
}

const sanitizeDestinationForAnalytics = (destinationUrl?: string) => {
  if (!destinationUrl) {
    return {}
  }

  try {
    const url = new URL(destinationUrl)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return {}
    }

    return {
      destinationOrigin: url.protocol === 'mailto:' ? 'mailto:' : url.origin,
      destinationPath: url.protocol === 'mailto:' ? '' : url.pathname,
    }
  } catch {
    return {}
  }
}

const removeUndefinedProperties = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))

export interface ChatThreadMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  source?: MessageSource
  content: string
  createdAt: string
  inputMetadata?: ChatUserInputMetadata
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  suggestions?: ChatSuggestion[]
  answerFeedback?: AnswerFeedbackState
  answerFeedbackEntries?: AnswerFeedbackEntry[]
  persistedAssistantMessageId?: string
  status?: 'streaming' | 'done' | 'complete' | 'error'
  skill?: SkillStreamPayload
}

const SKILL_ACCENT_FALLBACK = '#0f172a'

const accentTint = (accent: string | undefined, percent: number): string =>
  `color-mix(in srgb, ${accent ?? SKILL_ACCENT_FALLBACK} ${percent}%, transparent)`

const skillDisplaySource = (
  skillName: string,
  display: SkillDisplayMetadata | undefined,
  skillCatalogByName: Map<string, SkillCatalogDisplayEntry>,
): SkillDisplaySource => {
  const catalogEntry = skillCatalogByName.get(skillName)
  return {
    displayName: catalogEntry?.displayName,
    display: display ?? catalogEntry?.display,
  }
}

function SkillChip({
  skill,
  displaySource,
  theme,
}: {
  skill: SkillStreamPayload
  displaySource: SkillDisplaySource
  theme?: WebsiteEmbedTheme | null
}) {
  const display = getSkillDisplay(displaySource)
  const Icon = display.icon
  const title = skill.localizedTitle?.trim() || display.fallbackTitle
  const accent = theme?.accent ?? SKILL_ACCENT_FALLBACK
  return (
    <div
      data-skill-chip
      data-skill-name={skill.skillName}
      className="inline-flex w-fit items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-xs font-medium"
      style={{
        background: accentTint(accent, 6),
        borderColor: accentTint(accent, 18),
        color: accent,
      }}
    >
      <Icon className="size-3.5" aria-hidden style={{ color: accent }} />
      <span>{title}</span>
    </div>
  )
}

function SkillReceiptCard({
  skill,
  theme,
  copy,
}: {
  skill: SkillStreamPayload
  theme?: WebsiteEmbedTheme | null
  copy: WebsiteEmbedCopy
}) {
  const isFailed = skill.phase === 'failed'
  const statusLabel = skill.receipt?.statusLabel?.trim()
    || (isFailed ? copy.skillReceiptFailedLabel : copy.skillReceiptSubmittedLabel)
  const fields = skill.receipt?.fields ?? []
  const accent = theme?.accent ?? SKILL_ACCENT_FALLBACK
  const accentForeground = theme?.assistantBubbleForeground ?? '#0f172a'
  const mutedForeground = theme?.mutedForeground ?? '#64748b'
  return (
    <div
      data-skill-receipt
      data-skill-name={skill.skillName}
      data-skill-phase={skill.phase}
      className="w-fit max-w-full self-start rounded-2xl border px-4 py-3 text-sm"
      style={{
        background: theme?.assistantBubbleBackground ?? '#ffffff',
        borderColor: accentTint(accent, 18),
        color: accentForeground,
      }}
    >
      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: accent }}>
        <span
          className="inline-flex size-5 items-center justify-center rounded-full"
          style={{ background: accentTint(accent, 12) }}
        >
          <Check className="size-3" aria-hidden />
        </span>
        <span>{statusLabel}</span>
      </div>
      {fields.length > 0 ? (
        <dl className="mt-1.5 flex flex-col gap-1">
          {fields.map((field) => (
            <div key={field.name} className="flex flex-col">
              <dt
                className="text-[10px] font-medium uppercase tracking-wider"
                style={{ color: mutedForeground }}
              >
                {field.displayName}
              </dt>
              <dd className="text-sm" style={{ color: accentForeground }}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Prefer the catalog name; fall back to a humanized id for built-in routines
// whose id is a readable handle. Opaque ids (uuids) get the generic label and
// rely on the id tooltip. This is identifier formatting, not product vocabulary.
const routineDisplayLabel = (routineId: string | undefined, routineName: string | undefined): string => {
  const name = routineName?.trim()
  if (name) {
    return name
  }
  if (!routineId || UUID_PATTERN.test(routineId)) {
    return 'Routine'
  }
  const words = routineId.split(/[._\-/\s]+/).filter(Boolean)
  if (words.length === 0) {
    return 'Routine'
  }
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function RoutineStartChip({
  routineId,
  routineName,
  routineHref,
}: {
  routineId?: string
  routineName?: string
  routineHref?: string
}) {
  const label = routineDisplayLabel(routineId, routineName)
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1"
        title={routineId ? `Routine ID: ${routineId}` : undefined}
      >
        <Workflow className="size-3.5" aria-hidden />
        <span>Routine started</span>
        {routineHref ? (
          <a href={routineHref} className="font-normal text-primary underline-offset-2 hover:underline">
            {label}
          </a>
        ) : (
          <span className="font-normal text-muted-foreground/80">{label}</span>
        )}
      </span>
    </div>
  )
}

function RoutineEndMarker({ endState }: { endState?: 'paused' | 'ended' }) {
  const paused = endState === 'paused'
  const Icon = paused ? PauseCircle : CircleCheckBig
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      <span>{paused ? 'Routine paused' : 'Routine ended'}</span>
    </div>
  )
}

type FeedbackHandler = (input: {
  assistantMessageId: string
  value: AnswerFeedbackValue
  comment?: string | null
}) => Promise<AnswerFeedbackState | void> | AnswerFeedbackState | void

function MessageCopyButton({
  content,
  theme,
}: {
  content: string
  theme?: WebsiteEmbedTheme | null
}) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
      }
    },
    [],
  )

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        setCopied(false)
      }, 1500)
    } catch {
      // Clipboard write may fail in insecure contexts; intentional silent fail.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy message'}
      className="inline-flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
      style={theme ? { color: theme.mutedForeground } : undefined}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

export function ChatMessageThread({
  messages,
  onOpenDocument,
  onSuggestionSelect,
  onMessageSelect,
  selectedMessageId,
  assistantAvatarLabel,
  assistantLinkUtmEnabled = true,
  theme,
  themedSuggestionButtons = false,
  onAnswerFeedback,
  onClearAnswerFeedback,
  hideFeedbackEntries = false,
  copy = DEFAULT_WEBSITE_EMBED_COPY,
  showCitations = true,
  documentInteractivity = 'open',
  conversationId,
  evalCaptureEnabled = false,
  analyticsSurface = 'dashboard',
  analyticsEnabled = true,
  onEmbedAnalyticsEvent,
  skillCatalog = [],
  routineMarkers,
}: {
  messages: ChatThreadMessage[]
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
  onSuggestionSelect?: (suggestion: ChatSuggestion, messageId: string) => void
  onMessageSelect?: (messageId: string) => void
  onAnswerFeedback?: FeedbackHandler
  onClearAnswerFeedback?: (assistantMessageId: string) => Promise<void> | void
  selectedMessageId?: string
  assistantAvatarUrl?: string | null
  assistantAvatarLabel?: string
  assistantLinkUtmEnabled?: boolean
  hideAssistantAvatar?: boolean
  theme?: WebsiteEmbedTheme | null
  themedSuggestionButtons?: boolean
  hideFeedbackEntries?: boolean
  copy?: WebsiteEmbedCopy
  showCitations?: boolean
  documentInteractivity?: 'open' | 'link-only'
  // Eval capture is an authenticated operator action. Public chat and embed
  // surfaces also pass conversationId for analytics and session continuity, so
  // the control must stay explicitly opt-in.
  conversationId?: string
  evalCaptureEnabled?: boolean
  analyticsSurface?: ChatLinkAnalyticsSurface
  analyticsEnabled?: boolean
  onEmbedAnalyticsEvent?: (event: WebsiteEmbedAnalyticsInput) => void
  skillCatalog?: SkillCatalogDisplayEntry[]
  // Diagnostics-only: marks which turns a routine drove so the thread can band
  // the routine's span. Omitted on public chat/embed, which render plainly.
  routineMarkers?: readonly RoutineThreadMarker[]
}) {
  const skillGroupInfo = useMemo(() => computeSkillGroupInfo(messages), [messages])
  const skillCatalogByName = useMemo(
    () => new Map(skillCatalog.map((skill) => [skill.name, skill])),
    [skillCatalog],
  )
  const [analyticsEmitter] = useState(() => createFrontendProductAnalyticsEmitter({
    sinks: [
      new BeaconFrontendProductAnalyticsSink({
        endpoint: `${API_BASE}/observability/product-analytics`,
      }),
    ],
  }))
  const threadRef = useRef<HTMLDivElement | null>(null)
  // Scroll the selected message into view when the selection is set programmatically
  // (e.g. via a deep link from the Quality dashboard). Re-runs only when the target
  // message id or the set of messages changes.
  const messageIdsKey = useMemo(() => messages.map((message) => message.id).join('|'), [messages])
  useEffect(() => {
    if (!selectedMessageId || !threadRef.current) {
      return
    }
    const node = threadRef.current.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(selectedMessageId)}"]`,
    )
    if (!node) {
      return
    }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [selectedMessageId, messageIdsKey])
  const [localFeedback, setLocalFeedback] = useState<Record<string, AnswerFeedbackState | null | undefined>>({})
  const [pendingFeedbackId, setPendingFeedbackId] = useState<string | null>(null)
  const [feedbackError, setFeedbackError] = useState<Record<string, string | undefined>>({})
  const [downvoteComposer, setDownvoteComposer] = useState<{
    assistantMessageId: string
    comment: string
  } | null>(null)

  const trackAssistantLinkClick = useCallback((input: AssistantLinkClickAnalyticsInput & {
    assistantMessageId?: string
  }) => {
    if (!analyticsEnabled) {
      return
    }

    const properties = removeUndefinedProperties({
      surface: analyticsSurface,
      assistantMessageId: input.assistantMessageId,
      citationIndex: input.citationIndex,
      linkType: input.linkType,
      documentId: input.documentId,
      chunkId: input.chunkId,
      ...sanitizeDestinationForAnalytics(input.destinationUrl),
    })
    const event = {
      eventName: input.linkType === 'assistant_url' ? 'chat.link_clicked' as const : 'chat.citation_clicked' as const,
      subjectType: conversationId ? 'conversation' as const : undefined,
      subjectId: conversationId,
      properties,
      source: analyticsSurface === 'embed' ? 'embed' as const : 'frontend' as const,
    }

    void analyticsEmitter.track(event)

    if (analyticsSurface === 'embed') {
      onEmbedAnalyticsEvent?.({
        event: input.linkType === 'assistant_url' ? 'chat.link_clicked' : 'chat.citation_clicked',
        subjectType: conversationId ? 'conversation' : undefined,
        subjectId: conversationId,
        properties,
      })
    }
  }, [analyticsEmitter, analyticsEnabled, analyticsSurface, conversationId, onEmbedAnalyticsEvent])

  const handleSelectMessage = (messageId: string) => {
    const selection = typeof window !== 'undefined' ? window.getSelection()?.toString().trim() : ''
    if (selection) {
      return
    }

    onMessageSelect?.(messageId)
  }

  const getFeedbackState = (message: ChatThreadMessage, assistantMessageId: string) =>
    Object.prototype.hasOwnProperty.call(localFeedback, assistantMessageId)
      ? localFeedback[assistantMessageId] ?? undefined
      : message.answerFeedback

  const submitFeedback = async (input: {
    assistantMessageId: string
    value: AnswerFeedbackValue
    comment?: string | null
  }) => {
    if (!onAnswerFeedback || pendingFeedbackId) {
      return
    }

    const nextState: AnswerFeedbackState = {
      value: input.value,
      comment: input.value === 'down' ? input.comment?.trim() || null : null,
    }
    const previousState = localFeedback[input.assistantMessageId]
    setPendingFeedbackId(input.assistantMessageId)
    setFeedbackError((current) => ({ ...current, [input.assistantMessageId]: undefined }))
    setLocalFeedback((current) => ({ ...current, [input.assistantMessageId]: nextState }))
    setDownvoteComposer(null)

    try {
      const saved = await onAnswerFeedback(input)
      if (saved) {
        setLocalFeedback((current) => ({ ...current, [input.assistantMessageId]: saved }))
      }
    } catch {
      setLocalFeedback((current) => ({ ...current, [input.assistantMessageId]: previousState }))
      setFeedbackError((current) => ({
        ...current,
        [input.assistantMessageId]: 'Unable to save feedback.',
      }))
    } finally {
      setPendingFeedbackId(null)
    }
  }

  const clearFeedback = async (assistantMessageId: string) => {
    if (!onClearAnswerFeedback || pendingFeedbackId) {
      return
    }

    const previousState = localFeedback[assistantMessageId]
    setPendingFeedbackId(assistantMessageId)
    setFeedbackError((current) => ({ ...current, [assistantMessageId]: undefined }))
    setLocalFeedback((current) => ({ ...current, [assistantMessageId]: null }))
    setDownvoteComposer(null)

    try {
      await onClearAnswerFeedback(assistantMessageId)
    } catch {
      setLocalFeedback((current) => ({ ...current, [assistantMessageId]: previousState }))
      setFeedbackError((current) => ({
        ...current,
        [assistantMessageId]: 'Unable to clear feedback.',
      }))
    } finally {
      setPendingFeedbackId(null)
    }
  }

  const handleFeedbackClick = async (
    message: ChatThreadMessage,
    assistantMessageId: string,
    value: AnswerFeedbackValue,
  ) => {
    const current = getFeedbackState(message, assistantMessageId)
    if (current?.value === value) {
      await clearFeedback(assistantMessageId)
      return
    }

    if (value === 'down') {
      setFeedbackError((currentErrors) => ({ ...currentErrors, [assistantMessageId]: undefined }))
      setDownvoteComposer({
        assistantMessageId,
        comment: current?.value === 'down' ? current.comment ?? '' : '',
      })
      return
    }

    await submitFeedback({ assistantMessageId, value })
  }

  const getSelectableMessageProps = (messageId: string) => {
    if (!onMessageSelect) {
      return {}
    }

    return {
      role: 'button' as const,
      tabIndex: 0,
      onClick: () => handleSelectMessage(messageId),
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleSelectMessage(messageId)
        }
      },
    }
  }

  const suggestionThemeVars = theme ? getThemedSuggestionButtonStyle(theme) : undefined

  const renderMessage = (message: ChatThreadMessage, index: number) => {
        const sourceBadgeLabel =
          message.source === 'human_agent' || message.source === 'human_agent_on_behalf_of_ai_agent'
            ? 'Human agent'
            : message.source === 'system'
              ? 'System'
              : null
        const currentDay = dayFormatter.format(new Date(message.createdAt))
        const previousDay =
          index > 0 ? dayFormatter.format(new Date(messages[index - 1].createdAt)) : null
        const showDayDivider = previousDay !== null && currentDay !== previousDay
        const assistantMessageId = message.role === 'assistant'
          ? message.persistedAssistantMessageId ?? null
          : null
        const feedbackState = assistantMessageId ? getFeedbackState(message, assistantMessageId) : undefined
        const feedbackEntries = message.answerFeedbackEntries ?? []
        const canSubmitFeedback =
          Boolean(onAnswerFeedback && onClearAnswerFeedback && assistantMessageId) &&
          message.role === 'assistant' &&
          message.status !== 'streaming'
        const groupInfo = skillGroupInfo[index]
        const showReceipt =
          groupInfo?.isGroupEnd
          && groupInfo.skill
          && (groupInfo.skill.phase === 'completed' || groupInfo.skill.phase === 'failed')

        return (
          <div
            key={message.id}
            data-message-id={message.id}
            data-message-role={message.role}
            data-skill-group={groupInfo?.groupKey ?? undefined}
            className="group/message space-y-2"
          >
            {showDayDivider ? (
              <div className="flex justify-center">
                <div
                  className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground"
                  style={
                    theme
                      ? {
                          background: theme.mutedBackground,
                          color: theme.mutedForeground,
                        }
                      : undefined
                  }
                >
                  {currentDay}
                </div>
              </div>
            ) : null}

            <div className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`${
                  message.role === 'user'
                    ? 'max-w-[80%] items-end'
                    : 'w-full max-w-[80%] items-start'
                } flex flex-col gap-1`}
              >
                {message.role === 'user' ? (
                  <>
                    <div
                      {...getSelectableMessageProps(message.id)}
                      className={`rounded-2xl rounded-br-md px-4 py-3 text-primary-foreground animate-in fade-in-50 slide-in-from-bottom-2 duration-300 ${
                        selectedMessageId === message.id ? 'bg-primary ring-1 ring-white/50' : 'bg-primary'
                      } ${onMessageSelect ? 'cursor-pointer transition' : ''}`}
                      style={
                        theme
                          ? {
                              background: theme.userBubbleBackground,
                              color: theme.userBubbleForeground,
                            }
                          : undefined
                      }
                    >
                      <p className="select-text whitespace-pre-wrap text-sm">{linkifyText(message.content)}</p>
                    </div>
                    <p
                      className="px-1 text-xs text-muted-foreground"
                      style={theme ? { color: theme.mutedForeground } : undefined}
                    >
                      {timeFormatter.format(new Date(message.createdAt))}
                    </p>
                  </>
                ) : (
                  <div className="flex w-full items-start">
                    <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                      {groupInfo?.isGroupStart && groupInfo.skill ? (
                        <SkillChip
                          skill={groupInfo.skill}
                          displaySource={skillDisplaySource(
                            groupInfo.skill.skillName,
                            groupInfo.skill.display,
                            skillCatalogByName,
                          )}
                          theme={theme}
                        />
                      ) : null}
                      {sourceBadgeLabel ? (
                        <Badge
                          variant="secondary"
                          className="w-fit px-2 py-0 text-[11px] font-medium"
                          aria-label={`Message source: ${sourceBadgeLabel}`}
                        >
                          {sourceBadgeLabel}
                        </Badge>
                      ) : null}
                      <div
                        {...getSelectableMessageProps(message.id)}
                        className={`self-start w-fit max-w-full rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3 text-left text-foreground animate-in fade-in-50 slide-in-from-bottom-2 duration-300 ${
                          selectedMessageId === message.id ? 'ring-1 ring-primary/60' : ''
                        } ${onMessageSelect ? 'cursor-pointer transition' : ''}`}
                        style={
                          theme
                            ? {
                                background: theme.assistantBubbleBackground,
                                color: theme.assistantBubbleForeground,
                              }
                            : undefined
                        }
                      >
                        {message.status === 'streaming' && !message.content ? (
                          <TypingIndicator />
                        ) : (
                          <div className="select-text">
                            <AssistantMessageContent
                              content={message.content}
                              citations={message.citations}
                              answerSegments={message.answerSegments}
                              onOpenDocument={onOpenDocument}
                              onLinkClickAnalytics={(input) => {
                                trackAssistantLinkClick({
                                  ...input,
                                  assistantMessageId: message.persistedAssistantMessageId ?? message.id,
                                })
                              }}
                              transformAssistantLinkHref={
                                assistantLinkUtmEnabled
                                  ? (href) => appendAssistantLinkUtm(href, assistantAvatarLabel)
                                  : undefined
                              }
                              theme={theme}
                              isStreaming={message.status === 'streaming'}
                              showCitations={showCitations}
                              documentInteractivity={documentInteractivity}
                            />
                          </div>
                        )}
                      </div>
                      {showReceipt && groupInfo.skill ? (
                        <SkillReceiptCard skill={groupInfo.skill} theme={theme} copy={copy} />
                      ) : null}
                      {(() => {
                        const visibleSuggestions = message.suggestions ?? []
                        return visibleSuggestions.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {visibleSuggestions
                              .filter((suggestion) => suggestion.text.trim())
                              .map((suggestion, suggestionIndex) => {
                              const actionSkillName = suggestion.action?.kind === 'start_intent'
                                ? suggestion.action.intent.skillName
                                : null
                              const actionDisplay = suggestion.action?.kind === 'start_intent'
                                ? suggestion.action.intent.display
                                : undefined
                              const ActionIcon = actionSkillName
                                ? getSkillDisplay(skillDisplaySource(
                                  actionSkillName,
                                  actionDisplay,
                                  skillCatalogByName,
                                )).icon
                                : null
                              return onSuggestionSelect ? (
                                <Button
                                  key={`${message.id}-suggestion-${suggestionIndex}`}
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className={`h-auto max-w-full whitespace-normal rounded-full px-3 py-1 text-left text-sm leading-snug shadow-none ${
                                    themedSuggestionButtons
                                      ? THEMED_SUGGESTION_BUTTON_CLASS
                                      : SUGGESTION_BUTTON_HOVER_CLASS
                                  }`}
                                  style={themedSuggestionButtons ? suggestionThemeVars : undefined}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    onSuggestionSelect(suggestion, message.id)
                                  }}
                                >
                                  {ActionIcon ? <ActionIcon className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                                  {suggestion.text}
                                </Button>
                              ) : (
                                <div
                                  key={`${message.id}-suggestion-${suggestionIndex}`}
                                  className="flex items-center rounded-full border border-border bg-muted/40 px-3 py-1 text-sm leading-snug text-foreground"
                                  style={
                                    theme
                                      ? {
                                          background: theme.mutedBackground,
                                          borderColor: theme.panelBorder,
                                          color: theme.panelForeground,
                                        }
                                      : undefined
                                  }
                                >
                                  {ActionIcon ? <ActionIcon className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                                  {suggestion.text}
                                </div>
                              )
                            })}
                          </div>
                        ) : null
                      })()}
                      {message.status === 'streaming' ? null : (
                      <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                        <p style={theme ? { color: theme.mutedForeground } : undefined}>
                          {timeFormatter.format(new Date(message.createdAt))}
                        </p>
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100">
                          {message.content ? (
                            <MessageCopyButton content={message.content} theme={theme} />
                          ) : null}
                          {evalCaptureEnabled && conversationId && assistantMessageId ? (
                            <SendToEvalAction
                              conversationId={conversationId}
                              assistantMessageId={assistantMessageId}
                              userQueryPreview={(() => {
                                // Walk back to find the user message that triggered this assistant turn.
                                for (let i = index - 1; i >= 0; i--) {
                                  const m = messages[i]
                                  if (m?.role === 'user') return m.content
                                }
                                return undefined
                              })()}
                              originalAnswer={message.content}
                              className="inline-flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                            />
                          ) : null}
                          {canSubmitFeedback && assistantMessageId ? (
                            <>
                              <button
                                type="button"
                                className="group inline-flex size-5 items-center justify-center text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-50"
                                style={theme ? { color: theme.mutedForeground } : undefined}
                                disabled={pendingFeedbackId === assistantMessageId}
                                aria-pressed={feedbackState?.value === 'up'}
                                aria-label="Thumbs up"
                                onClick={() => void handleFeedbackClick(message, assistantMessageId, 'up')}
                              >
                                <ThumbsUp
                                  className={`size-3.5 fill-transparent group-hover:stroke-[#ffc720] ${feedbackState?.value === 'up' ? 'stroke-[#ffc720]' : ''}`}
                                />
                              </button>
                              <button
                                type="button"
                                className="group inline-flex size-5 items-center justify-center text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-50"
                                style={theme ? { color: theme.mutedForeground } : undefined}
                                disabled={pendingFeedbackId === assistantMessageId}
                                aria-pressed={feedbackState?.value === 'down'}
                                aria-label="Thumbs down"
                                onClick={() => void handleFeedbackClick(message, assistantMessageId, 'down')}
                              >
                                <ThumbsDown
                                  className={`size-3.5 fill-transparent group-hover:stroke-[#ffc720] ${feedbackState?.value === 'down' ? 'stroke-[#ffc720]' : ''}`}
                                />
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                      )}
                      {canSubmitFeedback && assistantMessageId ? (
                        <div className="flex flex-col gap-2 px-1">
                          {downvoteComposer?.assistantMessageId === assistantMessageId ? (
                            <div className="w-full max-w-md space-y-2 rounded-lg border border-border bg-background p-3">
                              <Textarea
                                value={downvoteComposer.comment}
                                maxLength={2000}
                                placeholder="Optional feedback"
                                className="min-h-20 resize-none text-sm"
                                onChange={(event) => {
                                  setDownvoteComposer({
                                    assistantMessageId,
                                    comment: event.target.value,
                                  })
                                }}
                              />
                              <div className="flex justify-end gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDownvoteComposer(null)}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={pendingFeedbackId === assistantMessageId}
                                  onClick={() => void submitFeedback({
                                    assistantMessageId,
                                    value: 'down',
                                    comment: downvoteComposer.comment,
                                  })}
                                >
                                  Save feedback
                                </Button>
                              </div>
                            </div>
                          ) : null}
                          {feedbackError[assistantMessageId] ? (
                            <p className="text-xs text-destructive">{feedbackError[assistantMessageId]}</p>
                          ) : null}
                        </div>
                      ) : null}
                      {!hideFeedbackEntries && feedbackEntries.length > 0 ? (
                        <div className="space-y-2 px-1">
                          {feedbackEntries.map((entry) => (
                            <div
                              key={entry.id}
                              className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                            >
                              <div className="flex items-center gap-2 text-foreground">
                                {entry.value === 'up' ? <ThumbsUp className="size-3.5" /> : <ThumbsDown className="size-3.5" />}
                                <span>{entry.value === 'up' ? 'Thumbs up' : 'Thumbs down'}</span>
                                <span className="text-muted-foreground">
                                  {entry.actorType === 'anonymous_user' ? 'Anonymous session' : entry.actorType === 'api_token' ? 'API token' : 'Signed-in user'}
                                </span>
                                <span className="text-muted-foreground">
                                  {timeFormatter.format(new Date(entry.updatedAt))}
                                </span>
                              </div>
                              {entry.comment ? (
                                <p className="mt-1 whitespace-pre-wrap text-foreground">{entry.comment}</p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
  }

  // Walk the thread, banding contiguous routine turns. `routineMarkers` is only
  // supplied by the diagnostics surface, so public chat/embed fall straight
  // through to a flat list of rendered messages.
  const threadContent: ReactNode[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const marker = routineMarkers?.[index]
    if (marker?.isGroupStart) {
      const groupNodes: ReactNode[] = []
      let end = index
      while (end < messages.length) {
        groupNodes.push(renderMessage(messages[end], end))
        if (routineMarkers?.[end]?.isGroupEnd) {
          break
        }
        end += 1
      }
      threadContent.push(
        <section
          key={`routine-band-${marker.groupKey ?? index}`}
          data-routine-band={marker.groupKey ?? undefined}
          className="space-y-4 border-y border-border/60 bg-muted/20 px-3 py-4"
        >
          <RoutineStartChip
            routineId={marker.routineId}
            routineName={marker.routineName}
            routineHref={marker.routineHref}
          />
          <div className="space-y-6">{groupNodes}</div>
          <RoutineEndMarker endState={routineMarkers?.[end]?.endState} />
        </section>,
      )
      index = end
      continue
    }
    threadContent.push(renderMessage(messages[index], index))
  }

  return (
    <div ref={threadRef} className="mx-auto max-w-3xl space-y-6">
      {threadContent}
    </div>
  )
}
