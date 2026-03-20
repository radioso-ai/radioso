'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { Send, AlertCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { TypingIndicator } from '@/components/ui/typing-indicator'
import { AssistantMessageContent, linkifyText } from '@/components/dashboard/chat-citations'
import { AnonymousChatProvider, useAnonymousChat } from '@/lib/anonymous-chat-context'

function ChatUnavailable() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <AlertCircle className="h-5 w-5 text-muted-foreground" />
      </div>
      <h1 className="text-lg font-medium text-foreground">Chat Unavailable</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        This chat link is no longer active. Please contact the workspace administrator for access.
      </p>
    </div>
  )
}

function RateLimitBanner({ message, retryAfterSeconds }: { message: string; retryAfterSeconds: number }) {
  const [remaining, setRemaining] = useState(retryAfterSeconds)

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [retryAfterSeconds])

  if (remaining <= 0) return null

  return (
    <div className="mx-auto max-w-3xl rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
      {message} Try again in {remaining}s.
    </div>
  )
}

function AnonymousChatContent() {
  const [input, setInput] = useState('')
  const {
    messages,
    isLoading,
    isHydrating,
    isUnavailable,
    rateLimitError,
    retryAfterSeconds,
    sendMessage,
  } = useAnonymousChat()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [isLoading, messages])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading) return
    const nextInput = input.trim()
    setInput('')
    await sendMessage(nextInput)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  if (isHydrating) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (isUnavailable) {
    return <ChatUnavailable />
  }

  return (
    <>
      <div className="shrink-0 border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">Chat</h1>
        <p className="text-sm text-muted-foreground">Ask questions and get AI-powered answers</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Send className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-lg font-medium text-foreground mb-1">Start a conversation</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Ask a question and get an AI-powered answer.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {message.role === 'user' ? (
                  <div className="max-w-[80%] rounded-lg bg-primary px-4 py-3 text-primary-foreground">
                    <p className="text-sm whitespace-pre-wrap">{linkifyText(message.content)}</p>
                  </div>
                ) : (
                  <div className="max-w-[80%] rounded-lg border border-border bg-card px-4 py-3 text-foreground">
                    {message.status === 'streaming' && !message.content ? (
                      <TypingIndicator />
                    ) : (
                      <AssistantMessageContent
                        content={message.content}
                        citations={message.citations}
                        answerSegments={message.answerSegments}
                        onOpenDocument={async () => 'unavailable'}
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {rateLimitError && retryAfterSeconds ? (
        <div className="shrink-0 px-4 pb-2">
          <RateLimitBanner
            key={retryAfterSeconds}
            message={rateLimitError}
            retryAfterSeconds={retryAfterSeconds}
          />
        </div>
      ) : null}

      <div className="shrink-0 border-t border-border bg-background p-4">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex items-end gap-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            className="min-h-[44px] max-h-32 resize-none"
            disabled={isLoading}
          />
          <Button type="submit" size="icon" className="h-[44px] w-[44px] shrink-0" disabled={isLoading || !input.trim()}>
            <Send className="w-4 h-4" />
            <span className="sr-only">Send message</span>
          </Button>
        </form>
      </div>
    </>
  )
}

function PublicChatPageInner({ token }: { token: string }) {
  return (
    <AnonymousChatProvider token={token}>
      <AnonymousChatContent />
    </AnonymousChatProvider>
  )
}

export default function PublicChatPage() {
  const params = useParams()
  const token = params.token as string

  return <PublicChatPageInner token={token} />
}
