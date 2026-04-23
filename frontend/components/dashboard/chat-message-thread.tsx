'use client'

import type { KeyboardEvent } from 'react'

import { ChatSuggestionGroups } from '@/components/chat/chat-suggestion-groups'
import { TypingIndicator } from '@/components/ui/typing-indicator'
import { AssistantMessageContent, type CitationOpenResult, linkifyText } from './chat-citations'
import type { AnswerSegment, ChatSuggestion, ChatUserInputMetadata, Citation } from '@/lib/api'

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
})

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})

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
}: {
  messages: ChatThreadMessage[]
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
  onSuggestionSelect?: (text: string, messageId: string) => void
  onMessageSelect?: (messageId: string) => void
  selectedMessageId?: string
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
                <div className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                  {currentDay}
                </div>
              </div>
            ) : null}

            <div className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] ${message.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
                {message.role === 'user' ? (
                  <div
                    {...getSelectableMessageProps(message.id)}
                    className={`rounded-lg border px-4 py-3 text-primary-foreground ${
                      selectedMessageId === message.id
                        ? 'border-white/90 bg-primary ring-1 ring-white/50'
                        : 'border-primary bg-primary'
                    } ${onMessageSelect ? 'cursor-pointer transition hover:border-white/80' : 'bg-primary'}`}
                  >
                    <p className="select-text whitespace-pre-wrap text-sm">{linkifyText(message.content)}</p>
                  </div>
                ) : (
                  <div
                    {...getSelectableMessageProps(message.id)}
                    className={`rounded-lg border bg-card px-4 py-3 text-left text-foreground ${
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
                        />
                      </div>
                    )}
                  </div>
                )}
                {message.role === 'assistant' ? (
                  <ChatSuggestionGroups
                    messageId={message.id}
                    suggestions={message.suggestions}
                    onSuggestionSelect={onSuggestionSelect}
                  />
                ) : null}
                <p className="px-1 text-xs text-muted-foreground">
                  {timeFormatter.format(new Date(message.createdAt))}
                </p>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
