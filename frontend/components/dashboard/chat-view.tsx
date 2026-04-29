'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { FileText, RotateCcw, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { LogoSpinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { type CitationOpenResult } from './chat-citations'
import { documentsApi } from '@/lib/api'
import { useChatSession } from '@/lib/chat-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { useWorkspace } from '@/lib/workspace-context'
import { ChatMessageThread } from './chat-message-thread'

interface ChatViewProps {
  accountId: string
  onOpenDocument: (documentId: string) => void
  onboarding: WorkspaceOnboardingState
}

export function ChatView({ accountId, onOpenDocument, onboarding }: ChatViewProps) {
  const router = useRouter()
  const [input, setInput] = useState('')
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const { messages, isLoading, isInitialized, isBootstrapping, initializeSession, sendMessage, startNewChat } = useChatSession(activeWorkspaceId ?? accountId)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isInitializingView = (onboarding.isLoading || isBootstrapping || !isInitialized) && messages.length === 0

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [isLoading, messages])

  useEffect(() => {
    const userExpectedLocale =
      typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language : undefined

    void initializeSession(userExpectedLocale)
  }, [initializeSession])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading || isBootstrapping) return

    const nextInput = input.trim()
    setInput('')
    await sendMessage(nextInput, { method: 'typed' })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const handleStartNewChat = async () => {
    const userExpectedLocale =
      typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language : undefined

    setInput('')
    await startNewChat(userExpectedLocale)
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

  const handleSuggestionSelect = (text: string, messageId: string) => {
    if (isLoading || isBootstrapping) {
      return
    }

    void sendMessage(text, {
      method: 'suggestion_click',
      suggestionSourceMessageId: messageId,
    })
  }

  const emptyState = onboarding.hasPendingDocuments
    ? {
        title: 'Documents are still processing',
        description:
          'Radioso is preparing chunks and retrieval data. Give it a moment, then ask the first question.',
        primaryAction: (
          <Button
            size="sm"
            variant="outline"
            onClick={() => router.push(buildDashboardHref(accountId, {
              section: 'documents',
              workspaceId: activeWorkspaceId ?? undefined,
              workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
            }))}
          >
            <FileText className="mr-2 h-4 w-4" />
            Open documents
          </Button>
        ),
      }
    : onboarding.hasReadyDocuments
      ? {
          title: 'Your workspace is ready',
          description:
            'Ask a question about the content you loaded to see grounded answers and citations.',
          primaryAction: null,
        }
      : {
          title: 'Start with content first',
          description:
            'Add documents to this workspace before chatting. Starter docs are only used during the guided first-run flow.',
          primaryAction: (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                onClick={() => router.push(buildDashboardHref(accountId, {
                  section: 'documents',
                  workspaceId: activeWorkspaceId ?? undefined,
                  workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                }))}
              >
                <FileText className="mr-2 h-4 w-4" />
                Upload docs
              </Button>
            </div>
          ),
        }

  return (
    <DashboardPage
      title="Chat"
      description="Ask questions about your documents"
      actions={
        <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleStartNewChat()}
            disabled={isLoading || isBootstrapping || isInitializingView}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            New chat
          </Button>
      }
      footer={isInitializingView ? null : (
        <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl items-end gap-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            className="min-h-[44px] max-h-32 resize-none"
          />
          <Button type="submit" size="icon" className="h-[44px] w-[44px] shrink-0" disabled={isLoading || isBootstrapping || !input.trim()}>
            <Send className="w-4 h-4" />
            <span className="sr-only">Send message</span>
          </Button>
        </form>
      )}
    >
        {isInitializingView ? (
          <div className="flex h-full items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Send className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-lg font-medium text-foreground mb-1">{emptyState.title}</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              {emptyState.description}
            </p>
            {emptyState.primaryAction ? (
              <div className="mt-4">{emptyState.primaryAction}</div>
            ) : null}
          </div>
        ) : (
          <div>
            <ChatMessageThread
              messages={messages}
              onOpenDocument={handleOpenCitation}
              onSuggestionSelect={handleSuggestionSelect}
            />
            <div ref={messagesEndRef} />
          </div>
        )}
    </DashboardPage>
  )
}
