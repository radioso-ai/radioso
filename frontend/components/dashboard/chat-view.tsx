'use client'

import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { FileText, MoreHorizontal, RotateCcw, Send, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LogoSpinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { type CitationOpenResult } from './chat-citations'
import { documentsApi, humanContactApi, type ChatSuggestion, type HumanContactTriggerSource } from '@/lib/api'
import { useChatSession } from '@/lib/chat-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { HUMAN_CONTACT_REQUEST_TRIGGER_REASON, isHumanContactRequest } from '@/lib/human-contact-intent'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { useWorkspace } from '@/lib/workspace-context'
import {
  HumanContactInlineComposer,
  type HumanContactInlineRequest,
} from '@/components/chat/human-contact-inline-composer'
import { ChatMessageThread, type ChatThreadMessage } from './chat-message-thread'

interface ChatViewProps {
  accountId: string
  onOpenDocument: (documentId: string) => void
  onboarding: WorkspaceOnboardingState
  navigation?: ReactNode
}

export function ChatView({ accountId, onOpenDocument, onboarding, navigation }: ChatViewProps) {
  const router = useRouter()
  const [input, setInput] = useState('')
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const { conversationId, messages, isLoading, isInitialized, isBootstrapping, initializeSession, sendMessage, startNewChat } = useChatSession(activeWorkspaceId ?? accountId)
  const [contactAvailable, setContactAvailable] = useState(false)
  const [contactRequest, setContactRequest] = useState<HumanContactInlineRequest | null>(null)
  const [contactConfirmation, setContactConfirmation] = useState<ChatThreadMessage | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isInitializingView = (onboarding.isLoading || isBootstrapping || !isInitialized) && messages.length === 0
  const visibleMessages = contactConfirmation ? [...messages, contactConfirmation] : messages

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [contactConfirmation, isLoading, messages])

  useEffect(() => {
    const userExpectedLocale =
      typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language : undefined

    void initializeSession(userExpectedLocale)
  }, [initializeSession])

  useEffect(() => {
    let active = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Workspace changes must clear stale Enterprise-only contact availability before probing the current workspace.
    setContactAvailable(false)

    const loadContactAvailability = async () => {
      try {
        const settings = await humanContactApi.getSettings()
        if (active) {
          setContactAvailable(settings.configured)
        }
      } catch {
        if (active) {
          setContactAvailable(false)
        }
      }
    }

    if (activeWorkspaceId) {
      void loadContactAvailability()
    }

    return () => {
      active = false
    }
  }, [activeWorkspaceId])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading || isBootstrapping) return

    const nextInput = input.trim()
    if (contactAvailable && latestAssistantMessage && isHumanContactRequest(nextInput)) {
      setInput('')
      openContactComposer({
        assistantMessageId: latestAssistantMessage.id,
        triggerSource: 'explicit_user_request',
        triggerReason: HUMAN_CONTACT_REQUEST_TRIGGER_REASON,
      })
      return
    }

    setInput('')
    setContactConfirmation(null)
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
    setContactRequest(null)
    setContactConfirmation(null)
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

  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')

  const openContactComposer = (input: {
    assistantMessageId?: string
    triggerSource: HumanContactTriggerSource
    triggerReason?: string
  }) => {
    if (!conversationId || !latestAssistantMessage) {
      return
    }

    setContactConfirmation(null)
    setContactRequest({
      conversationId,
      assistantMessageId: input.assistantMessageId ?? latestAssistantMessage.id,
      triggerSource: input.triggerSource,
      triggerReason: input.triggerReason,
    })
  }

  const handleManualContact = () => {
    if (!latestAssistantMessage) {
      return
    }
    openContactComposer({
      assistantMessageId: latestAssistantMessage.id,
      triggerSource: 'manual',
    })
  }

  const handleSuggestionSelect = (suggestion: ChatSuggestion, messageId: string) => {
    if (isLoading || isBootstrapping) {
      return
    }

    if (suggestion.action?.kind === 'contact_human') {
      const payload = suggestion.action.payload ?? {}
      const triggerSource = typeof payload.triggerSource === 'string'
        ? payload.triggerSource as HumanContactTriggerSource
        : 'assistant_suggestion'
      const assistantMessageId = typeof payload.assistantMessageId === 'string'
        ? payload.assistantMessageId
        : messageId
      const triggerReason = typeof payload.triggerReason === 'string' ? payload.triggerReason : undefined
      openContactComposer({ assistantMessageId, triggerSource, triggerReason })
      return
    }

    void sendMessage(suggestion.text, {
      method: 'suggestion_click',
      suggestionSourceMessageId: messageId,
    })
  }

  const handleContactSubmitted = (content: string) => {
    setContactRequest(null)
    setContactConfirmation({
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      status: 'complete',
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
            <DropdownMenuItem
              disabled={isLoading || isBootstrapping || isInitializingView}
              onSelect={() => {
                void handleStartNewChat()
              }}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Clear chat
            </DropdownMenuItem>
            {contactAvailable ? (
              <DropdownMenuItem
                disabled={isLoading || isBootstrapping || isInitializingView || !latestAssistantMessage}
                onSelect={handleManualContact}
              >
                <UserRound className="mr-2 h-4 w-4" />
                Talk to a human
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      }
      footer={isInitializingView ? null : contactRequest ? (
        <HumanContactInlineComposer
          request={contactRequest}
          onCancel={() => setContactRequest(null)}
          onSubmitted={handleContactSubmitted}
        />
      ) : (
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
            />
            <div ref={messagesEndRef} />
          </div>
        )}
    </DashboardPage>
  )
}
