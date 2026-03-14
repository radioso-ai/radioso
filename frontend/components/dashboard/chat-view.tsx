'use client'

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { Send } from 'lucide-react'
import { AssistantMessageContent } from './chat-citations'
import { useChatSession } from '@/lib/chat-context'

interface ChatViewProps {
  accountId: string
  onOpenDocument: (documentId: string) => void
}

export function ChatView({ accountId, onOpenDocument }: ChatViewProps) {
  const [input, setInput] = useState('')
  const { messages, isLoading, sendMessage } = useChatSession(accountId)
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">Chat</h1>
        <p className="text-sm text-muted-foreground">Ask questions about your documents</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Send className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-lg font-medium text-foreground mb-1">Start a conversation</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Ask questions about your uploaded documents and get AI-powered answers with citations.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-3 ${
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {message.role === 'assistant' ? (
                    message.status === 'streaming' && !message.content ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <AssistantMessageContent
                        content={message.content}
                        citations={message.citations}
                        answerSegments={message.answerSegments}
                        onOpenDocument={onOpenDocument}
                      />
                    )
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            className="min-h-[44px] max-h-32 resize-none"
            disabled={isLoading}
          />
          <Button type="submit" size="icon" disabled={isLoading || !input.trim()}>
            <Send className="w-4 h-4" />
            <span className="sr-only">Send message</span>
          </Button>
        </form>
      </div>
    </div>
  )
}
