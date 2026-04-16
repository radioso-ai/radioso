'use client'

import { useEffect, useRef, useState } from 'react'

import { AlertCircle, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ChatMessageThread } from '@/components/dashboard/chat-message-thread'
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
    const interval = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => window.clearInterval(interval)
  }, [retryAfterSeconds])

  if (remaining <= 0) return null

  return (
    <div className="mx-auto max-w-3xl rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
      {message} Try again in {remaining}s.
    </div>
  )
}

function PublicChatContent() {
  const [input, setInput] = useState('')
  const {
    messages,
    workspaceName,
    isLoading,
    isHydrating,
    isLoadingOlderMessages,
    isUnavailable,
    hasOlderMessages,
    rateLimitError,
    retryAfterSeconds,
    loadOlderMessages,
    sendMessage,
  } = useAnonymousChat()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [isLoading, messages])

  useEffect(() => {
    if (!workspaceName) {
      return
    }

    document.title = workspaceName
  }, [workspaceName])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!input.trim() || isLoading) return

    const nextInput = input.trim()
    setInput('')
    await sendMessage(nextInput)
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit(event)
    }
  }

  const handleSuggestionSelect = (text: string) => {
    if (isLoading) return
    void sendMessage(text)
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">{workspaceName}</h1>
        <p className="text-sm text-muted-foreground">Ask questions and get AI-powered answers</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Send className="h-5 w-5 text-primary" />
            </div>
            <h2 className="mb-1 text-lg font-medium text-foreground">Start a conversation</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Ask a question and get an AI-powered answer.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {hasOlderMessages ? (
              <div className="flex justify-center">
                <Button type="button" size="sm" variant="outline" onClick={() => void loadOlderMessages()} disabled={isLoadingOlderMessages}>
                  {isLoadingOlderMessages ? <Spinner className="mr-2 h-4 w-4" /> : null}
                  Load older messages
                </Button>
              </div>
            ) : null}
            <ChatMessageThread
              messages={messages}
              onOpenDocument={async () => 'unavailable'}
              onSuggestionSelect={handleSuggestionSelect}
            />
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
        <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl items-end gap-3">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            className="min-h-[44px] max-h-32 resize-none"
            disabled={isLoading}
          />
          <Button type="submit" size="icon" className="h-[44px] w-[44px] shrink-0" disabled={isLoading || !input.trim()}>
            <Send className="h-4 w-4" />
            <span className="sr-only">Send message</span>
          </Button>
        </form>
      </div>
    </div>
  )
}

export function PublicChatShell({ token }: { token: string }) {
  return (
    <AnonymousChatProvider token={token}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PublicChatContent />
      </div>
    </AnonymousChatProvider>
  )
}
