'use client'

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLink, MessageSquare, Plus, Send, Sparkles, Trash2, Wrench } from 'lucide-react'

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
import { Textarea } from '@/components/ui/textarea'
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
import { useWorkspace } from '@/lib/workspace-context'

const PAGE_VIEW_LABELS: Record<string, string> = {
  activity: 'Activity',
  history: 'Conversation history',
  agent: 'Agent',
  documents: 'Documents',
  workbench: 'Workbench',
  quality: 'Quality',
  evals: 'Evals',
  copilot: 'Copilot',
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

const relativeTimestamp = (value: string) => {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const absolute = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
  ]
  let amount = seconds
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  for (const [threshold, nextUnit] of units) {
    if (Math.abs(amount) < threshold) break
    amount = Math.round(amount / threshold)
    unit = nextUnit
  }
  return absolute.format(amount, unit)
}

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
        className="w-full rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40"
        onClick={() => setExpanded(true)}
      >
        Read {activities.length} {activities.length === 1 ? 'source' : 'sources'} during this turn
      </button>
    )
  }

  return (
    <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/20 p-3" aria-label="Copilot activity">
      {activities.map((activity, index) => (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" key={`${activity.toolCallId}-${index}`}>
          <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{activity.tool}</span>
          <span className={activity.stage === 'failed' ? 'text-destructive' : activity.stage === 'started' ? 'text-secondary' : 'text-muted-foreground'}>
            {activity.stage}
          </span>
        </div>
      ))}
      <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setExpanded(false)}>
        Collapse activity
      </button>
      {live ? <p className="sr-only" role="status">Copilot is running</p> : null}
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
    <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Read during this turn">
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
        <Button type="button" variant="ghost" size="icon" onClick={onNew} aria-label="New copilot conversation">
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">Your copilot conversations appear here.</p>
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
}: {
  accountId: string
  routeState: DashboardRouteState
  initialAvailability: CopilotAvailability | null
  mode: 'page' | 'panel'
}) {
  const router = useRouter()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const {
    entities,
    session,
    setSession,
    closePanel,
  } = useCopilotContext()
  const pageContext = useMemo(
    () => buildCopilotPageContext(routeState, entities, session.selection),
    [entities, routeState, session.selection],
  )
  const workspaceParts = useMemo(() => ({
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  }), [activeWorkspace?.publicRouteKey, activeWorkspaceId])

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
      updateSession((current) => ({ ...current, error: getApiErrorMessage(loadError, 'Could not load this copilot conversation.'), isLoadingConversation: false }))
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
          : { ...current, error: getApiErrorMessage(bootstrapError, 'Could not load the copilot.'), isLoading: false })
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
      updateSession((current) => ({ ...current, error: getApiErrorMessage(deleteError, 'Could not delete this copilot conversation.') }))
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
    }
    updateSession((current) => ({
      ...current,
      messages: current.messages.map((message) => message.id === assistantId && message.role === 'copilot'
        ? { ...message, proposals: [...(message.proposals ?? []).filter((item) => item.id !== proposal.id), proposal] }
        : message),
    }))
  }

  const handleSubmit = async (event: Pick<FormEvent, 'preventDefault'>, retryMessage?: string) => {
    event.preventDefault()
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
        updateSession((current) => ({ ...current, availability: { available: false, reason: 'no_llm_capability' }, conversationBusy: false, isRunning: false, messages: current.messages.filter((message) => message.id !== assistantId && message.id !== operatorMessage.id) }))
      } else {
        updateSession((current) => ({
          ...current,
          error: getApiErrorMessage(turnError, 'The copilot turn failed.'),
          messages: current.messages.map((message) => message.id === assistantId && message.role === 'copilot'
            ? { ...message, content: message.content || 'The copilot could not complete this turn.', outcome: 'failed', streaming: false }
            : message),
          conversationBusy: false,
          isRunning: false,
        }))
      }
    } finally {
      updateSession((current) => ({ ...current, isRunning: false }))
    }
  }

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
      router.push(buildDashboardHref(accountId, { ...base, section: 'agents', agentId: pageContext.agentId ?? undefined, agentTab: 'behavior', agentRoutineId: entity.id }))
    }
  }

  if (session.permissionDenied) return null

  if (session.availability?.reason === 'no_llm_capability') {
    return (
      <Card className="m-4 max-w-xl sm:m-6">
        <CardContent className="space-y-3 p-6">
          <h2 className="text-base font-medium">Connect an LLM to use Copilot</h2>
          <p className="text-sm text-muted-foreground">Choose a workspace provider or configure the default provider before starting a conversation.</p>
          <Button asChild variant="outline">
            <a href={buildDashboardHref(accountId, { section: 'settings', settingsTab: 'providers', ...workspaceParts })}>
              Open provider settings <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
            </a>
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (session.availability === null || session.isLoading) {
    return <div className="flex min-h-64 items-center justify-center"><LogoSpinner imageClassName="h-7 w-7" /></div>
  }

  return (
    <>
      <div className={`flex min-h-0 flex-1 flex-col ${mode === 'panel' ? 'min-w-0' : ''}`} data-copilot-panel={mode === 'panel' ? '' : undefined}>
      {session.error ? <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">{session.error}</div> : null}
      {session.selectedConversationId ? (
        <div className="flex items-center justify-end border-b border-border px-4 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteDialogOpen(true)} disabled={session.isRunning}>
            <Trash2 className="mr-2 h-4 w-4" aria-hidden />Delete
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ConversationList
          conversations={session.conversations}
          selectedId={session.selectedConversationId}
          onSelect={(id) => void loadConversation(id)}
          onNew={startNewConversation}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {session.isLoadingConversation ? <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">Loading conversation…</div> : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {session.messages.length === 0 ? (
              <div className="flex h-full min-h-64 items-center justify-center">
                <div className="max-w-md text-center">
                  <Sparkles className="mx-auto h-8 w-8 text-secondary" aria-hidden />
                  <h2 className="mt-4 text-lg font-medium">Ask about an agent or conversation</h2>
                  <p className="mt-2 text-sm text-muted-foreground">The copilot can inspect the current dashboard context and explain what the agent did.</p>
                  <SuggestedQuestions view={pageContext.view} entities={entities} onSelect={(question) => updateSession((current) => ({ ...current, input: question }))} />
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {session.messages.map((message, index) => {
                  const previousOperatorMessage = [...session.messages.slice(0, index)].reverse().find((candidate) => candidate.role === 'operator')
                  const activities = message.role === 'copilot'
                    ? message.liveActivity?.length
                      ? message.liveActivity
                      : message.activity.map((entry, activityIndex) => ({ toolCallId: `${message.id}-${activityIndex}`, tool: entry.tool, stage: entry.outcome, entity: entry.entity }))
                      : []
                  const proposals = message.role === 'copilot' ? message.proposals ?? [] : []
                  return (
                    <article key={message.id} className={message.role === 'operator' ? 'ml-auto max-w-[85%]' : 'mr-auto max-w-[95%]'}>
                      <div className={message.role === 'operator' ? 'rounded-xl bg-primary px-4 py-3 text-primary-foreground' : 'rounded-xl border border-border bg-card px-4 py-3'}>
                        <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide opacity-70">
                          <span>{message.role === 'operator' ? 'You' : 'Copilot'}</span>
                          <time dateTime={message.createdAt} title={message.createdAt}>{relativeTimestamp(message.createdAt)}</time>
                        </div>
                        {message.role === 'copilot' ? (
                          <AssistantMarkdownContent content={message.content || (message.streaming ? 'Working…' : message.outcome !== 'completed' ? 'The copilot could not complete this turn.' : '')} />
                        ) : <p className="whitespace-pre-wrap text-sm">{message.content}</p>}
                        {message.role === 'copilot' && activities.length > 0 ? <div className="mt-4"><ActivityLines activities={activities} live={message.streaming} /></div> : null}
                        {message.role === 'copilot' ? <EntityChips activities={activities} entities={entities} onOpen={openEntity} /> : null}
                        {message.role === 'copilot' && proposals.length > 0 ? (
                          <div className="mt-4 space-y-3">
                            {proposals.map((proposal) => (
                              <CopilotProposalCard
                                key={proposal.id}
                                proposal={proposal}
                                canApply={session.availability?.canManage !== false}
                                defaultAgentId={pageContext.agentId}
                                onOpenEntity={openEntity}
                              />
                            ))}
                          </div>
                        ) : null}
                        {message.role === 'copilot' && !message.streaming ? (
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <Badge variant={message.outcome === 'completed' ? 'secondary' : 'outline'} className={message.outcome === 'completed' ? undefined : 'border-destructive/40 text-destructive'}>{outcomeLabel(message.outcome)}</Badge>
                            {message.outcome !== 'completed' && previousOperatorMessage?.role === 'operator' ? (
                              <Button type="button" variant="outline" size="sm" onClick={(event) => void handleSubmit(event, previousOperatorMessage.content)}>Retry</Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  )
                })}
                {session.isRunning ? <p className="text-xs text-muted-foreground" role="status">Running copilot turn…</p> : null}
              </div>
            )}
          </div>
          <form onSubmit={(event) => void handleSubmit(event)} className="border-t border-border bg-background p-4 sm:p-6">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <Textarea
                value={session.input}
                onChange={(event) => updateSession((current) => ({ ...current, input: event.target.value }))}
                placeholder="Ask why an agent behaved a certain way…"
                rows={2}
                maxLength={8000}
                disabled={session.isRunning || session.conversationBusy || session.availability.available !== true}
                aria-label="Ask Copilot"
              />
              <Button type="submit" size="icon" aria-label="Send question" disabled={!session.input.trim() || session.isRunning || session.conversationBusy || session.availability.available !== true}>
                <Send className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <div className="mx-auto mt-2 flex max-w-3xl items-center justify-between text-xs text-muted-foreground">
              <span>{session.isRunning || session.conversationBusy ? 'Conversation is running' : 'Copilot uses the page context shown at right.'}</span>
              <span>{session.input.length}/8000</span>
            </div>
          </form>
        </main>
        <aside className="hidden w-56 shrink-0 border-l border-border p-4 lg:block">
          <div className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="h-4 w-4 text-secondary" aria-hidden /> Current context</div>
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-xs text-muted-foreground">View</dt><dd>{pageContext.view ? PAGE_VIEW_LABELS[pageContext.view] : 'None'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Agent</dt><dd className="truncate">{pageContext.agentId ? resolveCopilotEntityLabel(entities, 'agent', pageContext.agentId) : 'Not selected'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Customer conversation</dt><dd className="truncate">{pageContext.conversationId ? resolveCopilotEntityLabel(entities, 'conversation', pageContext.conversationId) : 'Not selected'}</dd></div>
            {entities.length > 0 ? <div><dt className="text-xs text-muted-foreground">On this screen</dt><dd className="mt-1 space-y-1">{entities.slice(0, 5).map((entity) => <div key={`${entity.type}:${entity.id}`} className="truncate">{entity.label}</div>)}</dd></div> : null}
          </dl>
        </aside>
      </div>
      </div>
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Copilot conversation?</AlertDialogTitle>
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
