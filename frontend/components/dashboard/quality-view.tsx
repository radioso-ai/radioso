'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ChevronDown,
  CircleX,
  Clock,
  FileSearch,
  ListFilter,
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
  getQualityTriageConflict,
  qualityApi,
  evalsApi,
  skillsApi,
  QUALITY_SIGNAL_IDS,
  GROUNDING_VERDICTS,
  QUALITY_RESOLUTION_REASONS,
  type GroundingVerdict,
  type QualityActionFilter,
  type LowQualityTurn,
  type QualitySignalId,
  type QualityStats,
  type QualityStatsRange,
  type QualityTriageRecord,
  type QualityTriageState,
  type QualityResolutionBreakdownReason,
  type SkillCatalogEntry,
  type SkillOwner,
  type SkillOutcomeDefinition,
} from '@/lib/api'
import { contentPlanApi } from '@/lib/api-content-plan'
import { getApiErrorMessage, getApiErrorStatus } from '@/lib/api-error'
import {
  buildDashboardHref,
  DEFAULT_QUALITY_RANGE,
  type DashboardRouteState,
  type QualityFeedbackFilter,
  type QualityLatencyFilter,
  type QualitySortFilter,
  type QualityStatusFilter,
  type QualityTriageFilter,
  type QualityResolutionReasonFilter,
} from '@/lib/dashboard-routes'
import { buildQualityTurnEvalRoute } from '@/lib/workbench-handoffs'
import { useWorkspace } from '@/lib/workspace-context'
import {
  isTerminalQualityTriageState,
  resolveQueueScope,
} from '@/lib/quality-signals'
import { QualityHealthRow } from '@/components/dashboard/quality/quality-health-row'
import {
  CloseReviewPopover,
  REASON_LABELS,
  type CloseReviewInput,
} from '@/components/dashboard/quality/close-review-popover'
import { EvalVerificationAction } from '@/components/dashboard/quality/eval-verification-action'
import { ResolutionBreakdown } from '@/components/dashboard/quality/resolution-breakdown'

const PAGE_SIZE = 25

const CLEARED_QUALITY_QUEUE_ROUTE_STATE = {
  qualitySignal: undefined,
  qualityShowAll: undefined,
  qualityActions: undefined,
  qualityStatuses: undefined,
  qualityFeedback: undefined,
  qualityLatency: undefined,
  qualitySort: undefined,
  qualityTriageStates: undefined,
  qualityResolutionReasons: undefined,
  qualityResolutionFrom: undefined,
  qualityResolutionTo: undefined,
  qualityActiveNegativeFeedbackOnly: undefined,
  qualityHasComment: undefined,
  qualityGroundingVerdicts: undefined,
  qualityHasUnsourcedClaims: undefined,
  qualityHasInvalidSources: undefined,
  qualityPage: undefined,
} satisfies Partial<DashboardRouteState>

const focusQualityQueueTarget = (assistantMessageId: string | null) => {
  window.requestAnimationFrame(() => {
    const selector = assistantMessageId
      ? `[data-quality-triage-id="${CSS.escape(assistantMessageId)}"]`
      : '[data-quality-queue-heading]'
    const target = document.querySelector<HTMLElement>(selector)
      ?? document.querySelector<HTMLElement>('[data-quality-queue-heading]')
    target?.focus()
  })
}

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

const GROUNDING_VERDICT_LABEL: Record<GroundingVerdict, string> = {
  grounded: 'Grounded',
  degraded: 'Degraded',
  no_support: 'No support',
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
  contact: { id: 'action-contact', label: 'Contact request', order: 2 },
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

/**
 * Keyed by the API's signal union rather than listed as an array, so a signal added to the
 * contract fails to compile here until it has a label and an icon. Deriving the chips from
 * `QUALITY_SIGNAL_IDS` alone would render a nameless chip instead of failing the build —
 * a broken affordance is worse than a missing one.
 */
const QUALITY_SIGNAL_PRESENTATION: Record<
  QualitySignalId,
  Omit<QualitySignalDefinition, 'id'>
> = {
  negative_feedback: {
    label: 'Negative feedback',
    description: 'Answers users rated thumbs-down',
    icon: ThumbsDown,
    iconClass: 'text-destructive',
  },
  grounding_gaps: {
    label: 'Grounding gaps',
    description: 'No context or degraded evidence',
    icon: FileSearch,
    iconClass: 'text-amber-600 dark:text-amber-400',
  },
  slow_responses: {
    label: 'Slow responses',
    description: '10 seconds or more to answer',
    icon: Clock,
    iconClass: 'text-muted-foreground',
  },
  skill_failures: {
    label: 'Skill failures',
    description: 'The turn’s skill ended in failure',
    icon: CircleX,
    iconClass: 'text-destructive',
  },
}

// Order and completeness come from the canonical contract array; the presentation record
// guarantees every entry in it has something to render.
const QUALITY_SIGNALS: ReadonlyArray<QualitySignalDefinition> = QUALITY_SIGNAL_IDS.map((id) => ({
  id,
  ...QUALITY_SIGNAL_PRESENTATION[id],
}))

/**
 * Banner shown when the operator arrives at Quality from a Content plan topic.
 * The queue is filtered to the topic's current-window members through the
 * content-plan member-turn endpoint; this affordance keeps a valid return path.
 */
function ContentPlanReturnBanner({
  topicId,
  contentPlanHref,
}: {
  topicId: string
  contentPlanHref: string
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-foreground"
      data-content-plan-return
      data-content-plan-topic-id={topicId}
    >
      <p className="min-w-0">
        Filtered to a Content plan topic&apos;s current-window answers.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href={contentPlanHref}>Return to Content plan topic</Link>
      </Button>
    </div>
  )
}

function QualityTurnsLoadFailure({
  topicScoped,
  message,
  onRetry,
}: {
  topicScoped: boolean
  message: string
  onRetry: () => void
}) {
  return (
    <div
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
      role="alert"
      aria-live="assertive"
    >
      <h3 className="font-medium text-destructive">
        {topicScoped ? 'Could not load this topic’s answers' : 'Could not load assistant answers'}
      </h3>
      <p className="mt-1 text-destructive">{message}</p>
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

/**
 * Count-forward filter preset for the queue. The count is the all-time active
 * backlog, so it never disagrees with what clicking the chip shows.
 */
function QualitySignalChip({
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
      title={signal.description}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/30' : 'border-border text-muted-foreground',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', signal.iconClass)} aria-hidden />
      <span className="tabular-nums text-sm font-semibold text-foreground">
        {count === null ? '—' : count}
      </span>
      <span>{signal.label}</span>
    </button>
  )
}

/**
 * The escape hatch from the queue's default. The default hides healthy answers, which is
 * the point — but an operator who wants to browse everything must be able to say so, and
 * to share that link.
 */
function AllAnswersToggle({
  active,
  onToggle,
}: {
  active: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      aria-pressed={active}
      title="Include answers with no quality signal, in any triage state"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active
          ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/30'
          : 'border-border text-muted-foreground',
      )}
    >
      <ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span>All answers</span>
    </button>
  )
}

function QualitySignalChips({
  counts,
  activeSignal,
  onSelect,
  showAll,
  onShowAllChange,
}: {
  counts: Record<QualitySignalId, number> | null
  activeSignal: QualitySignalId | null
  onSelect: (id: QualitySignalId | null) => void
  showAll: boolean
  onShowAllChange: (next: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Queue signal filters">
      {QUALITY_SIGNALS.map((signal) => (
        <QualitySignalChip
          key={signal.id}
          signal={signal}
          count={counts ? counts[signal.id] : null}
          active={!showAll && activeSignal === signal.id}
          onSelect={onSelect}
        />
      ))}
      <AllAnswersToggle active={showAll} onToggle={onShowAllChange} />
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
  assistantMessageId,
  state,
  pending,
  onChange,
}: {
  assistantMessageId: string
  state: QualityTriageState
  pending: boolean
  onChange: (next: QualityTriageState, anchor: HTMLElement | null) => void
}) {
  const meta = TRIAGE_STATE_META[state]
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          disabled={pending}
          data-quality-triage-id={assistantMessageId}
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
          onValueChange={(value) => onChange(
            value as QualityTriageState,
            triggerRef.current,
          )}
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
  const resolutionReasonsKey = (routeState.qualityResolutionReasons ?? []).join(',')
  const resolutionFrom = routeState.qualityResolutionFrom
  const resolutionTo = routeState.qualityResolutionTo
  const groundingVerdictsKey = (routeState.qualityGroundingVerdicts ?? []).join(',')
  const hasUnsourcedClaims = routeState.qualityHasUnsourcedClaims ?? false
  const hasInvalidSources = routeState.qualityHasInvalidSources ?? false
  const latency = routeState.qualityLatency
  const sort: QualitySortFilter = routeState.qualitySort ?? 'turn_created_at'
  const activeNegativeFeedbackOnly = routeState.qualityActiveNegativeFeedbackOnly ?? false
  // Health window (zone 1). Deliberately independent of the queue filters below.
  const range: QualityStatsRange = routeState.qualityRange ?? DEFAULT_QUALITY_RANGE
  // The queue's signal preset (zone 2), now a first-class server filter rather
  // than a tuple of client-derived action filters.
  const activeSignal: QualitySignalId | null = routeState.qualitySignal ?? null
  // Opting out of the queue's default scope: every answer, any triage state.
  const showAll = routeState.qualityShowAll ?? false
  // Content plan handoff: when set, the queue is scoped to a topic's membership
  // via the content-plan member-turn endpoint, and a return affordance is shown.
  const contentPlanTopicId = routeState.contentPlanTopicId ?? null

  const [items, setItems] = useState<LowQualityTurn[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loadedTurnsScopeKey, setLoadedTurnsScopeKey] = useState<string | null>(null)
  const [turnsLoadFailure, setTurnsLoadFailure] = useState<{
    scopeKey: string
    message: string
    preserveRows: boolean
  } | null>(null)
  const [isFetching, setIsFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creatingEvalMessageId, setCreatingEvalMessageId] = useState<string | null>(null)
  const [openedConversation, setOpenedConversation] = useState<{
    conversationId: string
    assistantMessageId: string
  } | null>(null)
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogEntry[]>([])
  const [stats, setStats] = useState<QualityStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [isStatsFetching, setIsStatsFetching] = useState(false)
  const [pendingTriageId, setPendingTriageId] = useState<string | null>(null)
  const [closeReview, setCloseReview] = useState<{
    turn: LowQualityTurn
    state: 'resolved' | 'dismissed'
    conflict: QualityTriageRecord | null
    anchor: HTMLElement | null
  } | null>(null)
  const [statusAnnouncement, setStatusAnnouncement] = useState('')
  // Bumped after a triage change so the active-backlog signal counts refetch.
  const [countsRefreshKey, setCountsRefreshKey] = useState(0)
  // Bumped after a triage change so server-filtered rows/totals stay current.
  const [turnsRefreshKey, setTurnsRefreshKey] = useState(0)
  const [turnsRetryKey, setTurnsRetryKey] = useState(0)
  const turnsRequestIdRef = useRef(0)
  const loadedTurnsScopeKeyRef = useRef<string | null>(null)
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
  const resolutionReasons = useMemo<QualityResolutionReasonFilter[]>(
    () => resolutionReasonsKey
      ? (resolutionReasonsKey.split(',') as QualityResolutionReasonFilter[])
      : [],
    [resolutionReasonsKey],
  )
  const groundingVerdicts = useMemo<GroundingVerdict[]>(
    () => (groundingVerdictsKey ? (groundingVerdictsKey.split(',') as GroundingVerdict[]) : []),
    [groundingVerdictsKey],
  )
  const queueScope = useMemo(() => resolveQueueScope({
    showAll,
    signal: activeSignal,
    triageStates,
  }), [activeSignal, showAll, triageStates])
  const turnsScopeKey = useMemo(() => contentPlanTopicId
    ? JSON.stringify(['topic', contentPlanTopicId, 'current', currentPage, PAGE_SIZE])
    : JSON.stringify([
        'generic',
        currentPage,
        PAGE_SIZE,
        queueScope.signals ?? null,
        queueScope.triageStates ?? null,
        actionsKey,
        statusesKey,
        feedbackKey,
        resolutionReasonsKey,
        resolutionFrom ?? null,
        resolutionTo ?? null,
        sort,
        activeNegativeFeedbackOnly,
        hasComment,
        groundingVerdictsKey,
        hasUnsourcedClaims,
        hasInvalidSources,
        latency ?? null,
      ]), [
    actionsKey,
    activeNegativeFeedbackOnly,
    contentPlanTopicId,
    currentPage,
    feedbackKey,
    groundingVerdictsKey,
    hasComment,
    hasInvalidSources,
    hasUnsourcedClaims,
    latency,
    queueScope,
    resolutionFrom,
    resolutionReasonsKey,
    resolutionTo,
    sort,
    statusesKey,
  ])
  const turnsScopeLoaded = loadedTurnsScopeKey === turnsScopeKey
  const visibleItems = turnsScopeLoaded ? items : []
  const visibleTotal = turnsScopeLoaded ? total : 0
  const visibleTotalPages = turnsScopeLoaded ? totalPages : 0
  const currentTurnsFailure = turnsLoadFailure?.scopeKey === turnsScopeKey
    ? turnsLoadFailure
    : null

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

  // One rollup call backs both zones: windowed rates for the health tiles and the
  // all-time active backlog for the queue chips. Health is windowed; backlog is not.
  useEffect(() => {
    let cancelled = false

    const loadStats = async () => {
      setIsStatsFetching(true)
      try {
        const response = await qualityApi.getStats({ range })
        if (!cancelled) {
          setStats(response)
          setStatsError(null)
        }
      } catch (caught) {
        if (!cancelled) {
          // Drop the previous rollup rather than leaving it on screen. A refetch
          // fires after every triage change, so keeping the old object would show
          // backlog counts that the operator's own action just invalidated —
          // precisely the dishonest-count problem this view exists to fix. The
          // chips render "—" for a null count.
          setStats(null)
          // Health is an overlay on the queue: degrade to a muted panel and leave
          // the table fully usable rather than failing the page.
          setStatsError(getApiErrorMessage(caught, 'Failed to load quality stats'))
        }
      } finally {
        if (!cancelled) {
          setIsStatsFetching(false)
        }
      }
    }

    void loadStats()
    return () => {
      cancelled = true
    }
  }, [range, countsRefreshKey])

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
        id: 'groundingVerdict',
        kind: 'multi-select',
        label: 'Grounding verdict',
        options: GROUNDING_VERDICTS.map((value) => ({ value, label: GROUNDING_VERDICT_LABEL[value] })),
      },
      {
        id: 'hasUnsourcedClaims',
        kind: 'boolean',
        label: 'Has unsourced claims',
      },
      {
        id: 'hasInvalidSources',
        kind: 'boolean',
        label: 'Has invalid sources',
      },
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
        id: 'resolutionReason',
        kind: 'multi-select',
        label: 'Resolution reason',
        options: [
          ...QUALITY_RESOLUTION_REASONS.map((value) => ({
            value,
            label: REASON_LABELS[value],
          })),
          { value: 'unspecified', label: 'Reason unspecified' },
        ],
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
      {
        id: 'evidence',
        label: 'Evidence',
        defaultOpen: true,
        filterIds: ['groundingVerdict', 'hasUnsourcedClaims', 'hasInvalidSources'],
      },
      { id: 'status', label: 'Conversation status', defaultOpen: true, filterIds: ['status'] },
      { id: 'feedback', label: 'Feedback', defaultOpen: true, filterIds: ['feedback', 'hasComment'] },
      {
        id: 'triage',
        label: 'Triage state',
        defaultOpen: true,
        filterIds: ['triage', 'resolutionReason'],
      },
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
    if (resolutionReasons.length > 0) {
      next.resolutionReason = { kind: 'multi-select', values: resolutionReasons }
    }
    if (hasComment) {
      next.hasComment = { kind: 'boolean', value: true }
    }
    if (latency) {
      next.latency = { kind: 'single-select', value: latency }
    }
    if (groundingVerdicts.length > 0) {
      next.groundingVerdict = { kind: 'multi-select', values: groundingVerdicts }
    }
    if (hasUnsourcedClaims) {
      next.hasUnsourcedClaims = { kind: 'boolean', value: true }
    }
    if (hasInvalidSources) {
      next.hasInvalidSources = { kind: 'boolean', value: true }
    }
    return next
    // statusesKey/actionsKey/feedbackKey/triageKey/hasComment/latency plus the loaded action catalog
    // together fully determine these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusesKey, actionsKey, actionFilterGroups, feedbackKey, triageKey, resolutionReasonsKey, hasComment, latency, groundingVerdictsKey, hasUnsourcedClaims, hasInvalidSources])

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

  const hasUnsupportedTopicQueueState = contentPlanTopicId !== null && Boolean(
    (routeState.qualityRange && routeState.qualityRange !== DEFAULT_QUALITY_RANGE)
    || routeState.qualitySignal
    || routeState.qualityShowAll
    || routeState.qualityActions?.length
    || routeState.qualityStatuses?.length
    || routeState.qualityFeedback?.length
    || routeState.qualityLatency
    || routeState.qualitySort
    || routeState.qualityTriageStates?.length
    || routeState.qualityResolutionReasons?.length
    || routeState.qualityResolutionFrom
    || routeState.qualityResolutionTo
    || routeState.qualityActiveNegativeFeedbackOnly
    || routeState.qualityHasComment
    || routeState.qualityGroundingVerdicts?.length
    || routeState.qualityHasUnsourcedClaims
    || routeState.qualityHasInvalidSources,
  )

  useEffect(() => {
    if (!contentPlanTopicId || !hasUnsupportedTopicQueueState) {
      return
    }
    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      ...CLEARED_QUALITY_QUEUE_ROUTE_STATE,
      section: 'quality',
      workspaceId: activeWorkspaceId ?? routeState.workspaceId,
      contentPlanTopicId,
      qualityRange: undefined,
      qualityPage: currentPage > 1 ? currentPage : undefined,
    }))
  }, [
    accountId,
    activeWorkspaceId,
    contentPlanTopicId,
    currentPage,
    hasUnsupportedTopicQueueState,
    routeState,
    router,
  ])

  const buildRoutineHref = useCallback(
    (agentId: string, routineId: string) =>
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'agents',
        workspaceId: activeWorkspaceId ?? routeState.workspaceId,
        agentId,
        agentRoutineId: routineId,
        agentTab: undefined,
        anchor: undefined,
      }),
    [accountId, activeWorkspaceId, routeState],
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
      const resolutionReasonValue = next.resolutionReason
      const latencyValue = next.latency
      const hasCommentValue = next.hasComment
      const groundingVerdictValue = next.groundingVerdict
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
        qualityResolutionReasons:
          resolutionReasonValue?.kind === 'multi-select'
          && resolutionReasonValue.values.length > 0
            ? (resolutionReasonValue.values as QualityResolutionReasonFilter[])
            : undefined,
        // Manual reason changes leave a breakdown's transition window intact only
        // while at least one reason remains selected.
        qualityResolutionFrom:
          resolutionReasonValue?.kind === 'multi-select'
          && resolutionReasonValue.values.length > 0
            ? resolutionFrom
            : undefined,
        qualityResolutionTo:
          resolutionReasonValue?.kind === 'multi-select'
          && resolutionReasonValue.values.length > 0
            ? resolutionTo
            : undefined,
        qualityLatency:
          latencyValue?.kind === 'single-select'
            ? (latencyValue.value as QualityLatencyFilter)
            : undefined,
        qualitySort: undefined,
        qualityActiveNegativeFeedbackOnly: undefined,
        qualityHasComment: hasCommentValue?.kind === 'boolean' ? true : undefined,
        qualityGroundingVerdicts:
          groundingVerdictValue?.kind === 'multi-select' && groundingVerdictValue.values.length > 0
            ? (groundingVerdictValue.values as GroundingVerdict[])
            : undefined,
        qualityHasUnsourcedClaims: next.hasUnsourcedClaims?.kind === 'boolean' ? true : undefined,
        qualityHasInvalidSources: next.hasInvalidSources?.kind === 'boolean' ? true : undefined,
        qualityPage: undefined,
      })
    },
    [actionFilterGroups, navigateWith, resolutionFrom, resolutionTo],
  )

  const removeFilter = (id: string) => {
    const next: FilterValues = { ...filterValues }
    delete next[id]
    applyFilters(next)
  }

  const removeResolutionReason = (reason: QualityResolutionReasonFilter) => {
    const remaining = resolutionReasons.filter((value) => value !== reason)
    navigateWith({
      qualityResolutionReasons: remaining.length > 0 ? remaining : undefined,
      qualityResolutionFrom: remaining.length > 0 ? resolutionFrom : undefined,
      qualityResolutionTo: remaining.length > 0 ? resolutionTo : undefined,
      qualityPage: undefined,
    })
  }

  const setPage = (next: number) =>
    navigateWith({ qualityPage: next > 1 ? next : undefined })

  // Selecting a signal narrows the table to that active issue class and clears other
  // filters; selecting the active signal again (null) falls back to the queue default,
  // which is every signal rather than every answer. Triage is left to the default
  // resolver instead of being written into the URL, so the chip presets stay one concept.
  const applySignal = (signalId: QualitySignalId | null) => {
    navigateWith({
      ...CLEARED_QUALITY_QUEUE_ROUTE_STATE,
      qualitySignal: signalId ?? undefined,
    })
  }

  // "All answers" drops the queue's defaults only. Explicit filters survive, so an
  // operator who widened the scope keeps the filter pills they set.
  const applyShowAll = (next: boolean) =>
    navigateWith({
      qualityShowAll: next ? true : undefined,
      qualitySignal: undefined,
      qualitySort: undefined,
      qualityActiveNegativeFeedbackOnly: undefined,
      qualityPage: undefined,
    })

  // The health window lives in the URL so a shared link reproduces what the
  // operator was looking at. It never touches the queue's filters or page.
  const applyRange = (next: QualityStatsRange) => navigateWith({ qualityRange: next })

  const applyResolutionBreakdown = (
    entry: QualityStats['resolutionBreakdown'][number],
    window: { from: string; to: string },
  ) => {
    navigateWith({
      ...CLEARED_QUALITY_QUEUE_ROUTE_STATE,
      qualityShowAll: true,
      qualityTriageStates: [entry.state],
      qualityResolutionReasons: [entry.reason],
      qualityResolutionFrom: window.from,
      qualityResolutionTo: window.to,
    })
  }

  useEffect(() => {
    let cancelled = false
    const requestId = turnsRequestIdRef.current + 1
    turnsRequestIdRef.current = requestId
    const hadCurrentRows = loadedTurnsScopeKeyRef.current === turnsScopeKey
    const requestIsCurrent = () => (
      !cancelled && turnsRequestIdRef.current === requestId
    )

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
        if (!requestIsCurrent()) {
          return
        }
        setIsFetching(true)
        setError(null)
        setTurnsLoadFailure((current) => current?.scopeKey === turnsScopeKey ? null : current)
        // Content plan handoff bypasses the queue-signal query and reads the
        // topic's members through its own authorized endpoint; the response
        // shape is the shared LowQualityTurnsPage, so the rest of the queue
        // renders unchanged.
        const page = contentPlanTopicId
          ? await contentPlanApi.listTopicTurns(contentPlanTopicId, {
              window: 'current',
              page: currentPage,
              pageSize: PAGE_SIZE,
            })
          : await qualityApi.listTurns({
              signal: queueScope.signals,
              actions: actionTuples && actionTuples.length > 0 ? actionTuples : undefined,
              statuses: statusesList,
              feedback: feedbackList,
              triageStates: queueScope.triageStates,
              resolutionReasons: resolutionReasons.length > 0
                ? (resolutionReasons as QualityResolutionBreakdownReason[])
                : undefined,
              resolutionFrom,
              resolutionTo,
              sort: sort === 'turn_created_at' ? undefined : sort,
              activeNegativeFeedbackOnly: activeNegativeFeedbackOnly || undefined,
              hasComment: hasComment || undefined,
              groundingVerdict: groundingVerdicts.length > 0 ? groundingVerdicts : undefined,
              hasUnsourcedClaims: hasUnsourcedClaims || undefined,
              hasInvalidSources: hasInvalidSources || undefined,
              minTotalLatencyMs: latencyBucket?.minTotalLatencyMs,
              maxTotalLatencyMs: latencyBucket?.maxTotalLatencyMs,
              limit: PAGE_SIZE,
              offset: (currentPage - 1) * PAGE_SIZE,
            })

        if (!requestIsCurrent()) {
          return
        }
        if (page === null) {
          setItems([])
          setTotal(0)
          setTotalPages(0)
          loadedTurnsScopeKeyRef.current = turnsScopeKey
          setLoadedTurnsScopeKey(turnsScopeKey)
          setTurnsLoadFailure({
            scopeKey: turnsScopeKey,
            message: 'This Content plan topic is no longer available.',
            preserveRows: false,
          })
          return
        }
        setItems(page.items)
        setTotal(page.total)
        setTotalPages(page.totalPages)
        loadedTurnsScopeKeyRef.current = turnsScopeKey
        setLoadedTurnsScopeKey(turnsScopeKey)
        setTurnsLoadFailure(null)
      } catch (caught) {
        if (!requestIsCurrent()) {
          return
        }
        const preserveRows = contentPlanTopicId === null && hadCurrentRows
        if (!preserveRows) {
          setItems([])
          setTotal(0)
          setTotalPages(0)
          loadedTurnsScopeKeyRef.current = turnsScopeKey
          setLoadedTurnsScopeKey(turnsScopeKey)
        }
        setTurnsLoadFailure({
          scopeKey: turnsScopeKey,
          message: getApiErrorMessage(caught, 'Failed to load assistant answers'),
          preserveRows,
        })
      } finally {
        if (requestIsCurrent()) {
          setIsFetching(false)
        }
      }
    }

    void loadTurns()

    return () => {
      cancelled = true
    }
  }, [
    activeSignal,
    showAll,
    currentPage,
    feedbackKey,
    hasComment,
    groundingVerdictsKey,
    groundingVerdicts,
    hasUnsourcedClaims,
    hasInvalidSources,
    latency,
    actionsKey,
    statusesKey,
    triageKey,
    resolutionReasonsKey,
    resolutionReasons,
    resolutionFrom,
    resolutionTo,
    sort,
    activeNegativeFeedbackOnly,
    turnsRefreshKey,
    turnsRetryKey,
    turnsScopeKey,
    queueScope,
    contentPlanTopicId,
  ])

  const retryTurns = useCallback(() => {
    if (!currentTurnsFailure?.preserveRows) {
      loadedTurnsScopeKeyRef.current = null
      setLoadedTurnsScopeKey(null)
    }
    setTurnsLoadFailure(null)
    setTurnsRetryKey((key) => key + 1)
  }, [currentTurnsFailure])

  const openConversation = (turn: LowQualityTurn) =>
    setOpenedConversation({
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
    })

  const requestCloseReview = (
    turn: LowQualityTurn,
    state: 'resolved' | 'dismissed',
    anchor: HTMLElement | null,
  ) => {
    setOpenedConversation(null)
    setError(null)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const currentAnchor = anchor?.isConnected
          ? anchor
          : document.querySelector<HTMLElement>(
              `[data-quality-triage-id="${CSS.escape(turn.assistantMessageId)}"]`,
            )
        setCloseReview({
          turn,
          state,
          conflict: null,
          anchor: currentAnchor ?? null,
        })
      })
    })
  }

  const openEval = async (turn: LowQualityTurn) => {
    setCreatingEvalMessageId(turn.assistantMessageId)
    setError(null)
    try {
      let result
      if (turn.verification) {
        try {
          result = await evalsApi.getCaseBySourceMessage(turn.assistantMessageId)
        } catch (caught) {
          if (getApiErrorStatus(caught) !== 404) {
            throw caught
          }
          setItems((previous) =>
            previous.map((item) =>
              item.assistantMessageId === turn.assistantMessageId
                ? { ...item, verification: null }
                : item))
          setStatusAnnouncement(
            'The linked eval was deleted. Creating a replacement from this answer.',
          )
          try {
            result = await evalsApi.getOrCreateCaseBySourceMessage(turn.assistantMessageId)
          } catch (replacementError) {
            setError(getApiErrorMessage(
              replacementError,
              'The linked eval was deleted, and a replacement could not be created.',
            ))
            return
          }
        }
      } else {
        result = await evalsApi.getOrCreateCaseBySourceMessage(turn.assistantMessageId)
      }
      router.push(buildDashboardHref(accountId, buildQualityTurnEvalRoute(result.case.id, {
        workspaceId: activeWorkspaceId ?? routeState.workspaceId,
        workspacePublicRouteKey: routeState.workspacePublicRouteKey,
      })))
    } catch (caught) {
      setError(getApiErrorMessage(
        caught,
        turn.verification ? 'Failed to open the linked eval case' : 'Failed to create eval case',
      ))
    } finally {
      setCreatingEvalMessageId((current) => (current === turn.assistantMessageId ? null : current))
    }
  }

  const updateTriageState = async (
    turn: LowQualityTurn,
    next: QualityTriageState,
    anchor: HTMLElement | null,
  ) => {
    if (turn.triage.state === next || pendingTriageId === turn.assistantMessageId) {
      return
    }
    if (next === 'resolved' || next === 'dismissed') {
      requestCloseReview(turn, next, anchor)
      return
    }
    setPendingTriageId(turn.assistantMessageId)
    try {
      const record = await qualityApi.setTriageState(turn.assistantMessageId, {
        state: next,
        expectedVersion: turn.triage.version,
      })
      setItems((prev) =>
        prev.map((item) =>
          item.assistantMessageId === turn.assistantMessageId ? { ...item, triage: record } : item,
        ),
      )
      setCountsRefreshKey((key) => key + 1)
      setTurnsRefreshKey((key) => key + 1)
    } catch (caught) {
      const current = getQualityTriageConflict(caught)
      if (current) {
        const terminalOutsideActiveScope = isTerminalQualityTriageState(current.state)
          && (
            activeNegativeFeedbackOnly
            || (
              queueScope.triageStates !== undefined
              && !queueScope.triageStates.includes(current.state)
            )
          )
        if (terminalOutsideActiveScope) {
          const turnIndex = items.findIndex(
            (item) => item.assistantMessageId === turn.assistantMessageId,
          )
          const adjacentTargetId = (
            items[turnIndex + 1]?.assistantMessageId
            ?? items[turnIndex - 1]?.assistantMessageId
            ?? null
          )
          setItems((prev) =>
            prev.filter((item) => item.assistantMessageId !== turn.assistantMessageId))
          setTotal((currentTotal) => Math.max(0, currentTotal - 1))
          setError(
            'Another operator already closed this review. '
              + 'It was removed from the active queue.',
          )
          setStatusAnnouncement(
            'Another operator already closed this review. It was removed from the active queue.',
          )
          focusQualityQueueTarget(adjacentTargetId)
          setCountsRefreshKey((key) => key + 1)
        } else {
          setItems((prev) =>
            prev.map((item) =>
              item.assistantMessageId === turn.assistantMessageId
                ? { ...item, triage: current }
                : item,
            ))
          setError('Another operator changed this review. The current state has been reloaded.')
        }
      } else {
        setError(getApiErrorMessage(caught, 'Failed to update triage state'))
      }
    } finally {
      setPendingTriageId((current) => (current === turn.assistantMessageId ? null : current))
    }
  }

  const submitCloseReview = async (input: CloseReviewInput) => {
    const turn = closeReview?.turn
    if (!turn) return
    setPendingTriageId(turn.assistantMessageId)
    setError(null)
    try {
      const turnIndex = items.findIndex(
        (item) => item.assistantMessageId === turn.assistantMessageId,
      )
      const adjacentTargetId = (
        items[turnIndex + 1]?.assistantMessageId
        ?? items[turnIndex - 1]?.assistantMessageId
        ?? null
      )
      const record = await qualityApi.setTriageState(turn.assistantMessageId, {
        state: input.state,
        expectedVersion: turn.triage.version,
        ...(input.resolution ? { resolution: input.resolution } : {}),
      })
      const remainsInTriageScope = !queueScope.triageStates
        || queueScope.triageStates.includes(record.state)
      const resolutionReason = record.resolution?.reason ?? 'unspecified'
      const remainsInReasonScope = resolutionReasons.length === 0
        || resolutionReasons.includes(resolutionReason)
      const closedAt = record.closedAt ? Date.parse(record.closedAt) : Number.NaN
      const remainsInTimeScope = (
        (!resolutionFrom || (!Number.isNaN(closedAt) && closedAt >= Date.parse(resolutionFrom)))
        && (!resolutionTo || (!Number.isNaN(closedAt) && closedAt < Date.parse(resolutionTo)))
      )
      const remainsVisible = Boolean(
        !activeNegativeFeedbackOnly
        && remainsInTriageScope
        && remainsInReasonScope
        && remainsInTimeScope,
      )

      setItems((previous) => remainsVisible
        ? previous.map((item) =>
            item.assistantMessageId === turn.assistantMessageId
              ? { ...item, triage: record }
              : item)
        : previous.filter((item) => item.assistantMessageId !== turn.assistantMessageId))
      if (!remainsVisible) {
        setTotal((current) => Math.max(0, current - 1))
      }
      setCloseReview(null)
      setStatusAnnouncement(
        input.state === 'resolved'
          ? 'Review resolved.'
          : 'Review marked not actionable.',
      )
      focusQualityQueueTarget(remainsVisible ? turn.assistantMessageId : adjacentTargetId)
      setCountsRefreshKey((key) => key + 1)
      setTurnsRefreshKey((key) => key + 1)
    } catch (caught) {
      const current = getQualityTriageConflict(caught)
      if (current) {
        setItems((previous) =>
          previous.map((item) =>
            item.assistantMessageId === turn.assistantMessageId
              ? { ...item, triage: current }
              : item))
        setCloseReview((pending) =>
          pending?.turn.assistantMessageId === turn.assistantMessageId
            ? {
                ...pending,
                conflict: current,
                turn: { ...pending.turn, triage: current },
              }
            : pending)
        setError(null)
        setStatusAnnouncement(
          'Another operator changed this review. Their current decision is shown in the dialog.',
        )
      } else {
        setError(getApiErrorMessage(caught, 'Failed to close this review'))
      }
    } finally {
      setPendingTriageId((current) =>
        current === turn.assistantMessageId ? null : current)
    }
  }

  const renderPagination = () => (
    <DashboardPagination
      summary={formatPageSummary({
        currentPage,
        pageSize: PAGE_SIZE,
        pageItemCount: visibleItems.length,
        totalItems: visibleTotal,
      })}
      currentPage={currentPage}
      totalPages={visibleTotalPages}
      previousHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'quality',
        qualityPage: Math.max(1, currentPage - 1),
      })}
      nextHref={buildDashboardHref(accountId, {
        ...routeState,
        section: 'quality',
        qualityPage: Math.min(visibleTotalPages, currentPage + 1),
      })}
      onPrevious={() => setPage(Math.max(1, currentPage - 1))}
      onNext={() => setPage(Math.min(visibleTotalPages, currentPage + 1))}
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

  const hasQueueFilter = !contentPlanTopicId && (
    activeSignal !== null
    || statuses.length > 0
    || actions.length > 0
    || feedback.length > 0
    || sort !== 'turn_created_at'
    || triageStates.length > 0
    || resolutionReasons.length > 0
    || activeNegativeFeedbackOnly
    || hasComment
    || groundingVerdicts.length > 0
    || hasUnsourcedClaims
    || hasInvalidSources
    || Boolean(latency)
  )

  return (
    <>
    <DashboardPage
      title="Quality review"
      description="Triage the answers that need attention — negative feedback, grounding gaps, and slow responses — then open the conversation to act."
      titleAccessory={<MessageSquareWarning className="h-4 w-4 text-muted-foreground" />}
    >
      {contentPlanTopicId ? (
        <ContentPlanReturnBanner
          topicId={contentPlanTopicId}
          contentPlanHref={buildDashboardHref(accountId, {
            section: 'content-plan',
            workspaceId: routeState.workspaceId,
            workspacePublicRouteKey: routeState.workspacePublicRouteKey,
            contentPlanTopicId,
          })}
        />
      ) : null}
      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!contentPlanTopicId ? (
        <div className="mb-8">
          <QualityHealthRow
            stats={stats}
            range={range}
            onRangeChange={applyRange}
            isRefreshing={isStatsFetching}
            error={statsError}
          />
          <ResolutionBreakdown stats={stats} onSelect={applyResolutionBreakdown} />
        </div>
      ) : null}

      <section aria-labelledby="quality-queue-heading" className="space-y-4">
        <div>
          <h2
            id="quality-queue-heading"
            data-quality-queue-heading
            tabIndex={-1}
            className="text-sm font-medium text-foreground"
          >
            {contentPlanTopicId ? 'Topic answers · current 30-day window' : 'Queue · all time'}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {contentPlanTopicId
              ? 'Only answers assigned to this topic in the Content plan current window. Triage and Eval actions remain available.'
              : showAll
              ? 'Every assistant answer, with no date bound — including the ones carrying no signal and the ones already triaged.'
              : 'Answers carrying a signal and still awaiting triage, with no date bound — an older answer never quietly ages out.'}
          </p>
        </div>

        {!contentPlanTopicId ? (
          <div className="flex flex-wrap items-center gap-2">
          <QualitySignalChips
            counts={stats?.backlog ?? null}
            activeSignal={activeSignal}
            onSelect={applySignal}
            showAll={showAll}
            onShowAllChange={applyShowAll}
          />
          {appliedFilterCount > 0 ? (
            <ActiveFilterPills
              filters={qualityFilters.filter((filter) => filter.id !== 'resolutionReason')}
              values={filterValues}
              onRemove={removeFilter}
            />
          ) : null}
          {resolutionReasons.map((reason) => (
            <button
              key={reason}
              type="button"
              onClick={() => removeResolutionReason(reason)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground hover:bg-accent"
              aria-label={`Remove resolution reason: ${
                reason === 'unspecified' ? 'Reason unspecified' : REASON_LABELS[reason]
              }`}
            >
              <span className="text-muted-foreground">Resolution reason:</span>
              <span className="font-medium">
                {reason === 'unspecified' ? 'Reason unspecified' : REASON_LABELS[reason]}
              </span>
              <CircleX className="h-3 w-3" aria-hidden />
            </button>
          ))}
            {filterButton}
          </div>
        ) : null}

      {!turnsScopeLoaded ? (
        <div className="flex min-h-48 items-center justify-center">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      ) : currentTurnsFailure && !currentTurnsFailure.preserveRows ? (
        <QualityTurnsLoadFailure
          topicScoped={contentPlanTopicId !== null}
          message={currentTurnsFailure.message}
          onRetry={retryTurns}
        />
      ) : visibleItems.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          {contentPlanTopicId
            ? 'No answers are assigned to this topic in the current Content plan window.'
            : hasQueueFilter
            ? 'No assistant turns match these filters. Try clearing one of them.'
            : showAll
              ? 'No assistant turns are available yet. Turns will show up here as your assistant handles traffic.'
              : 'Nothing is waiting for triage. Turn on All answers to browse every answer, including the healthy ones.'}
        </div>
      ) : (
        <DashboardPaginatedContent className="space-y-4" isRefreshing={isFetching}>
          {currentTurnsFailure?.preserveRows ? (
            <QualityTurnsLoadFailure
              topicScoped={false}
              message={currentTurnsFailure.message}
              onRetry={retryTurns}
            />
          ) : null}
          {renderPagination()}

          <DashboardTable
            aria-label={contentPlanTopicId ? 'Current-window topic answers' : 'Assistant answers to review'}
            minWidth="min-w-[936px]"
          >
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
              {visibleItems.map((turn) => {
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
                        <EvalVerificationAction
                          verification={turn.verification}
                          pending={creatingEvalMessageId === turn.assistantMessageId}
                          onOpen={() => void openEval(turn)}
                          onReviewAndResolve={(anchor) =>
                            requestCloseReview(turn, 'resolved', anchor)}
                        />
                      </DashboardTableCell>
                      <DashboardTableCell className="w-40">
                        <div className="flex flex-col items-start gap-1.5">
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
                          {turn.grounding ? (
                            <div className="space-y-0.5 text-[11px] leading-4">
                              <div className="text-muted-foreground">
                                {turn.grounding.claimCount === 0
                                  ? turn.grounding.verdict === 'no_support'
                                    ? 'No supported claims'
                                    : 'No claims evaluated'
                                  : `${turn.grounding.sourcedClaimCount} of ${turn.grounding.claimCount} ${turn.grounding.claimCount === 1 ? 'claim' : 'claims'} sourced`}
                              </div>
                              {turn.grounding.unsourcedClaimCount > 0 ? (
                                <div className="font-medium text-amber-700 dark:text-amber-400">
                                  {turn.grounding.unsourcedClaimCount} unsourced {turn.grounding.unsourcedClaimCount === 1 ? 'claim' : 'claims'}
                                </div>
                              ) : null}
                              {turn.grounding.invalidSourceCount > 0 ? (
                                <div className="font-medium text-destructive">
                                  {turn.grounding.invalidSourceCount} invalid {turn.grounding.invalidSourceCount === 1 ? 'citation' : 'citations'}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
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
                        <div className="space-y-1">
                          <TriageStateControl
                            assistantMessageId={turn.assistantMessageId}
                            state={turn.triage.state}
                            pending={pendingTriageId === turn.assistantMessageId}
                            onChange={(next, anchor) =>
                              void updateTriageState(turn, next, anchor)}
                          />
                          {turn.triage.state === 'resolved' || turn.triage.state === 'dismissed' ? (
                            <div className="max-w-48 text-xs text-muted-foreground">
                              <p>
                                {turn.triage.resolution
                                  ? REASON_LABELS[turn.triage.resolution.reason]
                                  : 'Reason unspecified'}
                              </p>
                              {turn.triage.resolution?.note ? (
                                <p className="mt-0.5 line-clamp-2" title={turn.triage.resolution.note}>
                                  {turn.triage.resolution.note}
                                </p>
                              ) : null}
                              {turn.triage.closedAt ? (
                                <p className="mt-0.5">
                                  Closed {formatTimestamp(turn.triage.closedAt)}
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </DashboardTableCell>
                    </DashboardTableRow>
                )
              })}
            </DashboardTableBody>
          </DashboardTable>

          {renderPagination()}
        </DashboardPaginatedContent>
      )}
      </section>
    </DashboardPage>
    <FilterDialog
      open={isFilterDialogOpen}
      onOpenChange={setIsFilterDialogOpen}
      filters={qualityFilters}
      sections={qualitySections}
      values={filterValues}
      title="Filter assistant answers"
      description="Choose the evidence, statuses, actions, feedback, and latency band you want to inspect."
      onApply={applyFilters}
    />
    <ConversationDrawer
      selectedItem={closeReview ? null : drawerSelectedItem}
      onSelectedItemChange={(next) => {
        if (!next) {
          setOpenedConversation(null)
        }
      }}
      anchorMessageId={openedConversation?.assistantMessageId ?? null}
      onAfterClose={() => setOpenedConversation(null)}
      buildRoutineHref={buildRoutineHref}
    />
    <p className="sr-only" role="status" aria-live="polite">
      {statusAnnouncement}
    </p>
    {closeReview ? (
      <CloseReviewPopover
        key={`${closeReview.turn.assistantMessageId}:${closeReview.state}`}
        open
        anchor={closeReview.anchor}
        state={closeReview.state}
        submitting={pendingTriageId === closeReview.turn.assistantMessageId}
        error={error}
        conflict={closeReview.conflict}
        onOpenChange={(open) => {
          if (!open) {
            const messageId = closeReview.turn.assistantMessageId
            setCloseReview(null)
            setOpenedConversation(null)
            setError(null)
            window.requestAnimationFrame(() => {
              if (
                document.activeElement instanceof HTMLElement
                && document.activeElement !== document.body
              ) {
                return
              }
              document.querySelector<HTMLElement>(
                `[data-quality-triage-id="${CSS.escape(messageId)}"]`,
              )?.focus()
            })
          }
        }}
        onSubmit={submitCloseReview}
      />
    ) : null}
    </>
  )
}
