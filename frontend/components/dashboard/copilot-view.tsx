'use client'

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, MessageSquare, Plus, Send, Sparkles, Trash2, Wrench } from 'lucide-react'

import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  copilotApi,
  deriveCopilotPageContext,
  isCopilotApiErrorStatus,
  type CopilotActivityEvent,
  type CopilotAvailability,
  type CopilotConversationDetail,
  type CopilotConversationSummary,
  type CopilotMessage,
  type CopilotOutcomeStatus,
} from '@/lib/api-copilot'
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'

type LocalActivity = CopilotActivityEvent

type LocalMessage = CopilotMessage & {
  streaming?: boolean
  liveActivity?: LocalActivity[]
}

const PAGE_VIEW_LABELS: Record<string, string> = {
  activity: 'Activity',
  history: 'Conversation history',
  agent: 'Agent',
  documents: 'Documents',
  workbench: 'Workbench',
  quality: 'Quality',
  evals: 'Evals',
  other: 'Dashboard',
}

const outcomeLabel = (outcome: CopilotOutcomeStatus) => {
  if (outcome === 'budget_exhausted') return 'Budget exhausted'
  if (outcome === 'failed') return 'Turn failed'
  return 'Completed'
}

const messageFromDetail = (detail: CopilotConversationDetail): LocalMessage[] => detail.messages

function ActivityLines({ activities, live = false }: { activities: LocalActivity[]; live?: boolean }) {
  if (activities.length === 0) return null

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
      {live ? <p className="sr-only" role="status">Copilot is running</p> : null}
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
                {conversation.status === 'running' ? (
                  <span className="mt-1 block text-xs text-secondary">Running</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function MessageThread({ messages, running }: { messages: LocalMessage[]; running: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      {messages.length === 0 ? (
        <div className="flex h-full min-h-64 items-center justify-center">
          <div className="max-w-md text-center">
            <Sparkles className="mx-auto h-8 w-8 text-secondary" aria-hidden />
            <h2 className="mt-4 text-lg font-medium">Ask about an agent or conversation</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The copilot can inspect the current dashboard context and explain what the agent did.
            </p>
          </div>
        </div>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {messages.map((message) => (
            <article key={message.id} className={message.role === 'operator' ? 'ml-auto max-w-[85%]' : 'mr-auto max-w-[95%]'}>
              <div className={message.role === 'operator' ? 'rounded-xl bg-primary px-4 py-3 text-primary-foreground' : 'rounded-xl border border-border bg-card px-4 py-3'}>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide opacity-70">
                  {message.role === 'operator' ? 'You' : 'Copilot'}
                </p>
                {message.role === 'copilot' ? (
                  <AssistantMarkdownContent content={message.content || (message.streaming ? 'Working…' : '')} />
                ) : (
                  <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                )}
                {message.role === 'copilot' && (message.liveActivity?.length || message.activity.length > 0) ? (
                  <div className="mt-4">
                    <ActivityLines
                      activities={
                        message.liveActivity?.length
                          ? message.liveActivity
                          : message.activity.map((entry, index) => ({ toolCallId: `${message.id}-${index}`, tool: entry.tool, stage: entry.outcome }))
                      }
                      live={message.streaming}
                    />
                  </div>
                ) : null}
                {message.role === 'copilot' && !message.streaming ? (
                  <div className="mt-4 flex items-center gap-2">
                    <Badge
                      variant={message.outcome === 'completed' ? 'secondary' : 'outline'}
                      className={message.outcome === 'completed' ? undefined : 'border-destructive/40 text-destructive'}
                    >
                      {outcomeLabel(message.outcome)}
                    </Badge>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
          {running ? <p className="text-xs text-muted-foreground" role="status">Running copilot turn…</p> : null}
        </div>
      )}
    </div>
  )
}

export function CopilotView({
  accountId,
  routeState,
  availability: initialAvailability,
}: {
  accountId: string
  routeState: DashboardRouteState
  availability: CopilotAvailability | null
}) {
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const [availability, setAvailability] = useState<CopilotAvailability | null>(initialAvailability)
  const [conversations, setConversations] = useState<CopilotConversationSummary[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingConversation, setIsLoadingConversation] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [conversationBusy, setConversationBusy] = useState(false)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pageContext = useMemo(() => deriveCopilotPageContext(routeState), [routeState])
  const workspaceParts = useMemo(() => ({
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  }), [activeWorkspace?.publicRouteKey, activeWorkspaceId])

  const loadConversations = useCallback(async () => {
    const response = await copilotApi.listConversations()
    setConversations(response.conversations)
    return response.conversations
  }, [])

  const loadConversation = useCallback(async (conversationId: string) => {
    setIsLoadingConversation(true)
    setError(null)
    try {
      const detail = await copilotApi.getConversation(conversationId)
      setSelectedConversationId(detail.id)
      setMessages(messageFromDetail(detail))
      setConversationBusy(detail.status === 'running')
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, 'Could not load this copilot conversation.'))
    } finally {
      setIsLoadingConversation(false)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Single bootstrap chain: availability, then the conversation list, then the newest conversation.
    const bootstrap = async () => {
      try {
        const effectiveAvailability = initialAvailability ?? (await copilotApi.getAvailability())
        if (disposed) return
        setAvailability(effectiveAvailability)
        if (effectiveAvailability.available !== true) return
        const items = await loadConversations()
        if (disposed) return
        const first = items[0]
        if (first) {
          await loadConversation(first.id)
        } else {
          setSelectedConversationId(null)
          setMessages([])
        }
      } catch (bootstrapError) {
        if (disposed) return
        if (isCopilotApiErrorStatus(bootstrapError, 403)) {
          setPermissionDenied(true)
        } else {
          setError(getApiErrorMessage(bootstrapError, 'Could not load the copilot.'))
        }
      } finally {
        if (!disposed) setIsLoading(false)
      }
    }
    void bootstrap()
    return () => { disposed = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Mount-only bootstrap; reloads go through the explicit loaders.
  }, [])

  if (permissionDenied) {
    return null
  }

  const startNewConversation = () => {
    if (isRunning) return
    setSelectedConversationId(null)
    setMessages([])
    setInput('')
    setError(null)
    setConversationBusy(false)
  }

  const handleDelete = async () => {
    if (!selectedConversationId || isRunning) return
    try {
      await copilotApi.deleteConversation(selectedConversationId)
      const remaining = conversations.filter((conversation) => conversation.id !== selectedConversationId)
      setConversations(remaining)
      if (remaining[0]) {
        await loadConversation(remaining[0].id)
      } else {
        startNewConversation()
      }
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Could not delete this copilot conversation.'))
    }
  }

  const handleActivity = (assistantId: string, event: CopilotActivityEvent) => {
    setMessages((current) => current.map((message) => message.id === assistantId && message.role === 'copilot'
      ? { ...message, liveActivity: [...(message.liveActivity ?? []), event] }
      : message))
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || isRunning || conversationBusy || availability?.available !== true) return

    const operatorMessage: LocalMessage = {
      id: `operator-${Date.now()}`,
      role: 'operator',
      content: trimmed,
      createdAt: new Date().toISOString(),
    }
    const assistantId = `copilot-${Date.now()}`
    const assistantMessage: LocalMessage = {
      id: assistantId,
      role: 'copilot',
      content: '',
      createdAt: new Date().toISOString(),
      outcome: 'completed',
      activity: [],
      streaming: true,
      liveActivity: [],
    }
    setMessages((current) => [...current, operatorMessage, assistantMessage])
    setInput('')
    setError(null)
    setIsRunning(true)
    setConversationBusy(true)

    try {
      const result = await copilotApi.streamTurn({
        conversationId: selectedConversationId,
        message: trimmed,
        pageContext,
      }, {
        onConversation: (conversation) => {
          setSelectedConversationId(conversation.conversationId)
        },
        onActivity: (activity) => handleActivity(assistantId, activity),
        onChunk: (chunk) => {
          setMessages((current) => current.map((message) => message.id === assistantId && message.role === 'copilot'
            ? { ...message, content: `${message.content}${chunk.text}` }
            : message))
        },
        onOutcome: (outcome) => {
          setMessages((current) => current.map((message) => message.id === assistantId && message.role === 'copilot'
            ? { ...message, outcome: outcome.status }
            : message))
        },
      })

      setMessages((current) => current.map((message) => message.id === assistantId && message.role === 'copilot'
        ? { ...message, content: result.answer || message.content, outcome: result.outcome ?? message.outcome, streaming: false }
        : message))
      if (result.conversationId) {
        setSelectedConversationId(result.conversationId)
        const detail = await copilotApi.getConversation(result.conversationId)
        setMessages(messageFromDetail(detail))
        setConversationBusy(detail.status === 'running')
      } else {
        setConversationBusy(false)
      }
      await loadConversations()
    } catch (turnError) {
      if (isCopilotApiErrorStatus(turnError, 409)) {
        setError('This conversation is already running. Input is disabled until it finishes.')
        setConversationBusy(true)
        setMessages((current) => current.filter((message) => message.id !== assistantId && message.id !== operatorMessage.id))
      } else if (isCopilotApiErrorStatus(turnError, 503)) {
        setAvailability({ available: false, reason: 'no_llm_capability' })
        setConversationBusy(false)
        setMessages((current) => current.filter((message) => message.id !== assistantId && message.id !== operatorMessage.id))
      } else {
        setError(getApiErrorMessage(turnError, 'The copilot turn failed.'))
        setMessages((current) => current.map((message) => message.id === assistantId && message.role === 'copilot'
          ? { ...message, content: message.content || 'The copilot could not complete this turn.', outcome: 'failed', streaming: false }
          : message))
        setConversationBusy(false)
      }
    } finally {
      setIsRunning(false)
    }
  }

  if (availability?.reason === 'no_llm_capability') {
    return (
      <DashboardPage title="Copilot" description="Investigate agent behavior from the dashboard.">
        <Card className="max-w-xl">
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
      </DashboardPage>
    )
  }

  if (availability === null || isLoading) {
    return (
      <DashboardPage title="Copilot" description="Investigate agent behavior from the dashboard.">
        <div className="flex min-h-64 items-center justify-center"><LogoSpinner imageClassName="h-7 w-7" /></div>
      </DashboardPage>
    )
  }

  return (
    <DashboardPage
      title="Copilot"
      description="Investigate agent behavior from the dashboard."
      contentClassName="flex min-h-0 flex-col p-0"
      contentScroll={false}
      actions={selectedConversationId ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => void handleDelete()} disabled={isRunning}>
          <Trash2 className="mr-2 h-4 w-4" aria-hidden />
          Delete
        </Button>
      ) : null}
    >
      {error ? <div className="border-b border-destructive/30 bg-destructive/5 px-6 py-3 text-sm text-destructive" role="alert">{error}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ConversationList
          conversations={conversations}
          selectedId={selectedConversationId}
          onSelect={(id) => void loadConversation(id)}
          onNew={startNewConversation}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isLoadingConversation ? <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">Loading conversation…</div> : null}
          <MessageThread messages={messages} running={isRunning} />
          <form onSubmit={(event) => void handleSubmit(event)} className="border-t border-border bg-background p-4 sm:p-6">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask why an agent behaved a certain way…"
                rows={2}
                maxLength={8000}
                disabled={isRunning || conversationBusy || availability.available !== true}
                aria-label="Ask Copilot"
              />
              <Button type="submit" size="icon" aria-label="Send question" disabled={!input.trim() || isRunning || conversationBusy || availability.available !== true}>
                <Send className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <div className="mx-auto mt-2 flex max-w-3xl items-center justify-between text-xs text-muted-foreground">
              <span>{isRunning || conversationBusy ? 'Conversation is running' : 'Copilot uses the page context shown at right.'}</span>
              <span>{input.length}/8000</span>
            </div>
          </form>
        </main>
        <aside className="hidden w-56 shrink-0 border-l border-border p-4 lg:block">
          <div className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="h-4 w-4 text-secondary" aria-hidden /> Current context</div>
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-xs text-muted-foreground">View</dt><dd>{pageContext.view ? PAGE_VIEW_LABELS[pageContext.view] : 'None'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Agent</dt><dd className="truncate">{pageContext.agentId || 'Not selected'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Customer conversation</dt><dd className="truncate">{pageContext.conversationId || 'Not selected'}</dd></div>
          </dl>
        </aside>
      </div>
    </DashboardPage>
  )
}
