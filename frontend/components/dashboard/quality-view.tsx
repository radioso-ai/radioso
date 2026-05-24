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
  type AnswerOutcome,
  type FeedbackValue,
  type LowQualityTurn,
} from '@/lib/api'
import {
  buildDashboardHref,
  type DashboardRouteState,
  type QualityFeedbackFilter,
  type QualityOutcomeFilter,
} from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'

const PAGE_SIZE = 25

interface QualityViewProps {
  accountId: string
  routeState: DashboardRouteState
}

interface OutcomeMeta {
  label: string
  description: string
  tone: 'neutral' | 'warning' | 'info'
}

const OUTCOME_META: Record<AnswerOutcome, OutcomeMeta> = {
  grounded_success: {
    label: 'Answered from sources',
    description: 'The assistant cited at least one document to answer the user.',
    tone: 'neutral',
  },
  no_context_refusal: {
    label: "Couldn't find an answer",
    description: 'The assistant searched but found no relevant documents and declined to answer.',
    tone: 'warning',
  },
  non_retrieval_response: {
    label: 'Conversational reply',
    description: "Small talk or assistant-identity questions — the assistant didn't consult documents.",
    tone: 'info',
  },
}

const OUTCOME_FILTERS: QualityOutcomeFilter[] = [
  'no_context_refusal',
  'non_retrieval_response',
  'grounded_success',
]

const FEEDBACK_LABEL: Record<QualityFeedbackFilter, string> = {
  down: 'Thumbs down',
  up: 'Thumbs up',
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const formatTimestamp = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateFormatter.format(date)
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

const outcomeBadgeClass = (tone: OutcomeMeta['tone']): string | undefined => {
  switch (tone) {
    case 'warning':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'info':
      return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    default:
      return undefined
  }
}

export function QualityView({ accountId, routeState }: QualityViewProps) {
  const router = useRouter()
  const { activeWorkspaceId } = useWorkspace()
  const hasComment = routeState.qualityHasComment ?? false
  const currentPage = routeState.qualityPage ?? 1
  // Serialized filter keys: routeState supplies a fresh array every render
  // (`?? []` makes the reference unstable), so we depend on stable strings.
  const outcomesKey = (routeState.qualityOutcomes ?? []).join(',')
  const feedbackKey = (routeState.qualityFeedback ?? []).join(',')

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
  const drawerSelectedItem: SelectedHistoryItem = openedConversation
    ? { kind: 'chat', id: openedConversation.conversationId }
    : null

  const outcomes: QualityOutcomeFilter[] = outcomesKey
    ? (outcomesKey.split(',') as QualityOutcomeFilter[])
    : []
  const feedback: QualityFeedbackFilter[] = feedbackKey
    ? (feedbackKey.split(',') as QualityFeedbackFilter[])
    : []

  const qualityFilters = useMemo<ReadonlyArray<FilterDefinition>>(
    () => [
      {
        id: 'outcome',
        kind: 'multi-select',
        label: 'Outcome',
        options: OUTCOME_FILTERS.map((value) => ({
          value,
          label: OUTCOME_META[value].label,
          description: OUTCOME_META[value].description,
        })),
      },
      {
        id: 'feedback',
        kind: 'multi-select',
        label: 'Feedback',
        options: (Object.keys(FEEDBACK_LABEL) as QualityFeedbackFilter[]).map((value) => ({
          value,
          label: FEEDBACK_LABEL[value],
        })),
      },
      {
        id: 'hasComment',
        kind: 'boolean',
        label: 'With comment',
      },
    ],
    [],
  )

  const filterValues = useMemo<FilterValues>(() => {
    const next: FilterValues = {}
    if (outcomes.length > 0) {
      next.outcome = { kind: 'multi-select', values: outcomes }
    }
    if (feedback.length > 0) {
      next.feedback = { kind: 'multi-select', values: feedback }
    }
    if (hasComment) {
      next.hasComment = { kind: 'boolean', value: true }
    }
    return next
    // outcomesKey/feedbackKey/hasComment together fully determine these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomesKey, feedbackKey, hasComment])

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
      const outcomeValue = next.outcome
      const feedbackValue = next.feedback
      const hasCommentValue = next.hasComment
      navigateWith({
        qualityOutcomes:
          outcomeValue?.kind === 'multi-select' && outcomeValue.values.length > 0
            ? (outcomeValue.values as QualityOutcomeFilter[])
            : undefined,
        qualityFeedback:
          feedbackValue?.kind === 'multi-select' && feedbackValue.values.length > 0
            ? (feedbackValue.values as QualityFeedbackFilter[])
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
    setIsFetching(true)
    setError(null)

    const outcomesList = outcomesKey ? (outcomesKey.split(',') as QualityOutcomeFilter[]) : undefined
    const feedbackList = feedbackKey ? (feedbackKey.split(',') as QualityFeedbackFilter[]) : undefined

    void qualityApi
      .listTurns({
        outcomes: outcomesList,
        feedback: feedbackList,
        hasComment: hasComment || undefined,
        limit: PAGE_SIZE,
        offset: (currentPage - 1) * PAGE_SIZE,
      })
      .then((page) => {
        if (cancelled) {
          return
        }
        setItems(page.items)
        setTotal(page.total)
        setTotalPages(page.totalPages)
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return
        }
        setError(caught instanceof Error ? caught.message : 'Failed to load quality turns')
      })
      .finally(() => {
        if (!cancelled) {
          setIsFetching(false)
          setHasLoadedOnce(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [currentPage, feedbackKey, hasComment, outcomesKey])

  const openConversation = (turn: LowQualityTurn) =>
    setOpenedConversation({
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
    })

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
      title="Quality"
      description="Assistant turns worth a second look — refusals, conversational fallbacks, and turns with reader feedback. Use this to find content gaps and reasoning failures."
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
          {outcomes.length === 0 && feedback.length === 0 && !hasComment
            ? 'No quality issues to review. As your assistant handles more traffic, refusals and feedback will show up here.'
            : 'No turns match these filters. Try clearing one of them.'}
        </div>
      ) : (
        <div
          className={cn('space-y-4 transition-opacity', isFetching && 'opacity-60')}
          aria-busy={isFetching}
        >
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

          <DashboardTable aria-label="Quality turns" minWidth="min-w-[960px]">
            <DashboardTableHead>
              <DashboardTableHeader className="w-36">Agent</DashboardTableHeader>
              <DashboardTableHeader>Question &amp; answer</DashboardTableHeader>
              <DashboardTableHeader className="w-52">Outcome</DashboardTableHeader>
              <DashboardTableHeader className="w-32">Feedback</DashboardTableHeader>
              <DashboardTableHeader className="w-44">When</DashboardTableHeader>
              <DashboardTableHeader className="w-24" />
            </DashboardTableHead>
            <DashboardTableBody>
              {items.map((turn) => {
                const meta = turn.answerOutcome ? OUTCOME_META[turn.answerOutcome] : null
                const isExpanded = expandedMessageId === turn.assistantMessageId
                const hasComments = turn.feedback.comments.length > 0
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
                        {meta ? (
                          <Badge
                            variant={meta.tone === 'neutral' ? 'secondary' : 'outline'}
                            className={cn('whitespace-nowrap', outcomeBadgeClass(meta.tone))}
                          >
                            {meta.label}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
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
                            Open
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
                        <DashboardTableCell className="w-44">{null}</DashboardTableCell>
                        <DashboardTableCell className="w-24">{null}</DashboardTableCell>
                      </DashboardTableRow>
                    ) : null}
                  </Fragment>
                )
              })}
            </DashboardTableBody>
          </DashboardTable>
        </div>
      )}
    </DashboardPage>
    <FilterDialog
      open={isFilterDialogOpen}
      onOpenChange={setIsFilterDialogOpen}
      filters={qualityFilters}
      values={filterValues}
      title="Filter quality turns"
      description="Narrow the list to the turns you want to review."
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
