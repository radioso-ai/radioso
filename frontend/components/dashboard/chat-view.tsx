'use client'

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { Send } from 'lucide-react'
import { AssistantMessageContent, type CitationOpenResult, linkifyText } from './chat-citations'
import { documentsApi } from '@/lib/api'
import { useChatSession } from '@/lib/chat-context'
import { useWorkspace } from '@/lib/workspace-context'

interface ChatViewProps {
  accountId: string
  onOpenDocument: (documentId: string) => void
}

export function ChatView({ accountId, onOpenDocument }: ChatViewProps) {
  const [input, setInput] = useState('')
  const { activeWorkspaceId } = useWorkspace()
  const { messages, isLoading, sendMessage } = useChatSession(activeWorkspaceId ?? accountId)
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

  const handleOpenCitation = async (documentId: string): Promise<CitationOpenResult> => {
    try {
      await documentsApi.getDocument(documentId)
      onOpenDocument(documentId)
      return 'opened'
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'error' in error &&
        error.error &&
        typeof error.error === 'object' &&
        'code' in error.error &&
        error.error.code === 'not_found'
      ) {
        return 'unavailable'
      }

      return 'error'
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
                {message.role === 'user' ? (
                  <div className="max-w-[80%] rounded-lg bg-primary px-4 py-3 text-primary-foreground">
                    <p className="text-sm whitespace-pre-wrap">{linkifyText(message.content)}</p>
                  </div>
                ) : (
                  <div className="max-w-[80%] text-foreground">
                    {message.status === 'streaming' && !message.content ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <AssistantMessageContent
                        content={message.content}
                        citations={message.citations}
                        answerSegments={message.answerSegments}
                        source={message.source}
                        onOpenDocument={handleOpenCitation}
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
    </div>
  )
}
