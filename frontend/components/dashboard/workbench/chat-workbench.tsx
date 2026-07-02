'use client'

import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { FileText, MoreHorizontal, RotateCcw, Send, Workflow } from 'lucide-react'
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { LogoSpinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { type CitationOpenResult } from '@/components/dashboard/chat-citations'
import {
  answerFeedbackApi,
  chatApi,
  documentsApi,
  type AnswerFeedbackState,
  type AnswerFeedbackValue,
  type ChatConversationTurn,
  type ChatSuggestion,
} from '@/lib/api'
import { type ChatMessage, useChatSession } from '@/lib/chat-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { editionController } from '@/lib/edition-controller'
import { type WorkspaceOnboardingState } from '@/lib/onboarding'
import { useSkillCatalog } from '@/lib/skill-catalog'
import { useRoutineCatalog } from '@/lib/routine-catalog'
import { getPrimaryLeafTrace, routineTurnSignalFromSpine } from '@/lib/turn-trace'
import { useWorkspace } from '@/lib/workspace-context'
import { ScrollToBottomButton } from '@/components/chat/scroll-to-bottom-button'
import { useChatScroll } from '@/hooks/use-chat-scroll'
import { ChatMessageThread } from '@/components/dashboard/chat-message-thread'
import { TurnFlowOverlay } from '@/components/dashboard/turn-flow-overlay'
import { TestSessionsView } from '@/components/dashboard/workbench/test-sessions-view'
import { cn } from '@/lib/utils'
import {
  CompactIdField,
  TurnDiagnosticsPanel,
  type TurnDiagnosticsInput,
} from '@/components/dashboard/turn-inspector/turn-diagnostics-panel'

export interface ChatWorkbenchProps {
  accountId: string
  agentId?: string
  assistantName?: string | null
  assistantLinkUtmEnabled?: boolean
  onOpenDocument: (documentId: string) => void
  onboarding: WorkspaceOnboardingState
  navigation?: ReactNode
  /** A forked test conversation to adopt into the live session on open (from "Continue in test chat"). */
  adoptConversationId?: string
}

/** Maps a persisted history turn into the live client message shape for adoption. */
function historyTurnToChatMessage(turn: ChatConversationTurn): ChatMessage {
  return {
    id: turn.id,
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: turn.content,
    createdAt: turn.createdAt,
    citations: turn.citations,
    answerSegments: turn.answerSegments,
    persistedAssistantMessageId: turn.role === 'assistant' ? turn.id : undefined,
    turnTrace: turn.debug?.turnTrace,
    activityTrace: turn.debug?.activityTrace,
    status: 'complete',
  }
}

/**
 * When the operator selects a user turn, diagnostics belong to the assistant turn
 * it produced — resolve forward to the next assistant message. Selecting an
 * assistant turn inspects it directly.
 */
function resolveDiagnosticsAssistant(messages: ChatMessage[], selectedId: string | null): ChatMessage | null {
  if (!selectedId) {
    return null
  }
  const index = messages.findIndex((message) => message.id === selectedId)
  if (index < 0) {
    return null
  }
  const selected = messages[index]
  if (selected.role === 'assistant') {
    return selected
  }
  return messages.slice(index + 1).find((message) => message.role === 'assistant') ?? null
}

/**
 * Maps a live client {@link ChatMessage} into the surface-neutral
 * {@link TurnDiagnosticsInput}. Live turns don't carry the history `debug`
 * wrapper (no route/answerOutcome/visitorContext); the turn-trace envelope and
 * its primary retrieval leaf drive the shared inspector, matching how the
 * history detail hook resolves the active trace.
 */
function buildLiveTurnDiagnostics(
  selected: ChatMessage | null,
  assistant: ChatMessage | null,
): TurnDiagnosticsInput | null {
  if (!selected) {
    return null
  }
  const envelope = assistant?.turnTrace
  return {
    messageId: selected.id,
    activityTrace: getPrimaryLeafTrace(envelope) ?? assistant?.activityTrace,
    turnTrace: envelope,
    errorMessage: assistant?.status === 'error' ? assistant.content : undefined,
  }
}

/**
 * Self-contained chat workbench: the live test chat plus a copyable conversation
 * id and a selectable turn inspector that slides out with the same diagnostics
 * the activity history drawer shows. Owns its own layout so it can render as the
 * dashboard page (default) or inside a drawer/sheet elsewhere.
 */
export function ChatWorkbench({
  accountId,
  agentId,
  assistantName,
  assistantLinkUtmEnabled,
  onOpenDocument,
  onboarding,
  adoptConversationId,
}: ChatWorkbenchProps) {
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
    adoptConversation,
    conversationId,
  } = useChatSession(chatSessionKey, agentId)
  const skillCatalog = useSkillCatalog(activeWorkspaceId)
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

  // Two workbench modes on one surface: the live test chat, and the test-session
  // history table (past operator test chats, excluded from Activity).
  const [mode, setMode] = useState<'chat' | 'history'>('chat')

  // Turn inspector: which message is being inspected, its resolved diagnostics,
  // the selected leaf stage (legacy inline graph), and the full-screen flow.
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(undefined)
  const [flowOpen, setFlowOpen] = useState(false)

  const isInitializingView = (onboarding.isLoading || isBootstrapping || !isInitialized) && messages.length === 0
  const visibleMessages = messages
  const { isAtBottom, scrollToLatestTurn } = useChatScroll({
    messages: visibleMessages,
    sentinelRef: messagesEndRef,
  })

  const selectedMessage = useMemo(
    () => (selectedMessageId ? messages.find((message) => message.id === selectedMessageId) ?? null : null),
    [messages, selectedMessageId],
  )
  const diagnosticsAssistant = useMemo(
    () => resolveDiagnosticsAssistant(messages, selectedMessageId),
    [messages, selectedMessageId],
  )
  const diagnostics = useMemo(
    () => buildLiveTurnDiagnostics(selectedMessage, diagnosticsAssistant),
    [selectedMessage, diagnosticsAssistant],
  )
  const activeEnvelope = diagnosticsAssistant?.turnTrace
  const inspectorOpen = selectedMessage !== null

  // The trace carries only the routine id; join its readable name from the
  // agent's routine catalog — fetched only while inspecting a routine turn.
  const routineAgentId = activeEnvelope && routineTurnSignalFromSpine(activeEnvelope.spine)
    ? agentId ?? null
    : null
  const routineNamesById = useRoutineCatalog(routineAgentId)

  useEffect(() => {
    const userExpectedLocale =
      typeof navigator !== 'undefined' ? navigator.languages?.[0] ?? navigator.language : undefined

    void initializeSession(userExpectedLocale)
  }, [initializeSession])

  // Adopt a forked test conversation into the live session (from "Continue in
  // test chat"). Load its thread once, seed the session, and land on Chat mode.
  const adoptedConversationRef = useRef<string | null>(null)
  useEffect(() => {
    if (!adoptConversationId || adoptedConversationRef.current === adoptConversationId) {
      return
    }
    adoptedConversationRef.current = adoptConversationId
    let cancelled = false
    void chatApi
      .getHistoryConversation(adoptConversationId)
      .then((detail) => {
        if (cancelled) {
          return
        }
        const seeded = detail.messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map(historyTurnToChatMessage)
        adoptConversation(adoptConversationId, seeded)
        setMode('chat')
      })
      .catch(() => {
        if (!cancelled) {
          // Allow a later retry if the load failed.
          adoptedConversationRef.current = null
        }
      })
    return () => {
      cancelled = true
    }
    // adoptConversation identity changes each render; depending on it would cancel
    // the in-flight load. The ref guard already prevents re-adopting the same id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptConversationId])

  // Reset the inspector's stage/flow selection whenever the inspected turn
  // changes so a new turn doesn't inherit a stale stage.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Switching inspected turns resets the selected stage.
    setSelectedStageId(undefined)
    setFlowOpen(false)
  }, [selectedMessageId])

  const closeInspector = () => {
    setSelectedMessageId(null)
    setFlowOpen(false)
  }

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
    closeInspector()
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
            'Send a message to see your agent answer — grounded in your data, with citations.',
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
    <>
      <DashboardPage
        title="Chat"
        description={`Test ${assistantName?.trim() || 'your agent'}`}
        actions={
          <div className="flex items-center gap-2">
            {mode === 'chat' && conversationId ? (
              <CompactIdField label="Conversation" value={conversationId} />
            ) : null}
            <div className="inline-flex items-center rounded-lg border border-input bg-input/30 p-0.5">
              {(['chat', 'history'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    if (value === 'history') {
                      closeInspector()
                    }
                    setMode(value)
                  }}
                  className={cn(
                    'rounded-md px-3 py-1 text-sm font-medium capitalize transition',
                    mode === value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {value === 'chat' ? 'Chat' : 'History'}
                </button>
              ))}
            </div>
            {mode === 'chat' ? (
              <>
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
              </>
            ) : null}
          </div>
        }
        footerClassName="relative"
        footer={isInitializingView || mode === 'history' ? null : (
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
          {mode === 'history' ? (
            <TestSessionsView agentId={agentId} />
          ) : isInitializingView ? (
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
                onMessageSelect={setSelectedMessageId}
                selectedMessageId={selectedMessageId ?? undefined}
                showCitations={showCitations}
                conversationId={conversationId}
                evalCaptureEnabled
                assistantAvatarLabel={assistantName ?? undefined}
                assistantLinkUtmEnabled={assistantLinkUtmEnabled}
                skillCatalog={skillCatalog}
              />
              <div ref={messagesEndRef} />
            </div>
          )}
      </DashboardPage>

      <Sheet open={inspectorOpen} onOpenChange={(open) => { if (!open) closeInspector() }}>
        <SheetContent side="right" className="w-[95vw] gap-0 p-0 sm:!max-w-[680px]">
          <SheetHeader className="flex-row items-center justify-between gap-3 border-b border-border py-3 pr-12">
            <SheetTitle className="text-sm font-medium">Turn diagnostics</SheetTitle>
            {activeEnvelope ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setFlowOpen(true)}
              >
                <Workflow className="h-3.5 w-3.5" />
                Flow
              </Button>
            ) : null}
          </SheetHeader>
          {/* Mirror the activity-history drawer's debug column exactly: the shared
              TurnDiagnosticsPanel inside the same bordered card, just without the
              conversation thread beside it. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="rounded-xl border border-border/70 bg-background/50 p-4">
              <TurnDiagnosticsPanel
                diagnostics={diagnostics}
                routineNamesById={routineNamesById}
                selectedStageId={selectedStageId}
                onSelectLeafStage={setSelectedStageId}
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {activeEnvelope ? (
        <TurnFlowOverlay
          key={activeEnvelope.spine.traceId}
          open={flowOpen}
          envelope={activeEnvelope}
          leafTrace={diagnostics?.activityTrace}
          onClose={() => setFlowOpen(false)}
          assistantMessageId={diagnosticsAssistant?.id}
        />
      ) : null}
    </>
  )
}
