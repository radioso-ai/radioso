'use client'

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { ChevronDown, ExternalLink, MessageSquare, MoreHorizontal, Plus, Trash2, Wrench } from 'lucide-react'

import { ChatComposer } from '@/components/chat/chat-composer'
import { ChatTurn } from '@/components/chat/chat-turn'
import { AssistantAvatar } from '@/components/chat/public-chat-bubble-view'
import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'
import { CopilotProposalCard } from './copilot-proposal-card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  buildCopilotPageContext,
  copilotApi,
  isCopilotApiErrorStatus,
  type CopilotActivityEvent,
  type CopilotAvailability,
  type CopilotConversationDetail,
  type CopilotConversationSummary,
  type CopilotEntityReference,
  type CopilotOutcomeStatus,
  type CopilotProposalEvent,
  type CopilotProposalSummary,
} from '@/lib/api-copilot'
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import {
  resolveCopilotEntityLabel,
  deriveCopilotSuggestedQuestions,
  useCopilotContext,
  type CopilotEntity,
  type CopilotLocalMessage,
} from '@/lib/copilot-context'
import { RAY_AVATAR_URL, RAY_NAME } from '@/lib/ray'
import { relativeTimestamp } from '@/lib/relative-time'
import { useChatScroll } from '@/hooks/use-chat-scroll'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/lib/workspace-context'

const PAGE_VIEW_LABELS: Record<string, string> = {
  activity: 'Activity',
  history: 'Conversation history',
  agent: 'Agent',
  documents: 'Documents',
  workbench: 'Workbench',
  quality: 'Quality',
  evals: 'Evals',
  copilot: RAY_NAME,
  other: 'Dashboard',
}

const outcomeLabel = (outcome: CopilotOutcomeStatus) => {
  if (outcome === 'budget_exhausted') return 'Budget exhausted'
  if (outcome === 'failed') return 'Turn failed'
  return 'Completed'
}

const messageFromDetail = (detail: CopilotConversationDetail): CopilotLocalMessage[] => detail.messages.map((message) => (
  message.role === 'copilot' ? { ...message, proposals: message.proposals ?? [] } : message
))

function ActivityLines({ activities, live = false }: { activities: CopilotActivityEvent[]; live?: boolean }) {
  const [expanded, setExpanded] = useState(live)
  const [prevLive, setPrevLive] = useState(live)
  if (live !== prevLive) {
    setPrevLive(live)
    if (!live) setExpanded(false)
  }
  if (activities.length === 0) return null

  if (!expanded) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-3 py-1 text-xs text-muted-foreground hover:bg-muted/50"
        onClick={() => setExpanded(true)}
      >
        Looked at {activities.length} {activities.length === 1 ? 'source' : 'sources'}
        <ChevronDown className="size-3 shrink-0" aria-hidden />
      </button>
    )
  }

  return (
    <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/20 p-3" aria-label="Ray activity">
      {activities.map((activity, index) => (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" key={`${activity.toolCallId}-${index}`}>
          <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{activity.tool}</span>
          {activity.stage === 'started' ? (
            <span className="flex size-2 shrink-0" aria-label="In progress">
              <span className="size-2 rounded-full bg-secondary animate-pulse" aria-hidden />
            </span>
          ) : (
            <span className={activity.stage === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{activity.stage}</span>
          )}
        </div>
      ))}
      <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setExpanded(false)}>
        Collapse activity
      </button>
      {live ? <p className="sr-only" role="status">Ray is running</p> : null}
    </div>
  )
}

function EntityChips({
  activities,
  entities,
  onOpen,
}: {
  activities: CopilotActivityEvent[]
  entities: readonly CopilotEntity[]
  onOpen: (entity: CopilotEntityReference) => void
}) {
  const linked = activities
    .map((activity) => activity.entity)
    .filter((entity): entity is CopilotEntityReference => Boolean(entity))
    .filter((entity, index, all) => all.findIndex((candidate) => candidate.type === entity.type && candidate.id === entity.id) === index)
  if (linked.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Read during this turn">
      <span className="text-xs text-muted-foreground">Read during this turn</span>
      {linked.map((entity) => (
        <button
          type="button"
          key={`${entity.type}:${entity.id}`}
          className="rounded-full border border-border px-2.5 py-1 text-xs hover:border-primary/60 hover:text-primary"
          onClick={() => onOpen(entity)}
        >
          {resolveCopilotEntityLabel(entities, entity.type, entity.id)}
        </button>
      ))}
    </div>
  )
}

function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onNew,
}: {
  conversations: CopilotConversationSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <aside className="flex min-h-0 w-full flex-col border-b border-border md:w-64 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <h2 className="text-sm font-medium">Conversations</h2>
        <Button type="button" variant="ghost" size="icon" onClick={onNew} aria-label="New Ray conversation">
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">Your Ray conversations appear here.</p>
        ) : (
          <div className="space-y-1">
            {conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                onClick={() => onSelect(conversation.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${selectedId === conversation.id ? 'bg-muted font-medium' : ''}`}
              >
                <span className="block truncate">{conversation.title || 'Untitled conversation'}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {conversation.status === 'running' ? 'Running' : relativeTimestamp(conversation.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function ContextDetails({
  pageContext,
  entities,
}: {
  pageContext: ReturnType<typeof buildCopilotPageContext>
  entities: readonly CopilotEntity[]
}) {
  return (
    <dl className="space-y-3 text-sm">
      <div><dt className="text-xs text-muted-foreground">View</dt><dd>{pageContext.view ? PAGE_VIEW_LABELS[pageContext.view] : 'None'}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Agent</dt><dd className="truncate">{pageContext.agentId ? resolveCopilotEntityLabel(entities, 'agent', pageContext.agentId) : 'Not selected'}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Customer conversation</dt><dd className="truncate">{pageContext.conversationId ? resolveCopilotEntityLabel(entities, 'conversation', pageContext.conversationId) : 'Not selected'}</dd></div>
      {entities.length > 0 ? <div><dt className="text-xs text-muted-foreground">On this screen</dt><dd className="mt-1 space-y-1">{entities.slice(0, 5).map((entity) => <div key={`${entity.type}:${entity.id}`} className="truncate">{entity.label}</div>)}</dd></div> : null}
    </dl>
  )
}

function ContextChip({
  pageContext,
  entities,
}: {
  pageContext: ReturnType<typeof buildCopilotPageContext>
  entities: readonly CopilotEntity[]
}) {
  const view = pageContext.view ? PAGE_VIEW_LABELS[pageContext.view] : null
  const agent = pageContext.agentId ? resolveCopilotEntityLabel(entities, 'agent', pageContext.agentId) : null
  const summary = Array.from(new Set([view, agent].filter((part): part is string => Boolean(part)))).join(' · ')

  return (
    <Collapsible className="rounded-md bg-muted/40">
      <CollapsibleTrigger className="flex h-8 w-full items-center justify-between gap-3 px-3 text-left text-xs text-muted-foreground hover:bg-muted/60">
        <span className="truncate">Looking at: {summary || 'this screen'}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border px-3 py-3">
        <ContextDetails pageContext={pageContext} entities={entities} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function SuggestedQuestions({
  view,
  entities,
  onSelect,
}: {
  view: string | null
  entities: readonly CopilotEntity[]
  onSelect: (question: string) => void
}) {
  const questions = deriveCopilotSuggestedQuestions(view, entities)

  return (
    <div className="mt-5 flex flex-wrap justify-center gap-2">
      {questions.map((question) => (
        <button type="button" key={question} className="rounded-full border border-border px-3 py-1.5 text-xs hover:border-primary/60 hover:text-primary" onClick={() => onSelect(question)}>
          {question}
        </button>
      ))}
    </div>
  )
}

export function CopilotChatSurface({
  accountId,
  routeState,
  initialAvailability,
  mode,
  panelHeaderSlot,
}: {
  accountId: string
  routeState: DashboardRouteState
  initialAvailability: CopilotAvailability | null
  mode: 'page' | 'panel'
  panelHeaderSlot?: HTMLElement | null
}) {
  const router = useRouter()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const {
    entities,
    session,
    setSession,
    closePanel,
    askToken,
    consumePendingQuestion,
  } = useCopilotContext()
  const pageContext = useMemo(
    () => buildCopilotPageContext(routeState, entities, session.selection),
    [entities, routeState, session.selection],
  )
  const workspaceParts = useMemo(() => ({
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  }), [activeWorkspace?.publicRouteKey, activeWorkspaceId])

  // Keep the newest turn in view: pin the operator's question near the top and
  // let Ray's answer stream in below it (reuses the shared chat scroll manager).
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const scrollMessages = useMemo(
    () => session.messages.map((message) => ({
      id: message.id,
      role: message.role === 'operator' ? 'user' : 'assistant',
      status: message.role === 'copilot' && message.streaming ? 'streaming' : 'complete',
    })),
    [session.messages],
  )
  useChatScroll({ messages: scrollMessages, containerRef: scrollContainerRef, sentinelRef: messagesEndRef })

  const updateSession = useCallback((update: (current: typeof session) => typeof session) => {
    setSession(update)
  }, [setSession])

  const loadConversations = useCallback(async () => {
    const response = await copilotApi.listConversations()
    updateSession((current) => ({ ...current, conversations: response.conversations }))
    return response.conversations
  }, [updateSession])

  const loadConversation = useCallback(async (conversationId: string) => {
    updateSession((current) => ({ ...current, isLoadingConversation: true, error: null }))
    try {
      const detail = await copilotApi.getConversation(conversationId)
      updateSession((current) => ({
        ...current,
        selectedConversationId: detail.id,
        messages: messageFromDetail(detail),
        conversationBusy: detail.status === 'running',
        isLoadingConversation: false,
      }))
    } catch (loadError) {
      updateSession((current) => ({ ...current, error: getApiErrorMessage(loadError, 'Could not load this Ray conversation.'), isLoadingConversation: false }))
    }
  }, [updateSession])

  useEffect(() => {
    let disposed = false
    const bootstrap = async () => {
      try {
        const effectiveAvailability = initialAvailability ?? (await copilotApi.getAvailability())
        if (disposed) return
        updateSession((current) => ({ ...current, availability: effectiveAvailability }))
        if (effectiveAvailability.available !== true) return
        const items = await loadConversations()
        if (disposed) return
        if (items[0] && !session.selectedConversationId && session.messages.length === 0) {
          await loadConversation(items[0].id)
        }
      } catch (bootstrapError) {
        if (disposed) return
        updateSession((current) => isCopilotApiErrorStatus(bootstrapError, 403)
          ? { ...current, permissionDenied: true, isLoading: false }
          : { ...current, error: getApiErrorMessage(bootstrapError, 'Could not load Ray.'), isLoading: false })
      } finally {
        if (!disposed) updateSession((current) => ({ ...current, isLoading: false }))
      }
    }
    void bootstrap()
    return () => { disposed = true }
    // The provider owns the session lifetime; this bootstrap runs once per mounted shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (initialAvailability) updateSession((current) => ({ ...current, availability: initialAvailability }))
  }, [initialAvailability, updateSession])

  const startNewConversation = () => {
    if (session.isRunning) return
    updateSession((current) => ({
      ...current,
      selectedConversationId: null,
      messages: [],
      input: '',
      error: null,
      conversationBusy: false,
      selection: null,
    }))
  }

  const handleDelete = async () => {
    if (!session.selectedConversationId || session.isRunning) return
    try {
      await copilotApi.deleteConversation(session.selectedConversationId)
      const remaining = session.conversations.filter((conversation) => conversation.id !== session.selectedConversationId)
      updateSession((current) => ({ ...current, conversations: remaining }))
      if (remaining[0]) await loadConversation(remaining[0].id)
      else startNewConversation()
    } catch (deleteError) {
      updateSession((current) => ({ ...current, error: getApiErrorMessage(deleteError, 'Could not delete this Ray conversation.') }))
    }
  }

  const handleActivity = (assistantId: string, event: CopilotActivityEvent) => {
    updateSession((current) => ({
      ...current,
      messages: current.messages.map((message) => message.id === assistantId && message.role === 'copilot'
        ? { ...message, liveActivity: [...(message.liveActivity ?? []), event] }
        : message),
    }))
  }

  const handleProposal = (assistantId: string, event: CopilotProposalEvent) => {
    const proposal: CopilotProposalSummary = {
      id: event.proposalId,
      targetType: event.targetType,
      targetLabel: event.targetLabel,
      summary: event.summary,
      status: 'pending',
      ...(event.evidence ? { evidence: event.evidence } : {}),
    }
    updateSession((current) => ({
      ...current,
      messages: current.messages.map((message) => message.id === assistantId && message.role === 'copilot'
        ? { ...message, proposals: [...(message.proposals ?? []).filter((item) => item.id !== proposal.id), proposal] }
        : message),
    }))
  }

  const handleSubmit = async (event?: Pick<FormEvent, 'preventDefault'>, retryMessage?: string) => {
    event?.preventDefault()
    const trimmed = (retryMessage ?? session.input).trim()
    if (!trimmed || session.isRunning || session.conversationBusy || session.availability?.available !== true) return

    const turnPageContext = buildCopilotPageContext(routeState, entities, session.selection)
    const operatorMessage: CopilotLocalMessage = {
      id: `operator-${Date.now()}`,
      role: 'operator',
      content: trimmed,
      createdAt: new Date().toISOString(),
    }
    const assistantId = `copilot-${Date.now()}`
    const assistantMessage: CopilotLocalMessage = {
      id: assistantId,
      role: 'copilot',
      content: '',
      createdAt: new Date().toISOString(),
      outcome: 'completed',
      activity: [],
      proposals: [],
      streaming: true,
      liveActivity: [],
    }
    updateSession((current) => ({
      ...current,
      messages: [...current.messages, operatorMessage, assistantMessage],
      input: '',
      selection: null,
      error: null,
      isRunning: true,
      conversationBusy: true,
    }))

    try {
      const result = await copilotApi.streamTurn({
        conversationId: session.selectedConversationId,
        message: trimmed,
        pageContext: turnPageContext,
      }, {
        onConversation: (conversation) => updateSession((current) => ({ ...current, selectedConversationId: conversation.conversationId })),
        onActivity: (activity) => handleActivity(assistantId, activity),
        onProposal: (proposal) => handleProposal(assistantId, proposal),
        onChunk: (chunk) => updateSession((current) => ({
          ...current,
          messages: current.messages.map((message) => message.id === assistantId && message.role === 'copilot'
            ? { ...message, content: `${message.content}${chunk.text}` }
            : message),
        })),
        onOutcome: (outcome) => updateSession((current) => ({
          ...current,
          messages: current.messages.map((message) => message.id === assistantId && message.role === 'copilot'
            ? { ...message, outcome: outcome.status }
            : message),
        })),
      })

      updateSession((current) => ({
        ...current,
        messages: current.messages.map((message) => message.id === assistantId && message.role === 'copilot'
          ? { ...message, content: result.answer || message.content, outcome: result.outcome ?? message.outcome, streaming: false }
          : message),
        isRunning: false,
      }))
      if (result.conversationId) {
        await loadConversation(result.conversationId)
      } else {
        updateSession((current) => ({ ...current, conversationBusy: false }))
      }
      await loadConversations()
    } catch (turnError) {
      if (isCopilotApiErrorStatus(turnError, 409)) {
        updateSession((current) => ({ ...current, error: 'This conversation is already running. Input is disabled until it finishes.', conversationBusy: true, isRunning: false, messages: current.messages.filter((message) => message.id !== assistantId && message.id !== operatorMessage.id) }))
      } else if (isCopilotApiErrorStatus(turnError, 503)) {
        updateSession((current) => ({ ...current, availability: { available: false, reason: 'no_llm_capability', canManage: current.availability?.canManage === true }, conversationBusy: false, isRunning: false, messages: current.messages.filter((message) => message.id !== assistantId && message.id !== operatorMessage.id) }))
      } else {
        updateSession((current) => ({
          ...current,
          error: getApiErrorMessage(turnError, "Ray couldn't finish that turn."),
          messages: current.messages.map((message) => message.id === assistantId && message.role === 'copilot'
            ? { ...message, content: message.content || "Ray couldn't complete this turn.", outcome: 'failed', streaming: false }
            : message),
          conversationBusy: false,
          isRunning: false,
        }))
      }
    } finally {
      updateSession((current) => ({ ...current, isRunning: false }))
    }
  }

  // Auto-send questions queued on the copilot context via askRay. Only the panel
  // surface consumes them, and consumePendingQuestion clears the queue atomically,
  // so exactly one turn is sent even if the effect re-runs. The ref keeps the
  // latest handleSubmit closure without retriggering the effect.
  const handleSubmitRef = useRef(handleSubmit)
  handleSubmitRef.current = handleSubmit
  useEffect(() => {
    if (mode !== 'panel' || askToken === 0) return
    if (session.availability?.available !== true) return
    if (session.isRunning || session.conversationBusy || session.isLoadingConversation) return
    const question = consumePendingQuestion()
    if (!question) return
    void handleSubmitRef.current(undefined, question)
  }, [askToken, mode, session.availability?.available, session.isRunning, session.conversationBusy, session.isLoadingConversation, consumePendingQuestion])

  const openEntity = (entity: CopilotEntityReference, targetAgentId?: string) => {
    closePanel()
    const base = { ...routeState, workspaceId: activeWorkspaceId ?? undefined, workspacePublicRouteKey: activeWorkspace?.publicRouteKey }
    if (entity.type === 'conversation') {
      router.push(buildDashboardHref(accountId, { ...base, section: 'activity', activityTab: 'all', historyItemKind: 'chat', historyItemId: entity.id }))
    } else if (entity.type === 'agent') {
      router.push(buildDashboardHref(accountId, { ...base, section: 'agents', agentId: entity.id, agentTab: 'behavior' }))
    } else if (entity.type === 'directive') {
      router.push(buildDashboardHref(accountId, { ...base, section: 'agents', agentId: targetAgentId ?? pageContext.agentId ?? undefined, agentTab: 'behavior', anchor: 'assistant-directives-card' }))
    } else if (entity.type === 'routine') {
      router.push(buildDashboardHref(accountId, { ...base, section: 'agents', agentId: targetAgentId ?? pageContext.agentId ?? undefined, agentTab: 'behavior', agentRoutineId: entity.id }))
    }
  }

  if (session.permissionDenied) return null

  if (session.availability?.reason === 'no_llm_capability') {
    return (
      <Card className="m-4 max-w-xl sm:m-6">
        <CardContent className="space-y-3 p-6">
          <h2 className="text-base font-medium">Connect an LLM to use Ray</h2>
          <p className="text-sm text-muted-foreground">Choose a workspace provider or configure the default provider before starting a conversation.</p>
          <Button asChild variant="outline">
            <a href={buildDashboardHref(accountId, { section: 'settings', settingsTab: 'providers', ...workspaceParts })}>
              Open provider settings for Ray <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
            </a>
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (session.availability === null || session.isLoading) {
    return <div className="flex min-h-64 items-center justify-center"><LogoSpinner imageClassName="h-7 w-7" /></div>
  }

  const panelMenu = mode === 'panel' && panelHeaderSlot ? createPortal(
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Ray conversation options">
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={startNewConversation} disabled={session.isRunning}>
          <Plus className="size-4" aria-hidden />New conversation
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Recent conversations</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {session.conversations.length === 0 ? <DropdownMenuItem disabled>No conversations yet</DropdownMenuItem> : session.conversations.map((conversation) => (
              <DropdownMenuItem key={conversation.id} onSelect={() => void loadConversation(conversation.id)}>
                <span className="max-w-52 truncate">{conversation.title || 'Untitled conversation'}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={!session.selectedConversationId || session.isRunning} onSelect={() => setDeleteDialogOpen(true)}>
          <Trash2 className="size-4" aria-hidden />Delete conversation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
    panelHeaderSlot,
  ) : null

  return (
    <>
      {panelMenu}
      <div className={`flex min-h-0 flex-1 flex-col ${mode === 'panel' ? 'min-w-0' : ''}`} data-copilot-panel={mode === 'panel' ? '' : undefined}>
        {session.error ? <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">{session.error}</div> : null}
        {mode === 'page' && session.selectedConversationId ? (
          <div className="flex items-center justify-end border-b border-border px-4 py-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteDialogOpen(true)} disabled={session.isRunning}>
              <Trash2 className="mr-2 h-4 w-4" aria-hidden />Delete
            </Button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {mode === 'page' ? (
            <ConversationList
              conversations={session.conversations}
              selectedId={session.selectedConversationId}
              onSelect={(id) => void loadConversation(id)}
              onNew={startNewConversation}
            />
          ) : null}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {session.isLoadingConversation ? <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">Loading conversation…</div> : null}
            <div ref={scrollContainerRef} className={cn('min-h-0 flex-1 overflow-y-auto p-4', mode === 'page' && 'sm:p-6')}>
              <div className="mx-auto flex max-w-3xl flex-col gap-6">
                {mode === 'panel' ? <ContextChip pageContext={pageContext} entities={entities} /> : null}
                {session.messages.length === 0 ? (
                  <div className="flex h-full min-h-64 items-center justify-center">
                    <div className="max-w-md text-center">
                      <div className="relative mx-auto flex size-16 items-center justify-center">
                        <div className="absolute size-16 rounded-full bg-secondary/15 blur-2xl" aria-hidden />
                        <AssistantAvatar avatarUrl={RAY_AVATAR_URL} label={RAY_NAME} className="relative size-12" />
                      </div>
                      <h2 className="mt-4 text-lg font-medium">Hi, I&apos;m Ray ☀️</h2>
                      <p className="mt-2 text-sm text-muted-foreground">Ask me about an agent or conversation and I&apos;ll shed some light on what happened.</p>
                      <SuggestedQuestions view={pageContext.view} entities={entities} onSelect={(question) => updateSession((current) => ({ ...current, input: question }))} />
                    </div>
                  </div>
                ) : (
                  <>
                    {session.messages.map((message, index) => {
                      const previousOperatorMessage = [...session.messages.slice(0, index)].reverse().find((candidate) => candidate.role === 'operator')
                      const activities = message.role === 'copilot'
                        ? message.liveActivity?.length
                          ? message.liveActivity
                          : message.activity.map((entry, activityIndex) => ({ toolCallId: `${message.id}-${activityIndex}`, tool: entry.tool, stage: entry.outcome, entity: entry.entity }))
                        : []
                      const proposals = message.role === 'copilot' ? message.proposals ?? [] : []
                      const footer = message.role === 'copilot' ? (
                        <>
                          {activities.length > 0 ? (
                            <div className="space-y-2">
                              <ActivityLines activities={activities} live={message.streaming} />
                              <EntityChips activities={activities} entities={entities} onOpen={openEntity} />
                            </div>
                          ) : null}
                          {proposals.length > 0 ? (
                            <div className="mt-4 space-y-3">
                              {proposals.map((proposal) => (
                                <CopilotProposalCard key={proposal.id} proposal={proposal} canApply={session.availability?.canManage === true} defaultAgentId={pageContext.agentId} onOpenEntity={openEntity} />
                              ))}
                            </div>
                          ) : null}
                          {!message.streaming && (message.outcome === 'budget_exhausted' || message.outcome === 'failed') ? (
                            <div className="mt-4 flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className="border-destructive/40 text-destructive">{outcomeLabel(message.outcome)}</Badge>
                              {previousOperatorMessage?.role === 'operator' ? <Button type="button" variant="outline" size="sm" onClick={(event) => void handleSubmit(event, previousOperatorMessage.content)}>Retry</Button> : null}
                            </div>
                          ) : null}
                        </>
                      ) : undefined

                      return message.role === 'operator' ? (
                        <ChatTurn key={message.id} messageId={message.id} role="user" userVariant="quiet">{message.content}</ChatTurn>
                      ) : (
                        <ChatTurn key={message.id} messageId={message.id} role="assistant" avatar={<AssistantAvatar avatarUrl={RAY_AVATAR_URL} label={RAY_NAME} className="size-8 ring-2 ring-secondary/50 ring-offset-2 ring-offset-background" />} streaming={message.streaming} footer={footer}>
                          {message.content ? (
                            <div className="border-l-2 border-secondary/40 pl-4 text-[15px] leading-7 [&>*+*]:mt-3 [&_li::marker]:text-muted-foreground [&_li]:leading-7 [&_ol]:space-y-1.5 [&_p]:leading-7 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:space-y-1.5">
                              <AssistantMarkdownContent content={message.content} />
                            </div>
                          ) : undefined}
                        </ChatTurn>
                      )
                    })}
                    {session.isRunning ? <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><span className="size-2 rounded-full bg-secondary animate-pulse" aria-hidden />Ray is looking into it…</p> : null}
                  </>
                )}
                <div ref={messagesEndRef} aria-hidden />
              </div>
            </div>
            <div className={cn('border-t border-border bg-background p-4', mode === 'page' && 'sm:p-6')}>
              <ChatComposer
                value={session.input}
                onChange={(value) => updateSession((current) => ({ ...current, input: value }))}
                onSubmit={() => void handleSubmit()}
                placeholder="Ask Ray to shed light on an agent…"
                ariaLabel="Ask Ray"
                maxLength={8000}
                disabled={session.isRunning || session.conversationBusy || session.availability.available !== true}
                hint={session.isRunning || session.conversationBusy ? 'Ray is looking into it…' : 'Ray reads the context shown on this screen.'}
                className="mx-auto max-w-3xl"
              />
            </div>
          </main>
          {mode === 'page' ? (
            <aside className="hidden w-56 shrink-0 border-l border-border p-4 lg:block">
              <div className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="h-4 w-4 text-secondary" aria-hidden /> Current context</div>
              <div className="mt-4"><ContextDetails pageContext={pageContext} entities={entities} /></div>
            </aside>
          ) : null}
        </div>
      </div>
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Ray conversation?</AlertDialogTitle>
            <AlertDialogDescription>This removes the conversation and its messages from the workspace.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setDeleteDialogOpen(false); void handleDelete() }}>Delete conversation</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
