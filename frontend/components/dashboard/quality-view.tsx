'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChevronDown,
  CircleX,
  Clock,
  FileSearch,
  MessageSquareWarning,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { DashboardPaginatedContent } from '@/components/dashboard/shared/dashboard-paginated-content'
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
  type QualityTriageState,
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
  type QualityTriageFilter,
} from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'
import {
  activeQualitySignal,
  groundingGapActions,
  ACTIVE_TRIAGE_STATES,
  SKILL_FAILURE_STATUSES,
  SLOW_RESPONSE_LATENCY_BUCKET,
  type QualitySignalId,
} from '@/lib/quality-signals'

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

interface QualitySignalDefinition {
  id: QualitySignalId
  label: string
  description: string
  icon: typeof ThumbsDown
  iconClass: string
}

const QUALITY_SIGNALS: ReadonlyArray<QualitySignalDefinition> = [
  {
    id: 'negative_feedback',
    label: 'Negative feedback',
    description: 'Answers users rated thumbs-down',
    icon: ThumbsDown,
    iconClass: 'text-destructive',
  },
  {
    id: 'grounding_gaps',
    label: 'Grounding gaps',
    description: 'No context or degraded evidence',
    icon: FileSearch,
    iconClass: 'text-amber-600 dark:text-amber-400',
  },
  {
    id: 'slow_responses',
    label: 'Slow responses',
    description: '10 seconds or more to answer',
    icon: Clock,
    iconClass: 'text-muted-foreground',
  },
  {
    id: 'skill_failures',
    label: 'Skill failures',
    description: 'The turn’s skill ended in failure',
    icon: CircleX,
    iconClass: 'text-destructive',
  },
]

function QualitySignalTile({
  signal,
  count,
  active,
  onSelect,
}: {
  signal: QualitySignalDefinition
  count: number | null
  active: boolean
  onSelect: (id: QualitySignalId | null) => void
}) {
  const Icon = signal.icon
  return (
    <button
      type="button"
      onClick={() => onSelect(active ? null : signal.id)}
      aria-pressed={active}
      className={cn(
        'flex items-start justify-between gap-3 rounded-lg border bg-card p-4 text-left transition-colors',
        'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active ? 'border-primary ring-1 ring-primary/30' : 'border-border',
      )}
    >
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{signal.label}</p>
        <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {count === null ? '—' : count}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{signal.description}</p>
      </div>
      <Icon className={cn('h-4 w-4 shrink-0', signal.iconClass)} aria-hidden />
    </button>
  )
}

function QualitySignalsBar({
  counts,
  activeSignal,
  onSelect,
}: {
  counts: Record<QualitySignalId, number | null>
  activeSignal: QualitySignalId | null
  onSelect: (id: QualitySignalId | null) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {QUALITY_SIGNALS.map((signal) => (
        <QualitySignalTile
          key={signal.id}
          signal={signal}
          count={counts[signal.id]}
          active={activeSignal === signal.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

const TRIAGE_STATE_ORDER: QualityTriageState[] = ['open', 'acknowledged', 'resolved', 'dismissed']

const TRIAGE_STATE_META: Record<QualityTriageState, { label: string; className: string }> = {
  open: { label: 'Open', className: 'border-border bg-muted text-muted-foreground' },
  acknowledged: {
    label: 'Acknowledged',
    className: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
  resolved: {
    label: 'Resolved',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  dismissed: {
    label: 'Dismissed',
    className: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  },
}

function TriageStateControl({
  state,
  pending,
  onChange,
}: {
  state: QualityTriageState
  pending: boolean
  onChange: (next: QualityTriageState) => void
}) {
  const meta = TRIAGE_STATE_META[state]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending}
          aria-label={`Triage state: ${meta.label}. Change state.`}
          // Keep clicks off the surrounding row (which opens the conversation);
          // Radix still opens the menu since stopPropagation doesn't preventDefault.
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            meta.className,
          )}
        >
          <span className="truncate">{meta.label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Triage state</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={state}
          onValueChange={(value) => onChange(value as QualityTriageState)}
        >
          {TRIAGE_STATE_ORDER.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {TRIAGE_STATE_META[value].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  const triageKey = (routeState.qualityTriageStates ?? []).join(',')
  const latency = routeState.qualityLatency

  const [items, setItems] = useState<LowQualityTurn[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openedConversation, setOpenedConversation] = useState<{
    conversationId: string
    assistantMessageId: string
  } | null>(null)
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogEntry[]>([])
  const [signalCounts, setSignalCounts] = useState<Record<QualitySignalId, number | null>>({
    negative_feedback: null,
    grounding_gaps: null,
    slow_responses: null,
    skill_failures: null,
  })
  const [pendingTriageId, setPendingTriageId] = useState<string | null>(null)
  // Bumped after a triage change so the active-backlog signal counts refetch.
  const [countsRefreshKey, setCountsRefreshKey] = useState(0)
  // Bumped after a triage change so server-filtered rows/totals stay current.
  const [turnsRefreshKey, setTurnsRefreshKey] = useState(0)
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
  const triageStates = useMemo<QualityTriageFilter[]>(
    () => (triageKey ? (triageKey.split(',') as QualityTriageFilter[]) : []),
    [triageKey],
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

  const groundingActions = useMemo(() => groundingGapActions(skillCatalog), [skillCatalog])

  const decodedActions = useMemo<QualityActionFilter[]>(
    () =>
      actions
        .map(decodeAction)
        .filter((entry): entry is QualityActionFilter => entry !== null),
    [actions],
  )

  const activeSignal = useMemo(
    () =>
      activeQualitySignal(
        { feedback, actions: decodedActions, statuses, triageStates, latency: latency ?? null },
        groundingActions,
      ),
    [feedback, decodedActions, statuses, triageStates, latency, groundingActions],
  )

  // Stable dependency for the count effect: groundingActions is a fresh array
  // each render, so depend on its serialized form instead.
  const groundingActionsKey = groundingActions
    .map((action) => encodeAction(action.skillName, action.outcome))
    .join(',')

  // Signal counts are the at-a-glance triage totals across the whole dataset,
  // independent of the current page or applied filters — cheap `total`-only
  // probes that reuse the same filters the tiles apply when clicked.
  useEffect(() => {
    let cancelled = false

    const countFor = async (
      options: Parameters<typeof qualityApi.listTurns>[0],
    ): Promise<number | null> => {
      try {
        const page = await qualityApi.listTurns({ ...options, offset: 0, limit: 1 })
        return page.total
      } catch {
        // Signals are an enhancement over the table; a failed probe shows "—"
        // rather than blocking the page.
        return null
      }
    }

    // Only count the active backlog so resolved/dismissed turns drain out.
    const triageStatesFilter = [...ACTIVE_TRIAGE_STATES]
    const loadSignalCounts = async () => {
      const [negative, grounding, slow, failures] = await Promise.all([
        countFor({ feedback: ['down'], triageStates: triageStatesFilter }),
        groundingActions.length > 0
          ? countFor({ actions: groundingActions, triageStates: triageStatesFilter })
          : Promise.resolve(0),
        countFor({
          minTotalLatencyMs: LATENCY_BUCKETS[SLOW_RESPONSE_LATENCY_BUCKET].minTotalLatencyMs,
          triageStates: triageStatesFilter,
        }),
        countFor({ statuses: [...SKILL_FAILURE_STATUSES], triageStates: triageStatesFilter }),
      ])
      if (!cancelled) {
        setSignalCounts({
          negative_feedback: negative,
          grounding_gaps: grounding,
          slow_responses: slow,
          skill_failures: failures,
        })
      }
    }

    void loadSignalCounts()
    return () => {
      cancelled = true
    }
    // groundingActionsKey fully captures the grounding-action dependency;
    // countsRefreshKey forces a refetch after a triage change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groundingActionsKey, countsRefreshKey])

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
        label: 'Rating',
        options: (Object.keys(FEEDBACK_LABEL) as QualityFeedbackFilter[]).map((value) => ({
          value,
          label: FEEDBACK_LABEL[value],
        })),
      },
      {
        id: 'hasComment',
        kind: 'boolean',
        label: 'Has a written comment',
      },
      {
        id: 'triage',
        kind: 'multi-select',
        label: 'Triage state',
        options: TRIAGE_STATE_ORDER.map((value) => ({
          value,
          label: TRIAGE_STATE_META[value].label,
        })),
      },
      {
        id: 'latency',
        kind: 'single-select',
        label: 'Response time',
        placeholder: 'Any latency',
        options: LATENCY_FILTERS.map((value) => ({
          value,
          label: LATENCY_BUCKETS[value].label,
        })),
      },
    ],
    [actionFilterGroups],
  )

  // Presentation grouping for the filter dialog: high-signal filters open by
  // default; the per-skill action groups collapse under one "Assistant outcome".
  const qualitySections = useMemo(
    () => [
      { id: 'status', label: 'Conversation status', defaultOpen: true, filterIds: ['status'] },
      { id: 'feedback', label: 'Feedback', defaultOpen: true, filterIds: ['feedback', 'hasComment'] },
      { id: 'triage', label: 'Triage state', defaultOpen: true, filterIds: ['triage'] },
      {
        id: 'outcome',
        label: 'Assistant outcome',
        defaultOpen: false,
        filterIds: actionFilterGroups.map((group) => group.id),
      },
      { id: 'latency', label: 'Response time', defaultOpen: false, filterIds: ['latency'] },
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
    if (triageStates.length > 0) {
      next.triage = { kind: 'multi-select', values: triageStates }
    }
    if (hasComment) {
      next.hasComment = { kind: 'boolean', value: true }
    }
    if (latency) {
      next.latency = { kind: 'single-select', value: latency }
    }
    return next
    // statusesKey/actionsKey/feedbackKey/triageKey/hasComment/latency plus the loaded action catalog
    // together fully determine these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusesKey, actionsKey, actionFilterGroups, feedbackKey, triageKey, hasComment, latency])

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
      const triageValue = next.triage
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
        qualityTriageStates:
          triageValue?.kind === 'multi-select' && triageValue.values.length > 0
            ? (triageValue.values as QualityTriageFilter[])
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

  // Selecting a signal narrows the table to that active issue class and clears
  // other filters; selecting the active signal again (null) clears it.
  const applySignal = (signalId: QualitySignalId | null) => {
    navigateWith({
      qualityFeedback: signalId === 'negative_feedback' ? ['down'] : undefined,
      qualityActions: signalId === 'grounding_gaps' ? groundingActions : undefined,
      qualityLatency: signalId === 'slow_responses' ? SLOW_RESPONSE_LATENCY_BUCKET : undefined,
      qualityStatuses: signalId === 'skill_failures' ? [...SKILL_FAILURE_STATUSES] : undefined,
      qualityTriageStates: signalId ? [...ACTIVE_TRIAGE_STATES] : undefined,
      qualityHasComment: undefined,
      qualityPage: undefined,
    })
  }

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
    const triageList = triageKey ? (triageKey.split(',') as QualityTriageState[]) : undefined
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
          triageStates: triageList,
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
  }, [currentPage, feedbackKey, hasComment, latency, actionsKey, statusesKey, triageKey, turnsRefreshKey])

  const openConversation = (turn: LowQualityTurn) =>
    setOpenedConversation({
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
    })

  // Optimistically reflect the new state on the row and refresh the active
  // backlog counts; a failed update reverts and surfaces an error.
  const updateTriageState = async (turn: LowQualityTurn, next: QualityTriageState) => {
    if (turn.triage.state === next || pendingTriageId === turn.assistantMessageId) {
      return
    }
    setPendingTriageId(turn.assistantMessageId)
    try {
      const record = await qualityApi.setTriageState(turn.assistantMessageId, { state: next })
      setItems((prev) =>
        prev.map((item) =>
          item.assistantMessageId === turn.assistantMessageId ? { ...item, triage: record } : item,
        ),
      )
      setCountsRefreshKey((key) => key + 1)
      setTurnsRefreshKey((key) => key + 1)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update triage state')
    } finally {
      setPendingTriageId((current) => (current === turn.assistantMessageId ? null : current))
    }
  }

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
      title="Quality review"
      description="Triage the answers that need attention — negative feedback, grounding gaps, and slow responses — then open the conversation to act."
      titleAccessory={<MessageSquareWarning className="h-4 w-4 text-muted-foreground" />}
      actions={filterButton}
      headerContent={headerPills}
    >
      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mb-6">
        <QualitySignalsBar
          counts={signalCounts}
          activeSignal={activeSignal}
          onSelect={applySignal}
        />
      </div>

      {!hasLoadedOnce ? (
        <div className="flex min-h-48 items-center justify-center">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          {statuses.length === 0 && actions.length === 0 && feedback.length === 0 && triageStates.length === 0 && !hasComment && !latency
            ? 'No assistant turns are available yet. Turns will show up here as your assistant handles traffic.'
            : 'No assistant turns match these filters. Try clearing one of them.'}
        </div>
      ) : (
        <DashboardPaginatedContent className="space-y-4" isRefreshing={isFetching}>
          {renderPagination()}

          <DashboardTable aria-label="Assistant answers to review" minWidth="min-w-[936px]">
            <DashboardTableHead>
              <DashboardTableHeader className="w-32">Agent</DashboardTableHeader>
              <DashboardTableHeader>Question &amp; answer</DashboardTableHeader>
              <DashboardTableHeader className="w-40">Action</DashboardTableHeader>
              <DashboardTableHeader className="w-28">Status</DashboardTableHeader>
              <DashboardTableHeader className="w-20">Latency</DashboardTableHeader>
              <DashboardTableHeader className="w-20">Feedback</DashboardTableHeader>
              <DashboardTableHeader className="w-32">When</DashboardTableHeader>
              <DashboardTableHeader className="w-40">Triage</DashboardTableHeader>
            </DashboardTableHead>
            <DashboardTableBody>
              {items.map((turn) => {
                const actionKey = turn.skillName && turn.skillOutcome
                  ? encodeAction(turn.skillName, turn.skillOutcome)
                  : null
                const action = actionKey ? actionLookup.get(actionKey) ?? null : null
                const statusMeta = resolveStatusMeta(turn.skillStatus)
                const actionLabel = action
                  ? action.outcome.displayName
                  : turn.skillOutcome ?? null
                const actionTone = actionBadgeTone(action?.outcome)
                const actionTooltip = action
                  ? `${action.skill.displayName}${action.outcome.description ? ` — ${action.outcome.description}` : ''}`
                  : actionLabel ?? ''
                return (
                    <DashboardTableRow
                      key={turn.assistantMessageId}
                      onClick={() => openConversation(turn)}
                      className="cursor-pointer"
                    >
                      <DashboardTableCell className="w-32">
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
                        <button
                          type="button"
                          onClick={() => openConversation(turn)}
                          title={turn.question ?? ''}
                          className="block max-w-full truncate text-left text-sm font-medium leading-5 text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        >
                          {turn.question || (
                            <span className="italic text-muted-foreground">(no preceding user message)</span>
                          )}
                        </button>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {turn.answerPreview}
                        </p>
                      </DashboardTableCell>
                      <DashboardTableCell className="w-40">
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
                      <DashboardTableCell className="w-28">
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
                      <DashboardTableCell className="w-20 text-xs text-muted-foreground">
                        {formatDuration(turn.totalLatencyMs)}
                      </DashboardTableCell>
                      <DashboardTableCell className="w-20">
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
                      <DashboardTableCell className="w-32 text-xs text-muted-foreground">
                        {formatTimestamp(turn.createdAt)}
                      </DashboardTableCell>
                      <DashboardTableCell className="w-40">
                        <TriageStateControl
                          state={turn.triage.state}
                          pending={pendingTriageId === turn.assistantMessageId}
                          onChange={(next) => void updateTriageState(turn, next)}
                        />
                      </DashboardTableCell>
                    </DashboardTableRow>
                )
              })}
            </DashboardTableBody>
          </DashboardTable>

          {renderPagination()}
        </DashboardPaginatedContent>
      )}
    </DashboardPage>
    <FilterDialog
      open={isFilterDialogOpen}
      onOpenChange={setIsFilterDialogOpen}
      filters={qualityFilters}
      sections={qualitySections}
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
