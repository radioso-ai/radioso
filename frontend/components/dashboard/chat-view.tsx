'use client'

import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { FileText, MoreHorizontal, RotateCcw, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LogoSpinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { type CitationOpenResult } from './chat-citations'
import {
  answerFeedbackApi,
  documentsApi,
  type AnswerFeedbackState,
  type AnswerFeedbackValue,
  type ChatSuggestion,
} from '@/lib/api'
import { useChatSession } from '@/lib/chat-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { editionController } from '@/lib/edition-controller'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { useWorkspace } from '@/lib/workspace-context'
import { ScrollToBottomButton } from '@/components/chat/scroll-to-bottom-button'
import { useChatScroll } from '@/hooks/use-chat-scroll'
import { ChatMessageThread } from './chat-message-thread'

interface ChatViewProps {
  accountId: string
  agentId?: string
  onOpenDocument: (documentId: string) => void
  onboarding: WorkspaceOnboardingState
  navigation?: ReactNode
}

export function ChatView({ accountId, agentId, onOpenDocument, onboarding, navigation }: ChatViewProps) {
  const router = useRouter()
  const [input, setInput] = useState('')
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const chatSessionKey = `agent-chat:v3:${activeWorkspaceId ?? accountId}:${agentId ?? 'default-agent'}`
  const {
    messages,
    isLoading,
    isInitialized,
    isBootstrapping,
    initializeSession,
    sendMessage,
    startNewChat,
    conversationId,
  } = useChatSession(chatSessionKey, agentId)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [showCitations, setShowCitations] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return true
    }
    return window.localStorage.getItem('chat:showCitations') !== 'false'
  })
  const updateShowCitations = (next: boolean) => {
    setShowCitations(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('chat:showCitations', String(next))
    }
  }
  const isInitializingView = (onboarding.isLoading || isBootstrapping || !isInitialized) && messages.length === 0
  const visibleMessages = messages
  const { isAtBottom, scrollToLatestTurn } = useChatScroll({
    messages: visibleMessages,
    sentinelRef: messagesEndRef,
  })

  useEffect(() => {
    const userExpectedLocale =
      typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language : undefined

    void initializeSession(userExpectedLocale)
  }, [initializeSession])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading || isBootstrapping) return

    const nextInput = input.trim()
    setInput('')
    await sendMessage(nextInput, { method: 'typed' })
  }

  const handleKeyDown = (e: KeyboardEvent) => {
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

  const handleSuggestionSelect = (suggestion: ChatSuggestion, messageId: string) => {
    if (isLoading || isBootstrapping) {
      return
    }

    if (suggestion.action?.kind === 'start_intent') {
      void sendMessage(suggestion.text, {
        method: 'intent_click',
        intent: suggestion.action.intent,
        suggestionSourceMessageId: messageId,
      })
      return
    }

    void sendMessage(suggestion.text, {
      method: 'suggestion_click',
      suggestionSourceMessageId: messageId,
    })
  }

  const handleAnswerFeedback = async (input: {
    assistantMessageId: string
    value: AnswerFeedbackValue
    comment?: string | null
  }): Promise<AnswerFeedbackState> => {
    const feedback = await answerFeedbackApi.submit(input)
    return { value: feedback.value, comment: feedback.comment }
  }

  const handleClearAnswerFeedback = async (assistantMessageId: string) => {
    await answerFeedbackApi.clear(assistantMessageId)
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
              section: 'knowledge',
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
                  section: 'knowledge',
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
      actions={navigation}
      headerContent={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon" variant="outline" aria-label="Chat options">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuCheckboxItem
              checked={showCitations}
              onCheckedChange={(checked) => updateShowCitations(checked === true)}
            >
              Show citations
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isLoading || isBootstrapping || isInitializingView}
              onSelect={() => {
                void handleStartNewChat()
              }}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Clear chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      footerClassName="relative"
      footer={isInitializingView ? null : (
        <>
          {!isAtBottom && messages.length > 0 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 px-4">
              <div className="mx-auto flex max-w-3xl justify-end">
                <ScrollToBottomButton onClick={() => scrollToLatestTurn()} />
              </div>
            </div>
          ) : null}
          <form onSubmit={handleSubmit} className="mx-auto max-w-3xl">
            <div className="flex items-end gap-1 rounded-3xl border border-input bg-input/40 px-2 py-1.5 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question..."
                className="min-h-[36px] max-h-32 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
              />
              <Button type="submit" size="icon" className="h-9 w-9 shrink-0 rounded-full" disabled={isLoading || isBootstrapping || !input.trim()}>
                <Send className="w-4 h-4" />
                <span className="sr-only">Send message</span>
              </Button>
            </div>
          </form>
        </>
      )}
    >
        {isInitializingView ? (
          <div className="flex h-full items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </div>
        ) : visibleMessages.length === 0 ? (
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
              messages={visibleMessages}
              onOpenDocument={handleOpenCitation}
              onSuggestionSelect={handleSuggestionSelect}
              onAnswerFeedback={editionController.canUseAssistantAnswerFeedback() ? handleAnswerFeedback : undefined}
              onClearAnswerFeedback={editionController.canUseAssistantAnswerFeedback() ? handleClearAnswerFeedback : undefined}
              showCitations={showCitations}
              conversationId={conversationId}
            />
            <div ref={messagesEndRef} />
          </div>
        )}
    </DashboardPage>
  )
}
