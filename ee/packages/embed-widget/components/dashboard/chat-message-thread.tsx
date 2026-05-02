'use client'

import type { CSSProperties, KeyboardEvent } from 'react'

import { Button } from '../ui/button'
import { TypingIndicator } from '../ui/typing-indicator'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'
import { Sparkles } from 'lucide-react'
import type { WebsiteEmbedTheme } from '../../lib/embed-widget'
import { AssistantMessageContent, type CitationOpenResult, linkifyText } from './chat-citations'
import type {
  AnswerSegment,
  ChatSuggestion,
  ChatUserInputMetadata,
  Citation,
} from '../../lib/api'

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
  status?: 'streaming' | 'done' | 'complete' | 'error'
}

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
}: {
  messages: ChatThreadMessage[]
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
  onSuggestionSelect?: (text: string, messageId: string) => void
  onMessageSelect?: (messageId: string) => void
  selectedMessageId?: string
  assistantAvatarUrl?: string | null
  assistantAvatarLabel?: string
  hideAssistantAvatar?: boolean
  theme?: WebsiteEmbedTheme | null
  themedSuggestionButtons?: boolean
}) {
  const handleSelectMessage = (messageId: string) => {
    const selection = typeof window !== 'undefined' ? window.getSelection()?.toString().trim() : ''
    if (selection) {
      return
    }

    onMessageSelect?.(messageId)
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
                      {message.suggestions && message.suggestions.length > 0 ? (
                        <div className="w-full">
                          <div className="flex w-full flex-col gap-2">
                            {message.suggestions
                              .filter((suggestion) => suggestion.text.trim())
                              .map((suggestion, suggestionIndex) =>
                                onSuggestionSelect ? (
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
                                      onSuggestionSelect(suggestion.text, message.id)
                                    }}
                                  >
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
                                ),
                              )}
                          </div>
                        </div>
                      ) : null}
                      <p
                        className="px-1 text-xs text-muted-foreground"
                        style={theme ? { color: theme.mutedForeground } : undefined}
                      >
                        {timeFormatter.format(new Date(message.createdAt))}
                      </p>
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
