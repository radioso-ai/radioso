'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import type { SelectedHistoryItem } from '@/components/dashboard/history/history-list'
import { ConversationDrawer } from '@/components/dashboard/conversation-drawer'
import { Button } from '@/components/ui/button'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import {
  contentPlanApi,
  type ContentPlanPage,
  type ContentPlanTopicDetail,
  type ContentPlanTopicSummary,
  type ContentPlanView as ContentPlanViewName,
} from '@/lib/api-content-plan'
import {
  buildDashboardHref,
  DEFAULT_QUALITY_RANGE,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import {
  formatAsOfTimestamp,
  formatRatePercent,
  formatWindowRange,
  hasCopyableContentPlanBrief,
  mergeContentPlanPage,
  recommendationActionLabel,
} from '@/lib/content-plan'
import { getApiErrorMessage } from '@/lib/api-error'
import { useWorkspace } from '@/lib/workspace-context'
import { cn } from '@/lib/utils'

import { SummaryTiles } from './content-plan/summary-tiles'
import { ProcessingStrip } from './content-plan/processing-strip'
import { RecommendedNextCard } from './content-plan/recommended-next-card'
import { TopicRow } from './content-plan/topic-row'
import { EmergingSection } from './content-plan/emerging-section'
import { TopicDetailPane } from './content-plan/topic-detail-pane'

interface ContentPlanViewProps {
  accountId: string
  routeState: DashboardRouteState
}

type ListLoadState = 'loading' | 'ready' | 'error'
type PaginationLoadState = 'idle' | 'loading' | 'error'
type DetailLoadState = 'idle' | 'loading' | 'ready' | 'not_found' | 'error'
type CopyStatus = 'idle' | 'copied' | 'error'

interface ListResource {
  key: string
  state: Exclude<ListLoadState, 'loading'>
  page: ContentPlanPage | null
  error: string | null
  paginationState: PaginationLoadState
  paginationError: string | null
}

interface DetailResource {
  key: string
  state: Exclude<DetailLoadState, 'idle' | 'loading'>
  detail: ContentPlanTopicDetail | null
  error: string | null
}

interface ContentPlanListReturnState {
  topicId: string
  scrollTop: number
}

const contentPlanListReturnKey = (resourceKey: string): string =>
  `radioso:content-plan:list-return:${resourceKey}`

const writeContentPlanListReturnState = (
  resourceKey: string,
  state: ContentPlanListReturnState,
): void => {
  try {
    window.sessionStorage.setItem(contentPlanListReturnKey(resourceKey), JSON.stringify(state))
  } catch {
    // Focus restoration is progressive enhancement; navigation must still work.
  }
}

const readContentPlanListReturnState = (
  resourceKey: string,
): ContentPlanListReturnState | null => {
  try {
    const raw = window.sessionStorage.getItem(contentPlanListReturnKey(resourceKey))
    if (!raw) {
      return null
    }
    const value: unknown = JSON.parse(raw)
    if (
      typeof value !== 'object'
      || value === null
      || !('topicId' in value)
      || typeof value.topicId !== 'string'
      || !('scrollTop' in value)
      || typeof value.scrollTop !== 'number'
      || !Number.isFinite(value.scrollTop)
    ) {
      return null
    }
    return { topicId: value.topicId, scrollTop: Math.max(0, value.scrollTop) }
  } catch {
    return null
  }
}

export function ContentPlanView({ accountId, routeState }: ContentPlanViewProps) {
  const router = useRouter()
  const { activeWorkspaceId } = useWorkspace()
  const view: ContentPlanViewName = routeState.contentPlanView ?? 'opportunities'
  const selectedTopicId = routeState.contentPlanTopicId ?? null
  const workspaceKey = activeWorkspaceId ?? routeState.workspaceId ?? null
  const listResourceKey = workspaceKey ? `${workspaceKey}:${view}` : null
  const detailResourceKey = workspaceKey && selectedTopicId
    ? `${workspaceKey}:${selectedTopicId}`
    : null

  const [listResource, setListResource] = useState<ListResource | null>(null)
  const [detailResource, setDetailResource] = useState<DetailResource | null>(null)
  const [copyResult, setCopyResult] = useState<{ topicId: string; status: Exclude<CopyStatus, 'idle'> } | null>(null)
  const [openedConversation, setOpenedConversation] = useState<{
    conversationId: string
    assistantMessageId: string | null
  } | null>(null)

  const listRequestIdRef = useRef(0)
  const paginationRequestIdRef = useRef(0)
  const detailRequestIdRef = useRef(0)
  const listWorkspaceKeyRef = useRef<string | null>(null)
  const detailWorkspaceKeyRef = useRef<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  const page = listResourceKey !== null && listResource?.key === listResourceKey
    ? listResource.page
    : null
  const listLoadState: ListLoadState = listResourceKey !== null
    && listResource?.key === listResourceKey
    ? listResource.state
    : 'loading'
  const listError = listResourceKey !== null && listResource?.key === listResourceKey
    ? listResource.error
    : null
  const paginationState: PaginationLoadState = listResourceKey !== null
    && listResource?.key === listResourceKey
    ? listResource.paginationState
    : 'idle'
  const paginationError = listResourceKey !== null && listResource?.key === listResourceKey
    ? listResource.paginationError
    : null
  const detail = detailResourceKey !== null && detailResource?.key === detailResourceKey
    ? detailResource.detail
    : null
  const detailLoadState: DetailLoadState = detailResourceKey === null
    ? 'idle'
    : detailResource?.key === detailResourceKey
      ? detailResource.state
      : 'loading'
  const detailError = detailResourceKey !== null && detailResource?.key === detailResourceKey
    ? detailResource.error
    : null
  const copyStatus: CopyStatus = detail && copyResult?.topicId === detail.canonicalTopicId
    ? copyResult.status
    : 'idle'

  // ---- List load ------------------------------------------------------------
  useEffect(() => {
    listWorkspaceKeyRef.current = workspaceKey
    if (!workspaceKey || !listResourceKey) {
      return
    }

    const requestId = listRequestIdRef.current + 1
    listRequestIdRef.current = requestId
    paginationRequestIdRef.current += 1

    let cancelled = false

    const load = async () => {
      try {
        const result = await contentPlanApi.list({ view })
        if (cancelled || listWorkspaceKeyRef.current !== workspaceKey || listRequestIdRef.current !== requestId) {
          return
        }
        setListResource({
          key: listResourceKey,
          state: 'ready',
          page: result,
          error: null,
          paginationState: 'idle',
          paginationError: null,
        })
      } catch (caught) {
        if (cancelled || listWorkspaceKeyRef.current !== workspaceKey || listRequestIdRef.current !== requestId) {
          return
        }
        setListResource({
          key: listResourceKey,
          state: 'error',
          page: null,
          error: getApiErrorMessage(caught, 'Could not load the Content plan.'),
          paginationState: 'idle',
          paginationError: null,
        })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [listResourceKey, view, workspaceKey])

  const loadMoreTopics = useCallback(async () => {
    const cursor = page?.nextCursor
    if (
      !cursor
      || !workspaceKey
      || !listResourceKey
      || listLoadState !== 'ready'
      || paginationState === 'loading'
    ) {
      return
    }

    const listRequestId = listRequestIdRef.current
    const paginationRequestId = paginationRequestIdRef.current + 1
    paginationRequestIdRef.current = paginationRequestId

    setListResource((current) => {
      if (current?.key !== listResourceKey || current.page?.nextCursor !== cursor) {
        return current
      }
      return {
        ...current,
        paginationState: 'loading',
        paginationError: null,
      }
    })

    try {
      const result = await contentPlanApi.list({ view, cursor })
      if (
        listWorkspaceKeyRef.current !== workspaceKey
        || listRequestIdRef.current !== listRequestId
        || paginationRequestIdRef.current !== paginationRequestId
      ) {
        return
      }
      setListResource((current) => {
        if (current?.key !== listResourceKey || !current.page || current.page.nextCursor !== cursor) {
          return current
        }
        return {
          ...current,
          page: mergeContentPlanPage(current.page, result),
          paginationState: 'idle',
          paginationError: null,
        }
      })
    } catch (caught) {
      if (
        listWorkspaceKeyRef.current !== workspaceKey
        || listRequestIdRef.current !== listRequestId
        || paginationRequestIdRef.current !== paginationRequestId
      ) {
        return
      }
      setListResource((current) => {
        if (current?.key !== listResourceKey || current.page?.nextCursor !== cursor) {
          return current
        }
        return {
          ...current,
          paginationState: 'error',
          paginationError: getApiErrorMessage(caught, 'Could not load more topics.'),
        }
      })
    }
  }, [listLoadState, listResourceKey, page?.nextCursor, paginationState, view, workspaceKey])

  // ---- Detail load ----------------------------------------------------------
  useEffect(() => {
    detailWorkspaceKeyRef.current = workspaceKey

    if (!selectedTopicId || !workspaceKey || !detailResourceKey) {
      return
    }

    const requestId = detailRequestIdRef.current + 1
    detailRequestIdRef.current = requestId

    let cancelled = false

    const load = async () => {
      try {
        const result = await contentPlanApi.getTopic(selectedTopicId)
        if (cancelled || detailWorkspaceKeyRef.current !== workspaceKey || detailRequestIdRef.current !== requestId) {
          return
        }
        if (result === null) {
          setDetailResource({ key: detailResourceKey, state: 'not_found', detail: null, error: null })
          return
        }
        setDetailResource({ key: detailResourceKey, state: 'ready', detail: result, error: null })
        // Redirect canonical topic URL after a merge.
        if (result.canonicalTopicId && result.canonicalTopicId !== selectedTopicId) {
          router.replace(
            buildDashboardHref(accountId, {
              ...routeState,
              section: 'content-plan',
              contentPlanTopicId: result.canonicalTopicId,
              contentPlanMergedIntoTopicId: undefined,
            }),
          )
        }
      } catch (caught) {
        if (cancelled || detailWorkspaceKeyRef.current !== workspaceKey || detailRequestIdRef.current !== requestId) {
          return
        }
        setDetailResource({
          key: detailResourceKey,
          state: 'error',
          detail: null,
          error: getApiErrorMessage(caught, 'Could not load this topic.'),
        })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [accountId, detailResourceKey, routeState, router, selectedTopicId, workspaceKey])

  // Route segments can remount this view, so preserve list position in this tab
  // before opening detail and restore it only for the exact workspace/view key.
  useEffect(() => {
    if (selectedTopicId || listLoadState !== 'ready' || !listResourceKey) {
      return
    }
    const returnState = readContentPlanListReturnState(listResourceKey)
    if (!returnState) {
      return
    }
    window.sessionStorage.removeItem(contentPlanListReturnKey(listResourceKey))
    const focusFrame = window.requestAnimationFrame(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = returnState.scrollTop
      }
      rowRefs.current.get(returnState.topicId)?.focus({ preventScroll: true })
    })

    return () => {
      window.cancelAnimationFrame(focusFrame)
    }
  }, [listLoadState, listResourceKey, selectedTopicId])

  const buildTopicHref = useCallback(
    (topicId: string) =>
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'content-plan',
        contentPlanTopicId: topicId,
      }),
    [accountId, routeState],
  )

  const buildViewHref = useCallback(
    (nextView: ContentPlanViewName) =>
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'content-plan',
        contentPlanView: nextView,
        contentPlanTopicId: undefined,
      }),
    [accountId, routeState],
  )

  const listHrefWithoutTopic = useMemo(
    () =>
      buildDashboardHref(accountId, {
        ...routeState,
        section: 'content-plan',
        contentPlanTopicId: undefined,
        contentPlanMergedIntoTopicId: undefined,
      }),
    [accountId, routeState],
  )

  const goToListWithoutTopic = useCallback(() => {
    router.push(listHrefWithoutTopic)
  }, [listHrefWithoutTopic, router])

  const selectTopic = useCallback(
    (topicId: string) => {
      if (listResourceKey) {
        writeContentPlanListReturnState(listResourceKey, {
          topicId,
          scrollTop: scrollContainerRef.current?.scrollTop ?? 0,
        })
      }
      router.push(buildTopicHref(topicId))
    },
    [buildTopicHref, listResourceKey, router],
  )

  const registerRowRef = useCallback((topicId: string) => (node: HTMLButtonElement | null) => {
    if (node) {
      rowRefs.current.set(topicId, node)
    } else {
      rowRefs.current.delete(topicId)
    }
  }, [])

  const activeTopic = useMemo<ContentPlanTopicSummary | null>(() => {
    if (detail) {
      return detail.topic
    }
    if (!page || !selectedTopicId) {
      return null
    }
    return page.items.find((topic) => topic.id === selectedTopicId) ?? null
  }, [detail, page, selectedTopicId])

  const openQualityForTopic = useCallback(
    (topicId: string) => {
      const href = buildDashboardHref(accountId, {
        section: 'quality',
        workspaceId: routeState.workspaceId,
        workspacePublicRouteKey: routeState.workspacePublicRouteKey,
        qualityRange: DEFAULT_QUALITY_RANGE,
        contentPlanTopicId: topicId,
      })
      router.push(href)
    },
    [accountId, routeState, router],
  )

  const openReviewDocument = useCallback(
    (documentId: string, topicId: string) => {
      router.push(
        buildDashboardHref(accountId, {
          section: 'knowledge',
          workspaceId: routeState.workspaceId,
          workspacePublicRouteKey: routeState.workspacePublicRouteKey,
          knowledgeTab: 'documents',
          documentId,
          knowledgeFromContentPlanTopicId: topicId,
        }),
      )
    },
    [accountId, routeState, router],
  )

  const openWriteDocument = useCallback(
    (topicId: string) => {
      router.push(
        buildDashboardHref(accountId, {
          section: 'knowledge',
          workspaceId: routeState.workspaceId,
          workspacePublicRouteKey: routeState.workspacePublicRouteKey,
          knowledgeTab: 'documents',
          knowledgeDraftFromContentPlanTopicId: topicId,
        }),
      )
    },
    [accountId, routeState, router],
  )

  const openConversation = useCallback(
    (input: { conversationId: string; assistantMessageId: string | null }) => {
      setOpenedConversation(input)
    },
    [],
  )

  const drawerSelectedItem: SelectedHistoryItem = openedConversation
    ? { kind: 'chat', id: openedConversation.conversationId }
    : null

  const handleDrawerClose = useCallback(() => {
    setOpenedConversation(null)
  }, [])

  const handleDrawerSelectedChange = useCallback((next: SelectedHistoryItem) => {
    if (next === null) {
      setOpenedConversation(null)
    }
  }, [])

  const copyBriefForActiveTopic = useCallback(async () => {
    if (!detail || !hasCopyableContentPlanBrief(detail.topic.recommendation)) {
      return
    }
    const rec = detail.topic.recommendation
    const lines = [
      `Topic: ${detail.topic.label ?? 'Awaiting label'}`,
      rec.rationale ? `Why now: ${rec.rationale}` : null,
      `Action: ${recommendationActionLabel(rec.action)}`,
      rec.suggestedShape ? `Suggested shape: ${rec.suggestedShape}` : null,
      rec.evidenceStatement ? `Evidence: ${rec.evidenceStatement}` : null,
      rec.questionsToAnswer.length > 0
        ? ['Questions to answer:', ...rec.questionsToAnswer.map((q) => `- ${q}`)].join('\n')
        : null,
      'Facts must be verified against workspace-approved sources before publishing.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n\n')

    try {
      await navigator.clipboard.writeText(lines)
      setCopyResult({ topicId: detail.canonicalTopicId, status: 'copied' })
    } catch {
      setCopyResult({ topicId: detail.canonicalTopicId, status: 'error' })
    }
  }, [detail])

  const primaryRecommendedTopicId =
    view === 'opportunities' && page ? page.recommendedTopicId : null

  const recommendedTopic = useMemo<ContentPlanTopicSummary | null>(() => {
    if (!primaryRecommendedTopicId || !page) {
      return null
    }
    return page.items.find((topic) => topic.id === primaryRecommendedTopicId) ?? null
  }, [page, primaryRecommendedTopicId])

  const showTwoPane = Boolean(activeTopic || detailLoadState === 'loading' || detailLoadState === 'not_found' || detailLoadState === 'error')

  return (
    <DashboardPage
      title={<span>Content plan</span>}
      description={
        page ? (
          <span>
            Last 30 days · <span className="text-muted-foreground">
              {formatWindowRange(page.window.from, page.window.to)}
            </span>{' '}
            · as of{' '}
            <span title={page.asOf} className="text-muted-foreground">
              {formatAsOfTimestamp(page.asOf)}
            </span>
          </span>
        ) : 'Last 30 days'
      }
      contentClassName="flex min-h-0 flex-col p-0 md:flex-row"
      contentScroll={false}
    >
      <div
        ref={scrollContainerRef}
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto',
          showTwoPane ? 'hidden md:flex md:w-1/2 md:min-w-0 md:border-r md:border-border' : 'flex',
        )}
        aria-label="Content plan list"
      >
        <div className="space-y-5 p-6">
          {listLoadState === 'ready' && page ? (
            <>
              <ProcessingStrip projection={page.projection} />
              <SummaryTiles summary={page.summary} />

              <RecommendedSlot
                view={view}
                page={page}
                recommendedTopic={recommendedTopic}
                onOpenTopic={(topicId) => selectTopic(topicId)}
                onWriteDocument={(topicId) => openWriteDocument(topicId)}
                onInvestigateRetrieval={(topicId) => openQualityForTopic(topicId)}
              />

              <ViewSwitcher
                view={view}
                buildViewHref={buildViewHref}
                opportunityCount={page.summary.opportunityCount}
                matureTopicCount={page.summary.matureTopicCount}
              />

              {page.items.length > 0 ? (
                <>
                  <section aria-label={view === 'opportunities' ? 'Ranked opportunities' : 'All interests'} className="space-y-2">
                    {page.items.map((topic) => (
                      <TopicRow
                        key={topic.id}
                        topic={topic}
                        selected={topic.id === selectedTopicId}
                        isRecommended={view === 'opportunities' && topic.id === primaryRecommendedTopicId}
                        onSelect={selectTopic}
                        registerRef={registerRowRef(topic.id)}
                      />
                    ))}
                  </section>
                  <TopicPaginationControls
                    hasMore={page.nextCursor !== null}
                    state={paginationState}
                    error={paginationError}
                    onLoadMore={() => void loadMoreTopics()}
                  />
                </>
              ) : (
                <ListEmptyState view={view} page={page} />
              )}

              <EmergingSection items={page.emerging} />
            </>
          ) : listLoadState === 'loading' ? (
            <ListLoadingSkeleton />
          ) : (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {listError ?? 'Could not load the Content plan.'}
            </div>
          )}
        </div>
      </div>

      {showTwoPane ? (
        <div
          className="flex min-h-0 w-full flex-1 flex-col md:w-1/2 md:min-w-0"
          aria-label="Selected topic detail"
        >
          {detailLoadState === 'loading' ? (
            <div className="flex flex-1 items-center justify-center">
              <LogoSpinner imageClassName="h-6 w-6" />
            </div>
          ) : detailLoadState === 'ready' && detail ? (
            <TopicDetailPane
              detail={detail}
              backHref={listHrefWithoutTopic}
              onBack={goToListWithoutTopic}
              onOpenConversation={openConversation}
              onViewAnswers={() => openQualityForTopic(detail.canonicalTopicId)}
              onWriteDocument={() => openWriteDocument(detail.canonicalTopicId)}
              onReviewDocument={(documentId) => openReviewDocument(documentId, detail.canonicalTopicId)}
              onInvestigateRetrieval={() => openQualityForTopic(detail.canonicalTopicId)}
              onCopyBrief={() => void copyBriefForActiveTopic()}
              copyStatus={copyStatus}
              isNarrow
            />
          ) : detailLoadState === 'not_found' ? (
            <TopicUnavailable
              title="This topic isn't available anymore"
              description="It may have been merged into another topic or removed by retention. Choose another topic from the list to continue."
              backHref={listHrefWithoutTopic}
            />
          ) : (
            <TopicUnavailable
              title="Could not load this topic"
              description={detailError ?? 'Try selecting another topic from the list.'}
              backHref={listHrefWithoutTopic}
            />
          )}
        </div>
      ) : null}

      <ConversationDrawer
        selectedItem={drawerSelectedItem}
        onSelectedItemChange={handleDrawerSelectedChange}
        anchorMessageId={openedConversation?.assistantMessageId ?? null}
        onAfterClose={handleDrawerClose}
      />

      <BriefAnnouncement copyStatus={copyStatus} />
    </DashboardPage>
  )
}

function TopicPaginationControls({
  hasMore,
  state,
  error,
  onLoadMore,
}: {
  hasMore: boolean
  state: PaginationLoadState
  error: string | null
  onLoadMore: () => void
}) {
  if (!hasMore) {
    return null
  }

  const isLoading = state === 'loading'
  return (
    <div className="flex flex-col items-center gap-2 pt-2" aria-live="polite">
      {state === 'error' ? (
        <p id="content-plan-pagination-error" className="text-sm text-destructive" role="alert">
          {error ?? 'Could not load more topics.'}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isLoading}
        aria-describedby={state === 'error' ? 'content-plan-pagination-error' : undefined}
        onClick={onLoadMore}
      >
        {isLoading ? (
          <>
            <Spinner className="mr-2" aria-hidden />
            Loading more topics…
          </>
        ) : state === 'error' ? 'Try again' : 'Load more topics'}
      </Button>
    </div>
  )
}

function ViewSwitcher({
  view,
  buildViewHref,
  opportunityCount,
  matureTopicCount,
}: {
  view: ContentPlanViewName
  buildViewHref: (view: ContentPlanViewName) => string
  opportunityCount: number
  matureTopicCount: number
}) {
  return (
    <div className="flex items-center gap-2" role="tablist" aria-label="Topic view">
      <ViewLink
        active={view === 'opportunities'}
        href={buildViewHref('opportunities')}
        label="Content opportunities"
        count={opportunityCount}
      />
      <ViewLink
        active={view === 'all_interests'}
        href={buildViewHref('all_interests')}
        label="All interests"
        count={matureTopicCount}
      />
    </div>
  )
}

function ViewLink({
  active,
  href,
  label,
  count,
}: {
  active: boolean
  href: string
  label: string
  count: number
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active
          ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/30'
          : 'border-border text-muted-foreground hover:bg-accent/30',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{count}</span>
    </Link>
  )
}

function RecommendedSlot({
  view,
  page,
  recommendedTopic,
  onOpenTopic,
  onWriteDocument,
  onInvestigateRetrieval,
}: {
  view: ContentPlanViewName
  page: ContentPlanPage
  recommendedTopic: ContentPlanTopicSummary | null
  onOpenTopic: (topicId: string) => void
  onWriteDocument: (topicId: string) => void
  onInvestigateRetrieval: (topicId: string) => void
}) {
  if (view !== 'opportunities') {
    return null
  }
  if (recommendedTopic) {
    const primaryAction = deriveRecommendedPrimaryAction(recommendedTopic, {
      onWriteDocument: () => onWriteDocument(recommendedTopic.id),
      onInvestigateRetrieval: () => onInvestigateRetrieval(recommendedTopic.id),
      onReviewDocument: () => onOpenTopic(recommendedTopic.id),
    })
    return (
      <RecommendedNextCard
        topic={recommendedTopic}
        primaryAction={primaryAction}
        onOpenTopic={() => onOpenTopic(recommendedTopic.id)}
      />
    )
  }

  // Server said there is no credible top card. Explain honestly.
  const { summary, projection } = page
  const hasNoTraffic = summary.questionCount === 0
  const rate = formatRatePercent(summary.grounding.reducedOrNoSupportRate)
  const hasUnmeasured = summary.grounding.headlineState === 'unmeasured'

  let headline = 'No recommendation right now'
  let body = 'When credible reduced- or no-support evidence appears, a recommended next action will show here.'

  if (hasNoTraffic) {
    headline = 'No eligible visitor traffic yet'
    body = 'Content plan will start once visitors send eligible questions. It never presents an empty period as healthy coverage.'
  } else if (projection.state === 'bootstrapping') {
    headline = 'Building the first view'
    body = 'Bootstrapping the last 60 days of eligible traffic. Recommendations will appear when topics mature.'
  } else if (projection.state === 'reprojecting') {
    headline = 'Reprojection in progress'
    body = 'The embedding space is changing. Nothing is compared across incompatible spaces; the previous coherent view is still readable in the list below.'
  } else if (hasUnmeasured) {
    headline = 'Coverage is unmeasured'
    body = 'No grounding-evaluated answers exist yet. Demand is still visible, but a grounding-driven recommendation cannot be generated from missing diagnostics.'
  } else if (summary.opportunityCount === 0 && rate !== null) {
    headline = 'No credible content gaps right now'
    body = `Answers are ${rate} reduced or no support of ${summary.grounding.evaluatedAnswerCount} measured — below the credible-gap threshold. Keep watching.`
  }

  return (
    <section
      aria-labelledby="content-plan-recommended-next-empty"
      className="rounded-xl border border-dashed border-border bg-muted/20 p-5"
    >
      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
        Recommended next
      </p>
      <h2 id="content-plan-recommended-next-empty" className="mt-1 text-lg font-semibold text-foreground">
        {headline}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </section>
  )
}

function deriveRecommendedPrimaryAction(
  topic: ContentPlanTopicSummary,
  handlers: {
    onWriteDocument: () => void
    onInvestigateRetrieval: () => void
    onReviewDocument: () => void
  },
): { label: string; onClick: () => void; kind: 'primary' | 'outline'; disabled?: boolean } {
  const rec = topic.recommendation
  switch (rec.action) {
    case 'add_content':
      return { label: 'Write document', onClick: handlers.onWriteDocument, kind: 'primary' }
    case 'review_existing_content':
      return { label: 'Review document', onClick: handlers.onReviewDocument, kind: 'primary' }
    case 'investigate_retrieval':
      return { label: 'Investigate retrieval', onClick: handlers.onInvestigateRetrieval, kind: 'primary' }
    case 'monitor':
    case null:
      return { label: 'View topic detail', onClick: handlers.onReviewDocument, kind: 'outline' }
  }
}

function ListEmptyState({ view, page }: { view: ContentPlanViewName; page: ContentPlanPage }) {
  const noTraffic = page.summary.questionCount === 0
  if (view === 'opportunities') {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-sm">
        <p className="font-medium text-foreground">
          {noTraffic ? 'No eligible traffic yet' : 'No credible opportunities right now'}
        </p>
        <p className="mt-1 text-muted-foreground">
          {noTraffic
            ? 'Content plan will populate once eligible visitor questions arrive.'
            : 'Switch to All interests to see well-covered topics that would not appear as a content gap.'}
        </p>
      </div>
    )
  }
  return (
    <div className="rounded-md border border-dashed border-border p-6 text-sm">
      <p className="font-medium text-foreground">No mature topics yet</p>
      <p className="mt-1 text-muted-foreground">
        Emerging questions are still building. This is not a claim of healthy coverage.
      </p>
    </div>
  )
}

function ListLoadingSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-label="Loading Content plan">
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

function TopicUnavailable({
  title,
  description,
  backHref,
}: {
  title: string
  description: string
  backHref: string
}) {
  return (
    <div className="flex flex-1 flex-col items-start gap-3 p-6">
      <Button asChild variant="ghost" size="sm">
        <Link href={backHref}>
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
          Back to Content plan
        </Link>
      </Button>
      <div className="rounded-md border border-border p-6">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function BriefAnnouncement({ copyStatus }: { copyStatus: CopyStatus }) {
  return (
    <span aria-live="polite" role="status" className="sr-only">
      {copyStatus === 'copied' ? 'Brief copied to clipboard.' : copyStatus === 'error' ? 'Could not copy the brief.' : ''}
    </span>
  )
}
