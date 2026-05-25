'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, MessageSquareWarning, SlidersHorizontal, ThumbsDown, ThumbsUp } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { ConversationDrawer } from './conversation-drawer'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import {
  ActiveFilterPills,
  FilterDialog,
  countAppliedFilters,
  type FilterDefinition,
  type FilterValues,
} from '@/components/dashboard/shared/filters'
import { DashboardPagination } from '@/components/dashboard/shared/dashboard-pagination'
import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import {
  qualityApi,
  skillsApi,
  type QualityActionFilter,
  type QualityConversationStatus,
  type LowQualityTurn,
  type SkillCatalogEntry,
  type SkillOutcomeDefinition,
} from '@/lib/api'
import {
  buildDashboardHref,
  type DashboardRouteState,
  type QualityFeedbackFilter,
  type QualityLatencyFilter,
  type QualityStatusFilter,
} from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'

const PAGE_SIZE = 25

interface QualityViewProps {
  accountId: string
  routeState: DashboardRouteState
}

interface StatusMeta {
  label: string
  description: string
  tone: 'neutral' | 'warning'
}

interface LatencyBucketMeta {
  label: string
  minTotalLatencyMs?: number
  maxTotalLatencyMs?: number
}

const FEEDBACK_LABEL: Record<QualityFeedbackFilter, string> = {
  down: 'Thumbs down',
  up: 'Thumbs up',
}

const STATUS_META: Record<QualityConversationStatus, StatusMeta> = {
  success: {
    label: 'Completed',
    description: 'The assistant produced an answer.',
    tone: 'neutral',
  },
  failure: {
    label: 'Failed',
    description: 'The assistant turn ended in an error.',
    tone: 'warning',
  },
}

const STATUS_FILTERS: QualityStatusFilter[] = ['success', 'failure']

const LATENCY_BUCKETS: Record<QualityLatencyFilter, LatencyBucketMeta> = {
  lt_2s: {
    label: 'Under 2 seconds',
    maxTotalLatencyMs: 1999,
  },
  '2s_5s': {
    label: '2-5 seconds',
    minTotalLatencyMs: 2000,
    maxTotalLatencyMs: 4999,
  },
  '5s_10s': {
    label: '5-10 seconds',
    minTotalLatencyMs: 5000,
    maxTotalLatencyMs: 9999,
  },
  gte_10s: {
    label: '10 seconds or more',
    minTotalLatencyMs: 10000,
  },
}

const LATENCY_FILTERS: QualityLatencyFilter[] = ['lt_2s', '2s_5s', '5s_10s', 'gte_10s']

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const formatTimestamp = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateFormatter.format(date)
}

const formatDuration = (durationMs: number | null): string => {
  if (durationMs === null) {
    return '—'
  }
  if (durationMs < 1000) {
    return `${durationMs} ms`
  }
  const seconds = durationMs / 1000
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)} s`
}

const formatPageSummary = ({
  currentPage,
  pageSize,
  pageItemCount,
  totalItems,
}: {
  currentPage: number
  pageSize: number
  pageItemCount: number
  totalItems: number
}) => {
  const pageStart = totalItems === 0 ? 0 : (currentPage - 1) * pageSize
  const pageEnd = Math.min(pageStart + pageItemCount, totalItems)
  return `${pageStart + 1} to ${pageEnd} of ${totalItems}`
}

const getChannelLabel = (channel: string | null): string => {
  if (!channel) {
    return 'Dashboard chat'
  }
  if (channel === 'anonymous') {
    return 'Public chat'
  }
  if (channel === 'website_embed') {
    return 'Website embed'
  }
  if (channel === 'mcp') {
    return 'MCP'
  }
  return channel
}

const actionBadgeClass = (status: SkillOutcomeDefinition['status'] | undefined): string | undefined => {
  switch (status) {
    case 'failed':
    case 'expired':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'paused':
    case 'awaiting_confirmation':
    case 'awaiting_tool':
      return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    default:
      return undefined
  }
}

const statusBadgeClass = (tone: StatusMeta['tone']): string | undefined =>
  tone === 'warning'
    ? 'border-destructive/40 bg-destructive/10 text-destructive'
    : undefined

interface ActionLookup {
  skill: SkillCatalogEntry
  outcome: SkillOutcomeDefinition
}

const encodeAction = (skillName: string, outcome: string) => `${skillName}:${outcome}`

const decodeAction = (value: string): QualityActionFilter | null => {
  const colonIndex = value.indexOf(':')
  if (colonIndex <= 0 || colonIndex === value.length - 1) {
    return null
  }
  return { skillName: value.slice(0, colonIndex), outcome: value.slice(colonIndex + 1) }
}

const buildActionLookup = (skills: SkillCatalogEntry[]): Map<string, ActionLookup> => {
  const lookup = new Map<string, ActionLookup>()
  for (const skill of skills) {
    for (const outcome of skill.outcomes ?? []) {
      lookup.set(encodeAction(skill.name, outcome.name), { skill, outcome })
    }
  }
  return lookup
}

export function QualityView({ accountId, routeState }: QualityViewProps) {
  const router = useRouter()
  const { activeWorkspaceId } = useWorkspace()
  const hasComment = routeState.qualityHasComment ?? false
  const currentPage = routeState.qualityPage ?? 1
  // Serialized filter keys: routeState supplies a fresh array every render
  // (`?? []` makes the reference unstable), so we depend on stable strings.
  const actionsKey = (routeState.qualityActions ?? []).join(',')
  const statusesKey = (routeState.qualityStatuses ?? []).join(',')
  const feedbackKey = (routeState.qualityFeedback ?? []).join(',')
  const latency = routeState.qualityLatency

  const [items, setItems] = useState<LowQualityTurn[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null)
  const [openedConversation, setOpenedConversation] = useState<{
    conversationId: string
    assistantMessageId: string
  } | null>(null)
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogEntry[]>([])
  const drawerSelectedItem: SelectedHistoryItem = openedConversation
    ? { kind: 'chat', id: openedConversation.conversationId }
    : null

  const actions: string[] = actionsKey ? actionsKey.split(',') : []
  const statuses: QualityStatusFilter[] = statusesKey
    ? (statusesKey.split(',') as QualityStatusFilter[])
    : []
  const feedback: QualityFeedbackFilter[] = feedbackKey
    ? (feedbackKey.split(',') as QualityFeedbackFilter[])
    : []

  useEffect(() => {
    let cancelled = false
    const loadCatalog = async () => {
      try {
        const response = await skillsApi.list()
        if (!cancelled) {
          setSkillCatalog(response.skills)
        }
      } catch {
        // Skill catalog is purely cosmetic for the filter — failing to load it
        // shouldn't block the dashboard. Fall back to raw skill/outcome names.
      }
    }
    void loadCatalog()
    return () => {
      cancelled = true
    }
  }, [])

  const actionLookup = useMemo(() => buildActionLookup(skillCatalog), [skillCatalog])

  const actionFilterOptions = useMemo(
    () =>
      skillCatalog.flatMap((skill) =>
        (skill.outcomes ?? []).map((outcome) => ({
          value: encodeAction(skill.name, outcome.name),
          label: outcome.displayName,
          description: outcome.description ? `${skill.displayName} — ${outcome.description}` : skill.displayName,
        })),
      ),
    [skillCatalog],
  )

  const qualityFilters = useMemo<ReadonlyArray<FilterDefinition>>(
    () => [
      {
        id: 'status',
        kind: 'multi-select',
        label: 'Conversation status',
        options: STATUS_FILTERS.map((value) => ({
          value,
          label: STATUS_META[value].label,
          description: STATUS_META[value].description,
        })),
      },
      {
        id: 'action',
        kind: 'multi-select',
        label: 'Action type',
        options: actionFilterOptions,
      },
      {
        id: 'feedback',
        kind: 'multi-select',
        label: 'User rating',
        options: (Object.keys(FEEDBACK_LABEL) as QualityFeedbackFilter[]).map((value) => ({
          value,
          label: FEEDBACK_LABEL[value],
        })),
      },
      {
        id: 'latency',
        kind: 'single-select',
        label: 'Total latency',
        placeholder: 'Any latency',
        options: LATENCY_FILTERS.map((value) => ({
          value,
          label: LATENCY_BUCKETS[value].label,
        })),
      },
      {
        id: 'hasComment',
        kind: 'boolean',
        label: 'Has written feedback',
      },
    ],
    [actionFilterOptions],
  )

  const filterValues = useMemo<FilterValues>(() => {
    const next: FilterValues = {}
    if (statuses.length > 0) {
      next.status = { kind: 'multi-select', values: statuses }
    }
    if (actions.length > 0) {
      next.action = { kind: 'multi-select', values: actions }
    }
    if (feedback.length > 0) {
      next.feedback = { kind: 'multi-select', values: feedback }
    }
    if (hasComment) {
      next.hasComment = { kind: 'boolean', value: true }
    }
    if (latency) {
      next.latency = { kind: 'single-select', value: latency }
    }
    return next
    // statusesKey/actionsKey/feedbackKey/hasComment/latency together fully determine these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusesKey, actionsKey, feedbackKey, hasComment, latency])

  const appliedFilterCount = countAppliedFilters(filterValues)

  const navigateWith = useCallback(
    (next: Partial<DashboardRouteState>) => {
      const merged: DashboardRouteState = {
        ...routeState,
        section: 'quality',
        workspaceId: activeWorkspaceId ?? routeState.workspaceId,
        ...next,
      }
      router.push(buildDashboardHref(accountId, merged))
    },
    [accountId, activeWorkspaceId, router, routeState],
  )

  const applyFilters = useCallback(
    (next: FilterValues) => {
      const actionValue = next.action
      const statusValue = next.status
      const feedbackValue = next.feedback
      const latencyValue = next.latency
      const hasCommentValue = next.hasComment
      navigateWith({
        qualityStatuses:
          statusValue?.kind === 'multi-select' && statusValue.values.length > 0
            ? (statusValue.values as QualityStatusFilter[])
            : undefined,
        qualityActions:
          actionValue?.kind === 'multi-select' && actionValue.values.length > 0
            ? actionValue.values
            : undefined,
        qualityFeedback:
          feedbackValue?.kind === 'multi-select' && feedbackValue.values.length > 0
            ? (feedbackValue.values as QualityFeedbackFilter[])
            : undefined,
        qualityLatency:
          latencyValue?.kind === 'single-select'
            ? (latencyValue.value as QualityLatencyFilter)
            : undefined,
        qualityHasComment: hasCommentValue?.kind === 'boolean' ? true : undefined,
        qualityPage: undefined,
      })
    },
    [navigateWith],
  )

  const removeFilter = useCallback(
    (id: string) => {
      const next: FilterValues = { ...filterValues }
      delete next[id]
      applyFilters(next)
    },
    [applyFilters, filterValues],
  )

  const setPage = (next: number) =>
    navigateWith({ qualityPage: next > 1 ? next : undefined })

  useEffect(() => {
    let cancelled = false

    const actionTuples = actionsKey
      ? actionsKey
          .split(',')
          .map(decodeAction)
          .filter((entry): entry is QualityActionFilter => entry !== null)
      : undefined
    const statusesList = statusesKey ? (statusesKey.split(',') as QualityStatusFilter[]) : undefined
    const feedbackList = feedbackKey ? (feedbackKey.split(',') as QualityFeedbackFilter[]) : undefined
    const latencyBucket = latency ? LATENCY_BUCKETS[latency] : undefined

    const loadTurns = async () => {
      try {
        if (cancelled) {
          return
        }
        setIsFetching(true)
        setError(null)
        const page = await qualityApi.listTurns({
          actions: actionTuples && actionTuples.length > 0 ? actionTuples : undefined,
          statuses: statusesList,
          feedback: feedbackList,
          hasComment: hasComment || undefined,
          minTotalLatencyMs: latencyBucket?.minTotalLatencyMs,
          maxTotalLatencyMs: latencyBucket?.maxTotalLatencyMs,
          limit: PAGE_SIZE,
          offset: (currentPage - 1) * PAGE_SIZE,
        })

        if (cancelled) {
          return
        }
        setItems(page.items)
        setTotal(page.total)
        setTotalPages(page.totalPages)
      } catch (caught) {
        if (cancelled) {
          return
        }
        setError(caught instanceof Error ? caught.message : 'Failed to load assistant answers')
      } finally {
        if (!cancelled) {
          setIsFetching(false)
          setHasLoadedOnce(true)
        }
      }
    }

    void loadTurns()

    return () => {
      cancelled = true
    }
  }, [currentPage, feedbackKey, hasComment, latency, actionsKey, statusesKey])

  const openConversation = (turn: LowQualityTurn) =>
    setOpenedConversation({
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
    })

  const renderPagination = () => (
    <DashboardPagination
      summary={formatPageSummary({
        currentPage,
        pageSize: PAGE_SIZE,
        pageItemCount: items.length,
        totalItems: total,
      })}
      currentPage={currentPage}
      totalPages={totalPages}
      previousHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'quality',
        qualityPage: Math.max(1, currentPage - 1),
      })}
      nextHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'quality',
        qualityPage: Math.min(totalPages, currentPage + 1),
      })}
      onPrevious={() => setPage(Math.max(1, currentPage - 1))}
      onNext={() => setPage(Math.min(totalPages, currentPage + 1))}
    />
  )

  const filterButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setIsFilterDialogOpen(true)}
    >
      <SlidersHorizontal className="mr-2 h-4 w-4" />
      Filter
      {appliedFilterCount > 0 ? (
        <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
          {appliedFilterCount}
        </span>
      ) : null}
    </Button>
  )

  const headerPills =
    appliedFilterCount > 0 ? (
      <ActiveFilterPills filters={qualityFilters} values={filterValues} onRemove={removeFilter} />
    ) : null

  return (
    <>
    <DashboardPage
      title="Assistant answers to review"
      description="Browse assistant turns by conversation status, action type, user feedback, and response time."
      titleAccessory={<MessageSquareWarning className="h-4 w-4 text-muted-foreground" />}
      actions={filterButton}
      headerContent={headerPills}
    >
      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!hasLoadedOnce ? (
        <div className="flex min-h-48 items-center justify-center">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          {statuses.length === 0 && actions.length === 0 && feedback.length === 0 && !hasComment && !latency
            ? 'No assistant answers are available yet. Answers will show up here as your assistant handles traffic.'
            : 'No assistant answers match these filters. Try clearing one of them.'}
        </div>
      ) : (
        <div
          className={cn('space-y-4 transition-opacity', isFetching && 'opacity-60')}
          aria-busy={isFetching}
        >
          {renderPagination()}

          <DashboardTable aria-label="Assistant answers to review" minWidth="min-w-[1120px]">
            <DashboardTableHead>
              <DashboardTableHeader className="w-36">Agent</DashboardTableHeader>
              <DashboardTableHeader>Question &amp; answer</DashboardTableHeader>
              <DashboardTableHeader className="w-52">Action</DashboardTableHeader>
              <DashboardTableHeader className="w-32">Status</DashboardTableHeader>
              <DashboardTableHeader className="w-28">Latency</DashboardTableHeader>
              <DashboardTableHeader className="w-32">Feedback</DashboardTableHeader>
              <DashboardTableHeader className="w-44">When</DashboardTableHeader>
              <DashboardTableHeader className="w-24" />
            </DashboardTableHead>
            <DashboardTableBody>
              {items.map((turn) => {
                const actionKey = turn.skillName && turn.skillOutcome
                  ? encodeAction(turn.skillName, turn.skillOutcome)
                  : null
                const action = actionKey ? actionLookup.get(actionKey) ?? null : null
                const statusMeta = turn.conversationStatus ? STATUS_META[turn.conversationStatus] : null
                const isExpanded = expandedMessageId === turn.assistantMessageId
                const hasComments = turn.feedback.comments.length > 0
                const actionLabel = action
                  ? action.outcome.displayName
                  : turn.skillOutcome ?? null
                const actionTooltip = action
                  ? `${action.skill.displayName}${action.outcome.description ? ` — ${action.outcome.description}` : ''}`
                  : actionLabel ?? ''
                return (
                  <Fragment key={turn.assistantMessageId}>
                    <DashboardTableRow>
                      <DashboardTableCell className="w-36">
                        <div className="flex flex-col gap-0.5">
                          <span className="block truncate text-sm text-muted-foreground">
                            {turn.agentName ?? '—'}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {getChannelLabel(turn.channel)}
                          </span>
                        </div>
                      </DashboardTableCell>
                      <DashboardTableCell>
                        <p
                          className="block truncate text-sm font-medium leading-5 text-foreground"
                          title={turn.question ?? ''}
                        >
                          {turn.question || (
                            <span className="italic text-muted-foreground">(no preceding user message)</span>
                          )}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {turn.answerPreview}
                        </p>
                      </DashboardTableCell>
                      <DashboardTableCell className="w-52">
                        {actionLabel ? (
                          <Badge
                            variant={action ? 'secondary' : 'outline'}
                            className={cn('whitespace-nowrap', actionBadgeClass(action?.outcome.status))}
                            title={actionTooltip}
                            aria-label={actionTooltip || actionLabel}
                          >
                            {actionLabel}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </DashboardTableCell>
                      <DashboardTableCell className="w-32">
                        {statusMeta ? (
                          <Badge
                            variant={statusMeta.tone === 'neutral' ? 'secondary' : 'outline'}
                            className={cn('whitespace-nowrap', statusBadgeClass(statusMeta.tone))}
                            title={statusMeta.description}
                            aria-label={`${statusMeta.label}: ${statusMeta.description}`}
                          >
                            {statusMeta.label}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </DashboardTableCell>
                      <DashboardTableCell className="w-28 text-xs text-muted-foreground">
                        {formatDuration(turn.totalLatencyMs)}
                      </DashboardTableCell>
                      <DashboardTableCell className="w-32">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {turn.feedback.downCount > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <ThumbsDown className="h-3 w-3 text-destructive" />
                              {turn.feedback.downCount}
                            </span>
                          )}
                          {turn.feedback.upCount > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <ThumbsUp className="h-3 w-3 text-emerald-500" />
                              {turn.feedback.upCount}
                            </span>
                          )}
                          {turn.feedback.upCount === 0 && turn.feedback.downCount === 0 && (
                            <span>—</span>
                          )}
                        </div>
                      </DashboardTableCell>
                      <DashboardTableCell className="w-44 text-xs text-muted-foreground">
                        {formatTimestamp(turn.createdAt)}
                      </DashboardTableCell>
                      <DashboardTableCell className="w-24">
                        <div className="flex items-center justify-end gap-1">
                          {hasComments ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={isExpanded ? 'Hide comments' : 'Show comments'}
                              onClick={() =>
                                setExpandedMessageId(isExpanded ? null : turn.assistantMessageId)
                              }
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => openConversation(turn)}
                          >
                            Review
                          </Button>
                        </div>
                      </DashboardTableCell>
                    </DashboardTableRow>
                    {isExpanded && hasComments ? (
                      <DashboardTableRow className="bg-muted/20 hover:bg-muted/20">
                        <DashboardTableCell className="w-36">{null}</DashboardTableCell>
                        <DashboardTableCell>
                          <ul className="space-y-2">
                            {turn.feedback.comments.map((comment, index) => (
                              <li
                                key={`${turn.assistantMessageId}-${index}`}
                                className="rounded-md bg-background/70 px-3 py-2 text-xs"
                              >
                                <div className="mb-1 flex items-center gap-2 text-muted-foreground">
                                  {comment.value === 'down' ? (
                                    <ThumbsDown className="h-3 w-3 text-destructive" />
                                  ) : (
                                    <ThumbsUp className="h-3 w-3 text-emerald-500" />
                                  )}
                                  <span>{formatTimestamp(comment.createdAt)}</span>
                                </div>
                                <p className="text-foreground">{comment.comment}</p>
                              </li>
                            ))}
                          </ul>
                        </DashboardTableCell>
                        <DashboardTableCell className="w-52">{null}</DashboardTableCell>
                        <DashboardTableCell className="w-32">{null}</DashboardTableCell>
                        <DashboardTableCell className="w-28">{null}</DashboardTableCell>
                        <DashboardTableCell className="w-32">{null}</DashboardTableCell>
                        <DashboardTableCell className="w-44">{null}</DashboardTableCell>
                        <DashboardTableCell className="w-24">{null}</DashboardTableCell>
                      </DashboardTableRow>
                    ) : null}
                  </Fragment>
                )
              })}
            </DashboardTableBody>
          </DashboardTable>

          {renderPagination()}
        </div>
      )}
    </DashboardPage>
    <FilterDialog
      open={isFilterDialogOpen}
      onOpenChange={setIsFilterDialogOpen}
      filters={qualityFilters}
      values={filterValues}
      title="Filter assistant answers"
      description="Choose the statuses, actions, feedback, and latency band you want to inspect."
      onApply={applyFilters}
    />
    <ConversationDrawer
      selectedItem={drawerSelectedItem}
      onSelectedItemChange={(next) => {
        if (!next) {
          setOpenedConversation(null)
        }
      }}
      anchorMessageId={openedConversation?.assistantMessageId ?? null}
      onAfterClose={() => setOpenedConversation(null)}
    />
    </>
  )
}
