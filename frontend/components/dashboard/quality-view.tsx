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
  type LowQualityTurn,
  type SkillCatalogEntry,
  type SkillOwner,
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
  tone: BadgeTone
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

const STATUS_META: Record<QualityStatusFilter, StatusMeta> = {
  completed: {
    label: 'Completed',
    description: 'The skill finished its work for this turn.',
    tone: 'neutral',
  },
  failed: {
    label: 'Failed',
    description: 'The skill could not complete its work.',
    tone: 'warning',
  },
  expired: {
    label: 'Expired',
    description: 'The skill timed out before completing.',
    tone: 'warning',
  },
  paused: {
    label: 'Paused',
    description: 'The skill is waiting on the user before it can continue.',
    tone: 'info',
  },
  awaiting_confirmation: {
    label: 'Awaiting confirmation',
    description: 'The skill is waiting for the user to confirm before continuing.',
    tone: 'info',
  },
  awaiting_tool: {
    label: 'Awaiting tool',
    description: 'The skill is waiting on an external tool or workflow.',
    tone: 'info',
  },
  active: {
    label: 'In progress',
    description: 'The skill is still running.',
    tone: 'info',
  },
  cancelled: {
    label: 'Cancelled',
    description: 'The skill was cancelled before completing.',
    tone: 'muted',
  },
}

const STATUS_FILTERS: QualityStatusFilter[] = [
  'completed',
  'paused',
  'awaiting_confirmation',
  'awaiting_tool',
  'failed',
  'expired',
  'cancelled',
  'active',
]

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

type BadgeTone = 'positive' | 'neutral' | 'info' | 'warning' | 'muted'

const actionBadgeTone = (outcome: SkillOutcomeDefinition | undefined): BadgeTone => {
  if (!outcome) {
    return 'neutral'
  }
  if (outcome.tone) {
    return outcome.tone
  }
  // Fallback: derive a tone from status + groundedAnswer for skill outcomes that
  // haven't yet declared one. Keeps unknown future outcomes visually coherent.
  if (outcome.status === 'failed' || outcome.status === 'expired') {
    return 'warning'
  }
  if (outcome.status === 'completed' && outcome.groundedAnswer === false) {
    return 'warning'
  }
  if (
    outcome.status === 'paused'
    || outcome.status === 'awaiting_confirmation'
    || outcome.status === 'awaiting_tool'
  ) {
    return 'info'
  }
  if (outcome.status === 'cancelled') {
    return 'muted'
  }
  return 'neutral'
}

const badgeToneClass = (tone: BadgeTone): string | undefined => {
  switch (tone) {
    case 'positive':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'warning':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'info':
      return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    case 'muted':
      return 'border-muted-foreground/30 bg-muted text-muted-foreground'
    default:
      return undefined
  }
}

const resolveStatusMeta = (skillStatus: string | null): StatusMeta | null => {
  if (!skillStatus) {
    return null
  }
  return (STATUS_META as Record<string, StatusMeta | undefined>)[skillStatus] ?? null
}

interface ActionLookup {
  skill: SkillCatalogEntry
  outcome: SkillOutcomeDefinition
}

interface ActionFilterGroup {
  id: string
  label: string
  options: Array<{
    value: string
    label: string
    description?: string
  }>
}

const encodeAction = (skillName: string, outcome: string) => `${skillName}:${outcome}`

const ACTION_GROUP_META: Record<SkillOwner | 'other', { id: string; label: string; order: number }> = {
  assistant: { id: 'action-assistant', label: 'Assistant response', order: 0 },
  retrieval: { id: 'action-retrieval', label: 'Retrieval outcome', order: 1 },
  contact: { id: 'action-contact', label: 'Contact handoff', order: 2 },
  documents: { id: 'action-documents', label: 'Document action', order: 3 },
  mcp: { id: 'action-mcp', label: 'MCP action', order: 4 },
  platform: { id: 'action-platform', label: 'Platform action', order: 5 },
  auth: { id: 'action-auth', label: 'Authentication action', order: 6 },
  other: { id: 'action-other', label: 'Other action', order: 7 },
}

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

const formatActionFallbackLabel = (encodedAction: string): string => {
  const decoded = decodeAction(encodedAction)
  return decoded?.outcome.replaceAll('_', ' ') ?? encodedAction
}

export function QualityView({ accountId, routeState }: QualityViewProps) {
  const router = useRouter()
  const { activeWorkspaceId } = useWorkspace()
  const hasComment = routeState.qualityHasComment ?? false
  const currentPage = routeState.qualityPage ?? 1
  // Serialized filter keys: routeState supplies a fresh array every render
  // (`?? []` makes the reference unstable), so we depend on stable strings.
  const actionsKey = (routeState.qualityActions ?? [])
    .map((action) => encodeAction(action.skillName, action.outcome))
    .join(',')
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

  const actions = useMemo<string[]>(() => (actionsKey ? actionsKey.split(',') : []), [actionsKey])
  const statuses = useMemo<QualityStatusFilter[]>(
    () => (statusesKey ? (statusesKey.split(',') as QualityStatusFilter[]) : []),
    [statusesKey],
  )
  const feedback = useMemo<QualityFeedbackFilter[]>(
    () => (feedbackKey ? (feedbackKey.split(',') as QualityFeedbackFilter[]) : []),
    [feedbackKey],
  )

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

  const actionFilterGroups = useMemo<ActionFilterGroup[]>(() => {
    const groups = new Map<string, ActionFilterGroup>()

    for (const skill of skillCatalog) {
      const meta = ACTION_GROUP_META[skill.owner] ?? ACTION_GROUP_META.other
      const group = groups.get(meta.id) ?? { id: meta.id, label: meta.label, options: [] }
      for (const outcome of skill.outcomes ?? []) {
        group.options.push({
          value: encodeAction(skill.name, outcome.name),
          label: outcome.displayName,
          description: outcome.description ? `${skill.displayName} — ${outcome.description}` : skill.displayName,
        })
      }
      if (group.options.length > 0) {
        groups.set(meta.id, group)
      }
    }

    const knownActionValues = new Set(
      [...groups.values()].flatMap((group) => group.options.map((option) => option.value)),
    )
    const fallbackOptions = actions
      .filter((value) => !knownActionValues.has(value))
      .map((value) => ({
        value,
        label: actionLookup.get(value)?.outcome.displayName ?? formatActionFallbackLabel(value),
        description: actionLookup.get(value)?.skill.displayName,
      }))

    if (fallbackOptions.length > 0) {
      const meta = ACTION_GROUP_META.other
      const group = groups.get(meta.id) ?? { id: meta.id, label: meta.label, options: [] }
      group.options.push(...fallbackOptions)
      groups.set(meta.id, group)
    }

    return [...groups.values()].sort((left, right) => {
      const leftOrder = Object.values(ACTION_GROUP_META).find((meta) => meta.id === left.id)?.order ?? 99
      const rightOrder = Object.values(ACTION_GROUP_META).find((meta) => meta.id === right.id)?.order ?? 99
      return leftOrder - rightOrder
    })
  }, [actionLookup, actions, skillCatalog])

  const qualityFilters = useMemo<ReadonlyArray<FilterDefinition>>(
    () => [
      {
        id: 'status',
        kind: 'multi-select',
        label: 'Conversation status',
        presentation: 'pills',
        options: STATUS_FILTERS.map((value) => ({
          value,
          label: STATUS_META[value].label,
          description: STATUS_META[value].description,
        })),
      },
      ...actionFilterGroups.map((group) => ({
        id: group.id,
        kind: 'multi-select' as const,
        label: group.label,
        options: group.options,
      })),
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
    [actionFilterGroups],
  )

  const filterValues = useMemo<FilterValues>(() => {
    const next: FilterValues = {}
    if (statuses.length > 0) {
      next.status = { kind: 'multi-select', values: statuses }
    }
    if (actions.length > 0) {
      const unassignedActions = new Set(actions)
      for (const group of actionFilterGroups) {
        const groupValues = group.options
          .map((option) => option.value)
          .filter((value) => unassignedActions.has(value))
        if (groupValues.length > 0) {
          next[group.id] = { kind: 'multi-select', values: groupValues }
          for (const value of groupValues) {
            unassignedActions.delete(value)
          }
        }
      }
      if (unassignedActions.size > 0) {
        next[ACTION_GROUP_META.other.id] = {
          kind: 'multi-select',
          values: [...unassignedActions],
        }
      }
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
    // statusesKey/actionsKey/feedbackKey/hasComment/latency plus the loaded action catalog
    // together fully determine these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusesKey, actionsKey, actionFilterGroups, feedbackKey, hasComment, latency])

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
      const actionValues = actionFilterGroups.flatMap((group) => {
        const value = next[group.id]
        return value?.kind === 'multi-select' ? value.values : []
      })
      const statusValue = next.status
      const feedbackValue = next.feedback
      const latencyValue = next.latency
      const hasCommentValue = next.hasComment
      const uniqueActionValues = [...new Set(actionValues)]
      navigateWith({
        qualityStatuses:
          statusValue?.kind === 'multi-select' && statusValue.values.length > 0
            ? (statusValue.values as QualityStatusFilter[])
            : undefined,
        qualityActions:
          uniqueActionValues.length > 0
            ? uniqueActionValues
                .map(decodeAction)
                .filter((entry): entry is QualityActionFilter => entry !== null)
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
    [actionFilterGroups, navigateWith],
  )

  const removeFilter = (id: string) => {
    const next: FilterValues = { ...filterValues }
    delete next[id]
    applyFilters(next)
  }

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
            ? 'No assistant turns are available yet. Turns will show up here as your assistant handles traffic.'
            : 'No assistant turns match these filters. Try clearing one of them.'}
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
                const statusMeta = resolveStatusMeta(turn.skillStatus)
                const isExpanded = expandedMessageId === turn.assistantMessageId
                const hasComments = turn.feedback.comments.length > 0
                const actionLabel = action
                  ? action.outcome.displayName
                  : turn.skillOutcome ?? null
                const actionTone = actionBadgeTone(action?.outcome)
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
                            variant={action && actionTone === 'neutral' ? 'secondary' : 'outline'}
                            className={cn('whitespace-nowrap', badgeToneClass(actionTone))}
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
                            className={cn('whitespace-nowrap', badgeToneClass(statusMeta.tone))}
                            title={statusMeta.description}
                            aria-label={`${statusMeta.label}: ${statusMeta.description}`}
                          >
                            {statusMeta.label}
                          </Badge>
                        ) : turn.skillStatus ? (
                          <Badge variant="outline" className="whitespace-nowrap" aria-label={turn.skillStatus}>
                            {turn.skillStatus}
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
