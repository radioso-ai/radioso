'use client'

import { useState, type CSSProperties, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { TypingIndicator } from '@/components/ui/typing-indicator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Sparkles, ThumbsDown, ThumbsUp, UserRound } from 'lucide-react'
import type { WebsiteEmbedTheme } from '@/lib/embed-widget'
import { editionController } from '@/lib/edition-controller'
import { AssistantMessageContent, type CitationOpenResult, linkifyText } from './chat-citations'
import type {
  AnswerFeedbackEntry,
  AnswerFeedbackState,
  AnswerFeedbackValue,
  AnswerSegment,
  ChatSuggestion,
  ChatUserInputMetadata,
  Citation,
} from '@/lib/api'

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
})

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})

const SUGGESTION_HOVER_BACKGROUND = '#ffc720'
const SUGGESTION_HOVER_FOREGROUND = '#142317'

export interface ChatThreadMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
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
}

type FeedbackHandler = (input: {
  assistantMessageId: string
  value: AnswerFeedbackValue
  comment?: string | null
}) => Promise<AnswerFeedbackState | void> | AnswerFeedbackState | void

export function ChatMessageThread({
  messages,
  onOpenDocument,
  onSuggestionSelect,
  onMessageSelect,
  selectedMessageId,
  assistantAvatarUrl,
  assistantAvatarLabel,
  hideAssistantAvatar = false,
  theme,
  themedSuggestionButtons = false,
  onAnswerFeedback,
  onClearAnswerFeedback,
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
  hideAssistantAvatar?: boolean
  theme?: WebsiteEmbedTheme | null
  themedSuggestionButtons?: boolean
}) {
  const [localFeedback, setLocalFeedback] = useState<Record<string, AnswerFeedbackState | null | undefined>>({})
  const [pendingFeedbackId, setPendingFeedbackId] = useState<string | null>(null)
  const [feedbackError, setFeedbackError] = useState<Record<string, string | undefined>>({})
  const [downvoteComposer, setDownvoteComposer] = useState<{
    assistantMessageId: string
    comment: string
  } | null>(null)

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

  const suggestionThemeVars = theme
    ? ({
        '--suggestion-bg': theme.mutedBackground,
        '--suggestion-border': theme.panelBorder,
        '--suggestion-fg': theme.panelForeground,
        '--suggestion-hover-bg': SUGGESTION_HOVER_BACKGROUND,
        '--suggestion-hover-border': SUGGESTION_HOVER_BACKGROUND,
        '--suggestion-hover-fg': SUGGESTION_HOVER_FOREGROUND,
      } as CSSProperties)
    : undefined

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {messages.map((message, index) => {
        const currentDay = dayFormatter.format(new Date(message.createdAt))
        const previousDay =
          index > 0 ? dayFormatter.format(new Date(messages[index - 1].createdAt)) : null
        const showDayDivider = currentDay !== previousDay
        const assistantMessageId = message.role === 'assistant'
          ? message.persistedAssistantMessageId ?? null
          : null
        const feedbackState = assistantMessageId ? getFeedbackState(message, assistantMessageId) : undefined
        const feedbackEntries = message.answerFeedbackEntries ?? []
        const canSubmitFeedback =
          Boolean(onAnswerFeedback && onClearAnswerFeedback && assistantMessageId) &&
          message.role === 'assistant' &&
          message.status !== 'streaming'

        return (
          <div key={message.id} className="space-y-2">
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
                      className={`rounded-lg border px-4 py-3 text-primary-foreground ${
                        selectedMessageId === message.id
                          ? 'border-white/90 bg-primary ring-1 ring-white/50'
                          : 'border-primary bg-primary'
                      } ${onMessageSelect ? 'cursor-pointer transition hover:border-white/80' : 'bg-primary'}`}
                      style={
                        theme
                          ? {
                              background: theme.userBubbleBackground,
                              borderColor: theme.userBubbleBackground,
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
                  <div className="flex w-full items-start gap-3">
                    {!hideAssistantAvatar && (assistantAvatarUrl || assistantAvatarLabel) ? (
                      <Avatar
                        className="mt-0.5 size-8 border"
                        style={{
                          borderColor: theme?.panelBorder,
                          background: theme?.mutedBackground,
                          color: theme?.accent,
                        }}
                      >
                        {assistantAvatarUrl ? (
                          <AvatarImage src={assistantAvatarUrl} alt={assistantAvatarLabel ?? 'Assistant avatar'} />
                        ) : null}
                        <AvatarFallback
                          style={{
                            background: theme?.mutedBackground,
                            color: theme?.accent,
                          }}
                        >
                          <Sparkles className="size-4" />
                        </AvatarFallback>
                      </Avatar>
                    ) : null}
                    <div className="min-w-0 flex-1 flex flex-col gap-2">
                      <div
                        {...getSelectableMessageProps(message.id)}
                        className={`self-start w-fit max-w-full rounded-lg border bg-card px-4 py-3 text-left text-foreground ${
                          selectedMessageId === message.id
                            ? 'border-primary/70 ring-1 ring-primary/60'
                            : 'border-border'
                        } ${
                          onMessageSelect && message.role === 'assistant'
                            ? 'cursor-pointer transition hover:border-primary/40'
                            : onMessageSelect
                              ? 'cursor-pointer transition hover:border-primary/40'
                              : ''
                        }`}
                        style={
                          theme
                            ? {
                                background: theme.assistantBubbleBackground,
                                borderColor:
                                  selectedMessageId === message.id ? theme.accent : theme.panelBorder,
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
                              theme={theme}
                            />
                          </div>
                        )}
                      </div>
                      {(() => {
                        const visibleSuggestions = editionController.filterChatSuggestions(message.suggestions)
                        return visibleSuggestions.length > 0 ? (
                          <div className="w-full">
                            <div className="flex w-full flex-col gap-2">
                              {visibleSuggestions
                                .filter((suggestion) => suggestion.text.trim())
                                .map((suggestion, suggestionIndex) => {
                                const isContactAction = suggestion.action?.kind === 'contact_human'
                                return onSuggestionSelect ? (
                                  <Button
                                    key={`${message.id}-suggestion-${suggestionIndex}`}
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className={`h-auto w-full justify-start whitespace-normal rounded-lg px-4 py-3 text-left text-base leading-5 shadow-none ${
                                      themedSuggestionButtons
                                        ? 'border-[var(--suggestion-border)] bg-[var(--suggestion-bg)] text-[var(--suggestion-fg)] transition-colors hover:border-[var(--suggestion-hover-border)] hover:bg-[var(--suggestion-hover-bg)] hover:text-[var(--suggestion-hover-fg)]'
                                        : ''
                                    }`}
                                    style={themedSuggestionButtons ? suggestionThemeVars : undefined}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      onSuggestionSelect(suggestion, message.id)
                                    }}
                                  >
                                    {isContactAction ? <UserRound className="mr-2 h-4 w-4 shrink-0" /> : null}
                                    {suggestion.text}
                                  </Button>
                                ) : (
                                  <div
                                    key={`${message.id}-suggestion-${suggestionIndex}`}
                                    className="w-full rounded-lg border border-border bg-muted/40 px-4 py-3 text-base leading-5 text-foreground"
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
                                    {suggestion.text}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : null
                      })()}
                      <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                        <p style={theme ? { color: theme.mutedForeground } : undefined}>
                          {timeFormatter.format(new Date(message.createdAt))}
                        </p>
                        {canSubmitFeedback && assistantMessageId ? (
                          <div className="flex items-center gap-0.5">
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
                          </div>
                        ) : null}
                      </div>
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
                      {feedbackEntries.length > 0 ? (
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
      })}
    </div>
  )
}
