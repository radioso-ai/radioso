'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw } from 'lucide-react'

import { DashboardTable, DashboardTableBody, DashboardTableCell, DashboardTableHead, DashboardTableHeader, DashboardTableRow } from '@/components/dashboard/shared/dashboard-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LogoSpinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  accountApi,
  workspaceApi,
  type InternalUsageEvent,
  type InternalUsageResponse,
  type MessageUsageResponse,
  type MessageUsageSummary,
  type Workspace,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  buildDashboardHref,
} from '@/lib/dashboard-routes'
import {
  formatLlmCallCount,
  formatUsageOutput,
  formatUsageTokenCount,
  readUsageDetailsQuery,
  writeUsageDetailsQuery,
  type UsageDetailsQueryState,
} from '@/lib/usage-details'

const ALL_WORKSPACES = 'all'
const PAGE_SIZE = 50

type UsageDetailsTab = 'messages' | 'internal'

type PagedItems<T> = {
  items: T[]
  nextCursor: string | null
}

const emptyPage = <T,>(): PagedItems<T> => ({ items: [], nextCursor: null })

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const formatDateTime = (value: string): string => dateTimeFormatter.format(new Date(value))

const formatQualitySummary = (quality: { actual: number; estimated: number }): string => (
  quality.estimated > 0 ? `${quality.actual} actual · ${quality.estimated} estimated` : `${quality.actual} actual`
)

const workspaceLabel = (workspaceId: string | null, names: Map<string, string>): string => (
  workspaceId ? names.get(workspaceId) ?? 'Unknown workspace' : 'Workspace unavailable'
)

const reasoningLabel = (reasoning: MessageUsageSummary['modelTokens']['reasoning']): string => {
  if (reasoning.coverage === 'unavailable' || reasoning.tokens === null) {
    return '—'
  }
  if (reasoning.coverage === 'partial') {
    return `${formatUsageTokenCount(reasoning.tokens)} partial`
  }
  return formatUsageTokenCount(reasoning.tokens)
}

const internalKindLabel: Record<InternalUsageEvent['kind'], string> = {
  model: 'Model',
  embedding: 'Embedding',
  unknown: 'Unknown history',
}

const internalKindVariant = (kind: InternalUsageEvent['kind']) => (
  kind === 'unknown' ? 'outline' : 'secondary'
)

const hasValidDateRange = (query: UsageDetailsQueryState): boolean => {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/
  return datePattern.test(query.from) && datePattern.test(query.to) && query.from <= query.to
}

function UsageDetailsFilters({
  draft,
  workspaces,
  onChange,
  onApply,
  onRefresh,
  isLoading,
}: {
  draft: UsageDetailsQueryState
  workspaces: Workspace[]
  onChange: (patch: Partial<UsageDetailsQueryState>) => void
  onApply: () => void
  onRefresh: () => void
  isLoading: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Detailed AI usage</CardTitle>
        <CardDescription>
          Token and operation records only. Prompts, responses, document content, request IDs, and error details are not shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="usage-details-from">From</Label>
            <Input
              id="usage-details-from"
              type="date"
              value={draft.from}
              onChange={(event) => onChange({ from: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="usage-details-to">To</Label>
            <Input
              id="usage-details-to"
              type="date"
              value={draft.to}
              onChange={(event) => onChange({ to: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>Workspace</Label>
            <Select
              value={draft.workspaceId ?? ALL_WORKSPACES}
              onValueChange={(value) => onChange({ workspaceId: value === ALL_WORKSPACES ? undefined : value })}
            >
              <SelectTrigger className="w-full" aria-label="Detailed usage workspace">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_WORKSPACES}>All workspaces</SelectItem>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button type="button" variant="outline" className="w-full" onClick={onApply} disabled={isLoading}>
              Apply filters
            </Button>
          </div>
          <div className="flex items-end">
            <Button type="button" variant="outline" className="w-full" onClick={onRefresh} disabled={isLoading}>
              <RefreshCw className="size-4" aria-hidden />
              Refresh
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function MessageUsageTable({
  items,
  workspaceNames,
  showWorkspace,
  getMessageHref,
}: {
  items: MessageUsageSummary[]
  workspaceNames: Map<string, string>
  showWorkspace: boolean
  getMessageHref: (item: MessageUsageSummary) => string
}) {
  if (items.length === 0) {
    return <EmptyUsageState title="No message usage in this range" description="Visitor messages with recorded model or embedding operations will appear here." />
  }

  return (
    <DashboardTable minWidth="min-w-[1100px]" aria-label="Message AI usage">
      <DashboardTableHead>
        <DashboardTableHeader className="w-56">Message</DashboardTableHeader>
        <DashboardTableHeader className="w-48">Operation</DashboardTableHeader>
        <DashboardTableHeader className="w-28">Model input</DashboardTableHeader>
        <DashboardTableHeader className="w-28">Reasoning</DashboardTableHeader>
        <DashboardTableHeader className="w-32">Output</DashboardTableHeader>
        <DashboardTableHeader className="w-32">Model total</DashboardTableHeader>
        <DashboardTableHeader className="w-40">Embeddings</DashboardTableHeader>
        <DashboardTableHeader className="w-24">LLM Calls</DashboardTableHeader>
      </DashboardTableHead>
      <DashboardTableBody>
        {items.map((item) => (
          <DashboardTableRow key={item.messageId}>
            <DashboardTableCell>
              <Link
                href={getMessageHref(item)}
                aria-label={`Open message from ${formatDateTime(item.lastOccurredAt)}`}
                className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {formatDateTime(item.lastOccurredAt)}
              </Link>
              {showWorkspace ? <div className="mt-1 text-xs text-muted-foreground">Workspace: {workspaceLabel(item.workspaceId, workspaceNames)}</div> : null}
              <div className="mt-1 truncate text-xs text-muted-foreground" title={item.providers.join(', ')}>
                Provider: {item.providers.join(', ') || 'Unavailable'}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground" title={item.models.join(', ')}>
                Model: {item.models.join(', ') || 'Unavailable'}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{formatQualitySummary(item.quality)}</div>
            </DashboardTableCell>
            <DashboardTableCell>
              <div className="line-clamp-2 text-sm">{item.operations.map((operation) => operation.label).join(' · ') || 'Unattributed'}</div>
              {item.unknownHistorical.attempts > 0 ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatUsageTokenCount(item.unknownHistorical.total)} unknown historical tokens
                </div>
              ) : null}
            </DashboardTableCell>
            <DashboardTableCell>{formatUsageTokenCount(item.modelTokens.input)}</DashboardTableCell>
            <DashboardTableCell>
              <div>{reasoningLabel(item.modelTokens.reasoning)}</div>
              {item.modelTokens.reasoning.coverage === 'partial' ? (
                <div className="mt-1 text-xs text-muted-foreground">Partial coverage</div>
              ) : null}
            </DashboardTableCell>
            <DashboardTableCell>
              <UsageOutputCell output={formatUsageOutput({
                completion: item.modelTokens.completion,
                visibleOutput: item.modelTokens.visibleOutput,
                reasoningCoverage: item.modelTokens.reasoning.coverage,
              })} />
            </DashboardTableCell>
            <DashboardTableCell>{formatUsageTokenCount(item.modelTokens.total)}</DashboardTableCell>
            <DashboardTableCell>
              {item.embeddingTokens.attempts > 0 ? (
                <>
                  <div>{formatUsageTokenCount(item.embeddingTokens.input)} input</div>
                  <div className="mt-1 text-xs text-muted-foreground">{formatUsageTokenCount(item.embeddingTokens.vectors)} vectors</div>
                </>
              ) : '—'}
            </DashboardTableCell>
            <DashboardTableCell>
              <Badge variant={item.attempts.failed > 0 ? 'outline' : 'secondary'}>{formatLlmCallCount(item.attempts)}</Badge>
            </DashboardTableCell>
          </DashboardTableRow>
        ))}
      </DashboardTableBody>
    </DashboardTable>
  )
}

function InternalUsageTable({
  items,
  workspaceNames,
  showWorkspace,
}: {
  items: InternalUsageEvent[]
  workspaceNames: Map<string, string>
  showWorkspace: boolean
}) {
  if (items.length === 0) {
    return <EmptyUsageState title="No internal usage in this range" description="Agent setup, test chat, directives, metadata generation, and other internal operations will appear here." />
  }

  return (
    <DashboardTable minWidth="min-w-[1100px]" aria-label="Internal AI usage">
      <DashboardTableHead>
        <DashboardTableHeader className="w-40">When</DashboardTableHeader>
        <DashboardTableHeader className="w-32">Kind</DashboardTableHeader>
        <DashboardTableHeader className="w-48">Operation</DashboardTableHeader>
        <DashboardTableHeader className="w-44">Provider / model</DashboardTableHeader>
        <DashboardTableHeader className="w-24">Input</DashboardTableHeader>
        <DashboardTableHeader className="w-28">Reasoning</DashboardTableHeader>
        <DashboardTableHeader className="w-32">Output</DashboardTableHeader>
        <DashboardTableHeader className="w-24">Total</DashboardTableHeader>
        <DashboardTableHeader className="w-28">Status</DashboardTableHeader>
      </DashboardTableHead>
      <DashboardTableBody>
        {items.map((item) => (
          <DashboardTableRow key={item.eventId}>
            <DashboardTableCell>
              <div>{formatDateTime(item.occurredAt)}</div>
              {showWorkspace ? <div className="mt-1 text-xs text-muted-foreground">Workspace: {workspaceLabel(item.workspaceId, workspaceNames)}</div> : null}
            </DashboardTableCell>
            <DashboardTableCell><Badge variant={internalKindVariant(item.kind)}>{internalKindLabel[item.kind]}</Badge></DashboardTableCell>
            <DashboardTableCell>
              <div className="font-medium">{item.operation.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{item.operation.surface}</div>
            </DashboardTableCell>
            <DashboardTableCell>
              <div className="truncate" title={`${item.provider} / ${item.model}`}>{item.provider} / {item.model}</div>
              {item.vectorCount !== null ? <div className="mt-1 text-xs text-muted-foreground">{formatUsageTokenCount(item.vectorCount)} vectors</div> : null}
            </DashboardTableCell>
            <DashboardTableCell>{formatUsageTokenCount(item.tokens.input)}</DashboardTableCell>
            <DashboardTableCell>{formatUsageTokenCount(item.tokens.reasoning)}</DashboardTableCell>
            <DashboardTableCell>
              <UsageOutputCell output={formatUsageOutput({
                completion: item.tokens.completion,
                visibleOutput: item.tokens.visibleOutput,
              })} />
            </DashboardTableCell>
            <DashboardTableCell>{formatUsageTokenCount(item.tokens.total)}</DashboardTableCell>
            <DashboardTableCell>
              <Badge variant={item.status === 'failed' ? 'outline' : 'secondary'}>{item.status}</Badge>
              <div className="mt-1 text-xs text-muted-foreground">{item.usageQuality}</div>
            </DashboardTableCell>
          </DashboardTableRow>
        ))}
      </DashboardTableBody>
    </DashboardTable>
  )
}

function UsageOutputCell({ output }: { output: ReturnType<typeof formatUsageOutput> }) {
  return (
    <>
      <div>{formatUsageTokenCount(output.tokens)}</div>
      {output.detail ? <div className="mt-1 text-xs text-muted-foreground">{output.detail}</div> : null}
    </>
  )
}

function EmptyUsageState({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  )
}

export function UsageDetailsView({ accountId }: { accountId: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const searchParamsString = searchParams.toString()
  const [activeTab, setActiveTab] = useState<UsageDetailsTab>('messages')
  const [query, setQuery] = useState<UsageDetailsQueryState>(() => readUsageDetailsQuery(searchParams))
  const [draft, setDraft] = useState<UsageDetailsQueryState>(() => readUsageDetailsQuery(searchParams))
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [messages, setMessages] = useState<PagedItems<MessageUsageSummary>>(() => emptyPage())
  const [internal, setInternal] = useState<PagedItems<InternalUsageEvent>>(() => emptyPage())
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const requestGenerationRef = useRef(0)

  const requestInput = useMemo(() => ({ ...query, limit: PAGE_SIZE }), [query])
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces])
  const workspaceById = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces])
  const getMessageHref = (item: MessageUsageSummary) => {
    const workspace = workspaceById.get(item.workspaceId)
    return buildDashboardHref(accountId, {
      section: 'activity',
      activityTab: 'all',
      historyFilter: 'chat',
      historyItemKind: 'chat',
      historyItemId: item.conversationId,
      historyMessageId: item.messageId,
      workspaceId: item.workspaceId,
      workspacePublicRouteKey: workspace?.publicRouteKey,
    })
  }

  useEffect(() => {
    let active = true
    void workspaceApi.list()
      .then((response) => {
        if (active) setWorkspaces(response)
      })
      .catch(() => {
        // The all-workspaces option remains usable when the workspace picker cannot load.
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const requestGeneration = ++requestGenerationRef.current
    let active = true
    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        if (activeTab === 'messages') {
          const response = await accountApi.getMessageUsage(requestInput)
          if (active && requestGeneration === requestGenerationRef.current) setMessages(response)
        } else {
          const response = await accountApi.getInternalUsage(requestInput)
          if (active && requestGeneration === requestGenerationRef.current) setInternal(response)
        }
      } catch (nextError) {
        if (active && requestGeneration === requestGenerationRef.current) {
          setError(getApiErrorMessage(nextError, 'Failed to load detailed AI usage.'))
        }
      } finally {
        if (active && requestGeneration === requestGenerationRef.current) setIsLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [activeTab, reloadKey, requestInput])

  const updateDraft = (patch: Partial<UsageDetailsQueryState>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  const applyFilters = () => {
    if (!hasValidDateRange(draft)) {
      setError('Choose a valid date range before applying filters.')
      return
    }

    const next = { ...draft }
    const nextSearchParams = writeUsageDetailsQuery(new URLSearchParams(searchParamsString), next)
    requestGenerationRef.current += 1
    setError(null)
    setQuery(next)
    router.replace(`${pathname}?${nextSearchParams.toString()}`)
  }

  const loadMore = async () => {
    const cursor = activeTab === 'messages' ? messages.nextCursor : internal.nextCursor
    if (!cursor || isLoadingMore) return

    const requestGeneration = requestGenerationRef.current
    const tab = activeTab
    setIsLoadingMore(true)
    setError(null)
    try {
      if (requestGeneration !== requestGenerationRef.current) return
      if (tab === 'messages') {
        const response: MessageUsageResponse = await accountApi.getMessageUsage({ ...requestInput, cursor })
        if (requestGeneration === requestGenerationRef.current) {
          setMessages((current) => ({ items: [...current.items, ...response.items], nextCursor: response.nextCursor }))
        }
      } else {
        const response: InternalUsageResponse = await accountApi.getInternalUsage({ ...requestInput, cursor })
        if (requestGeneration === requestGenerationRef.current) {
          setInternal((current) => ({ items: [...current.items, ...response.items], nextCursor: response.nextCursor }))
        }
      }
    } catch (nextError) {
      if (requestGeneration === requestGenerationRef.current) {
        setError(getApiErrorMessage(nextError, 'Failed to load more detailed AI usage.'))
      }
    } finally {
      setIsLoadingMore(false)
    }
  }

  const page = activeTab === 'messages' ? messages : internal
  const changeTab = (value: string) => {
    const nextTab = value as UsageDetailsTab
    if (nextTab === activeTab) return
    requestGenerationRef.current += 1
    setActiveTab(nextTab)
  }
  const refresh = () => {
    requestGenerationRef.current += 1
    setReloadKey((value) => value + 1)
  }

  return (
    <div className="space-y-6" data-testid="usage-details">
      <UsageDetailsFilters
        draft={draft}
        workspaces={workspaces}
        onChange={updateDraft}
        onApply={applyFilters}
        onRefresh={refresh}
        isLoading={isLoading}
      />

      <Tabs value={activeTab} onValueChange={changeTab}>
        <TabsList aria-label="Detailed AI usage view">
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="internal">Internal operations</TabsTrigger>
        </TabsList>
        <TabsContent value="messages" className="mt-4">
          {isLoading && activeTab === 'messages' ? (
            <div className="flex min-h-48 items-center justify-center"><LogoSpinner imageClassName="h-7 w-7" /></div>
          ) : error ? (
            <EmptyUsageState title="Detailed usage unavailable" description={error} />
          ) : <MessageUsageTable items={messages.items} workspaceNames={workspaceNames} showWorkspace={!query.workspaceId} getMessageHref={getMessageHref} />}
        </TabsContent>
        <TabsContent value="internal" className="mt-4">
          {isLoading && activeTab === 'internal' ? (
            <div className="flex min-h-48 items-center justify-center"><LogoSpinner imageClassName="h-7 w-7" /></div>
          ) : error ? (
            <EmptyUsageState title="Detailed usage unavailable" description={error} />
          ) : <InternalUsageTable items={internal.items} workspaceNames={workspaceNames} showWorkspace={!query.workspaceId} />}
        </TabsContent>
      </Tabs>

      {page.nextCursor && !isLoading && !error ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" onClick={() => void loadMore()} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading more…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
