'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ChevronDown, FileText, PenSquare, RefreshCw, Info, Play } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import {
  audiencePulseApi,
  getAudiencePulseErrorCode,
  type AudiencePulseContentGap,
  type AudiencePulseHydratedReport,
  type AudiencePulseReadResponse,
  type AudiencePulseRecommendation,
  type AudiencePulseRefreshResponse,
  type AudiencePulseTheme,
  type AudiencePulseThemeEvidence,
} from '@/lib/api-audience-pulse'
import { getApiErrorMessage, getApiErrorStatus } from '@/lib/api-error'
import {
  buildDashboardHref,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import {
  writeAudiencePulseDraftSeed,
  type AudiencePulseDraftSeed,
} from '@/lib/audience-pulse-draft-seed'
import { writeAudiencePulseEvidenceHandoff } from '@/lib/audience-pulse-evidence-handoff'
import {
  getCoverageGapFraction,
  getSparklinePoints,
  normalizeTopicShare,
} from '@/lib/audience-pulse-topic-viz'

interface AudiencePulseViewProps {
  accountId: string
  routeState: DashboardRouteState
}

type SnapshotState =
  | { kind: 'initial-loading' }
  | { kind: 'load-failed'; message: string }
  | { kind: 'empty' }
  | { kind: 'no-traffic'; period: { start: string; end: string } }
  | { kind: 'ready'; report: AudiencePulseHydratedReport }

type RefreshState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'preparing' }
  | { kind: 'cancelled' }
  | { kind: 'busy' }
  | { kind: 'capacity'; message: string }
  | { kind: 'unavailable'; reason: 'provider' | 'validation' | 'cancelled' }
  | { kind: 'error'; message: string }

const numberFormat = new Intl.NumberFormat()
const percentFormat = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 })
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const MATERIAL_MEMBER_COUNT_CHANGE = 0.2

const formatDate = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date)
}

const formatDateTime = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date)
}

const getMemberCountDelta = (theme: AudiencePulseTheme): string | null => {
  if (theme.transition?.kind !== 'survived' || theme.previousMemberCount === null) return null

  const relativeChange = Math.abs(theme.memberCount - theme.previousMemberCount) / Math.max(theme.previousMemberCount, 1)
  if (relativeChange < MATERIAL_MEMBER_COUNT_CHANGE) return null

  return theme.memberCount > theme.previousMemberCount
    ? `up from ${numberFormat.format(theme.previousMemberCount)}`
    : `down from ${numberFormat.format(theme.previousMemberCount)}`
}


export function AudiencePulseView({ accountId, routeState }: AudiencePulseViewProps) {
  const router = useRouter()
  const workspaceId = routeState.workspaceId ?? null
  const refreshControllerRef = useRef<AbortController | null>(null)
  const readControllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  // The dashboard shell keys this subtree by the active workspace id, so a
  // workspace switch always remounts the view. That means we only need to
  // manage the read/refresh lifecycle for the current mount and never have to
  // cross-check a workspace guard here.
  const [snapshot, setSnapshot] = useState<SnapshotState>({ kind: 'initial-loading' })
  const [refresh, setRefresh] = useState<RefreshState>({ kind: 'idle' })
  const [lastRefreshEndedAt, setLastRefreshEndedAt] = useState<string | null>(null)

  const handleRead = useCallback(async () => {
    readControllerRef.current?.abort()
    const controller = new AbortController()
    readControllerRef.current = controller

    try {
      const response: AudiencePulseReadResponse = await audiencePulseApi.read({
        signal: controller.signal,
      })
      if (controller.signal.aborted || !mountedRef.current) return
      if (response.kind === 'completed') {
        setSnapshot({ kind: 'ready', report: response.report })
      } else {
        setSnapshot({ kind: 'empty' })
      }
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return
      setSnapshot({ kind: 'load-failed', message: getApiErrorMessage(error, 'Could not load Audience Pulse.') })
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const load = async () => {
      await handleRead()
    }
    void load()
    return () => {
      mountedRef.current = false
      readControllerRef.current?.abort()
      refreshControllerRef.current?.abort()
    }
  }, [handleRead])

  const requestRefresh = useCallback(async () => {
    refreshControllerRef.current?.abort()
    const controller = new AbortController()
    refreshControllerRef.current = controller
    setRefresh({ kind: 'running' })

    try {
      const response: AudiencePulseRefreshResponse = await audiencePulseApi.refresh({
        signal: controller.signal,
      })
      if (!mountedRef.current) return
      if (response.kind === 'completed') {
        setSnapshot({ kind: 'ready', report: response.report })
        setRefresh({ kind: 'idle' })
      } else if (response.kind === 'no_traffic') {
        // No-traffic never overwrites a valid saved report, per FR-003.
        setSnapshot((current) =>
          current.kind === 'ready'
            ? current
            : { kind: 'no-traffic', period: response.period },
        )
        setRefresh({ kind: 'idle' })
      } else if (response.kind === 'preparing') {
        setRefresh({ kind: 'preparing' })
      } else {
        setRefresh({ kind: 'unavailable', reason: response.reason })
      }
      setLastRefreshEndedAt(new Date().toISOString())
    } catch (error) {
      if (!mountedRef.current) return
      if (controller.signal.aborted) {
        setRefresh({ kind: 'cancelled' })
        return
      }
      const status = getApiErrorStatus(error)
      const code = getAudiencePulseErrorCode(error)
      if (status === 409 || code === 'AUDIENCE_PULSE_REFRESH_IN_PROGRESS') {
        setRefresh({ kind: 'busy' })
      } else if (status === 429) {
        setRefresh({
          kind: 'capacity',
          message:
            code === 'AUDIENCE_PULSE_USAGE_LIMITED'
              ? 'Analysis capacity is temporarily exhausted for this workspace. Try again later.'
              : 'Audience Pulse refresh is rate limited. Try again in a few minutes.',
        })
      } else {
        setRefresh({
          kind: 'error',
          message: getApiErrorMessage(error, 'Refresh could not complete. The saved report is unchanged.'),
        })
      }
      setLastRefreshEndedAt(new Date().toISOString())
    }
  }, [])

  const handleRefresh = useCallback(async () => {
    if (refresh.kind === 'running' || refresh.kind === 'preparing') return
    await requestRefresh()
  }, [refresh.kind, requestRefresh])

  useEffect(() => {
    if (refresh.kind !== 'preparing') return
    const controller = new AbortController()
    let timer: number | undefined
    const poll = () => {
      timer = window.setTimeout(() => {
      void audiencePulseApi.getRefreshStatus({ signal: controller.signal })
        .then((status) => {
          if (!controller.signal.aborted && mountedRef.current && !status.pending) {
            void requestRefresh()
          } else if (!controller.signal.aborted && mountedRef.current) {
            poll()
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted && mountedRef.current) {
            setRefresh({ kind: 'error', message: getApiErrorMessage(error, 'Could not check report preparation.') })
          }
        })
      }, 1_500)
    }
    poll()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refresh.kind, requestRefresh])

  const openConversation = useCallback(
    (evidence: AudiencePulseThemeEvidence) => {
      if (!workspaceId) return
      writeAudiencePulseEvidenceHandoff({
        accountId,
        workspaceId,
        evidence: {
          conversationId: evidence.conversationId,
          messageId: evidence.messageId,
        },
      })
      router.push(
        buildDashboardHref(accountId, {
          ...routeState,
          section: 'activity',
          activityTab: 'all',
          historyFilter: undefined,
          historyPage: undefined,
          historyItemKind: undefined,
          historyItemId: undefined,
          historyMessageId: undefined,
        }),
      )
    },
    [accountId, routeState, router, workspaceId],
  )

  const openDraft = useCallback(
    (recommendation: AudiencePulseRecommendation) => {
      if (!workspaceId) return
      const seed: AudiencePulseDraftSeed = {
        title: recommendation.startDraft.title,
        questions: recommendation.startDraft.questions,
      }
      writeAudiencePulseDraftSeed({ accountId, workspaceId, seed })
      router.push(
        buildDashboardHref(accountId, {
          ...routeState,
          section: 'knowledge',
          knowledgeTab: 'documents',
          documentId: undefined,
          anchor: 'audience-pulse-draft',
        }),
      )
    },
    [accountId, routeState, router, workspaceId],
  )

  const isRefreshing = refresh.kind === 'running' || refresh.kind === 'preparing'
  const hasSavedReport = snapshot.kind === 'ready'
  const analysisButtonLabel = hasSavedReport ? 'Refresh' : 'Analyze last 30 days'

  const headerActions = (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        onClick={() => { void handleRefresh() }}
        disabled={isRefreshing || snapshot.kind === 'initial-loading'}
        aria-label={analysisButtonLabel}
      >
        {isRefreshing
          ? <Spinner className="mr-2 h-4 w-4" aria-hidden />
          : hasSavedReport
            ? <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            : <Play className="mr-2 h-4 w-4" aria-hidden />}
        {analysisButtonLabel}
      </Button>
    </div>
  )

  return (
    <DashboardPage
      title="Audience Pulse"
      description="What visitors asked about in the last 30 days."
      actions={headerActions}
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <RefreshBanner
          state={refresh}
          hasSavedReport={hasSavedReport}
          lastRefreshEndedAt={lastRefreshEndedAt}
        />
        <SnapshotBody
          snapshot={snapshot}
          onAnalyze={handleRefresh}
          isRefreshing={isRefreshing}
          onOpenConversation={openConversation}
          onStartDraft={openDraft}
          canStartDraft={Boolean(workspaceId)}
        />
      </div>
    </DashboardPage>
  )
}

function RefreshBanner({
  state,
  hasSavedReport,
  lastRefreshEndedAt,
}: {
  state: RefreshState
  hasSavedReport: boolean
  lastRefreshEndedAt: string | null
}) {
  if (state.kind === 'idle' || state.kind === 'running') {
    return null
  }
  const finishedAt = lastRefreshEndedAt ? formatDateTime(lastRefreshEndedAt) : null
  const commonClass = 'flex items-start gap-3 rounded-md border p-3 text-sm'

  if (state.kind === 'preparing') {
    return (
      <div className={`${commonClass} border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100`} role="status">
        <Spinner className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Preparing your report from all pending visitor questions.</p>
          <p className="text-xs opacity-80">This continues automatically; you do not need to refresh the page or click again.</p>
        </div>
      </div>
    )
  }

  if (state.kind === 'busy') {
    return (
      <div className={`${commonClass} border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100`} role="status">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Another refresh is already running for this workspace.</p>
          <p className="text-xs opacity-80">Try again in a moment.</p>
        </div>
      </div>
    )
  }
  if (state.kind === 'capacity') {
    return (
      <div className={`${commonClass} border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100`} role="status">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Refresh capacity reached.</p>
          <p className="text-xs opacity-80">{state.message}</p>
        </div>
      </div>
    )
  }
  if (state.kind === 'cancelled') {
    return (
      <div className={`${commonClass} border-muted bg-muted/50 text-muted-foreground`} role="status">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>Refresh was cancelled. The saved report is unchanged.</p>
      </div>
    )
  }
  if (state.kind === 'unavailable') {
    return (
      <div className={`${commonClass} border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100`} role="alert">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">We couldn&apos;t complete the analysis. Try again in a moment.</p>
          {hasSavedReport ? (
            <p className="text-xs opacity-80">
              The previous report is still shown{finishedAt ? ` (attempt ended ${finishedAt})` : ''}.
            </p>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div className={`${commonClass} border-destructive/40 bg-destructive/10 text-destructive`} role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">Refresh failed.</p>
        <p className="text-xs opacity-80">
          {state.message}
          {hasSavedReport && finishedAt ? ` The previous saved report is still shown (attempt ended ${finishedAt}).` : null}
        </p>
      </div>
    </div>
  )
}

function SnapshotBody({
  snapshot,
  onAnalyze,
  isRefreshing,
  onOpenConversation,
  onStartDraft,
  canStartDraft,
}: {
  snapshot: SnapshotState
  onAnalyze: () => Promise<void> | void
  isRefreshing: boolean
  onOpenConversation: (evidence: AudiencePulseThemeEvidence) => void
  onStartDraft: (recommendation: AudiencePulseRecommendation) => void
  canStartDraft: boolean
}) {
  if (snapshot.kind === 'initial-loading') {
    return (
      <div className="flex min-h-[240px] items-center justify-center" role="status" aria-live="polite">
        <LogoSpinner imageClassName="h-6 w-6" />
        <span className="sr-only">Loading Audience Pulse</span>
      </div>
    )
  }
  if (snapshot.kind === 'load-failed') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Could not load Audience Pulse</CardTitle>
          <CardDescription>{snapshot.message}</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  if (snapshot.kind === 'empty') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No saved report yet</CardTitle>
          <CardDescription>
            Audience Pulse runs on demand. Choose <strong>Analyze last 30 days</strong> to synthesize the recurring
            themes and content gaps in your recent visitor conversations. Nothing runs automatically, and no document
            is created without your explicit save.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" onClick={() => { void onAnalyze() }} disabled={isRefreshing}>
            <Play className="mr-2 h-4 w-4" aria-hidden />
            Analyze last 30 days
          </Button>
        </CardContent>
      </Card>
    )
  }
  if (snapshot.kind === 'no-traffic') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Not enough recent visitor traffic</CardTitle>
          <CardDescription>
            The 30-day window from {formatDate(snapshot.period.start)} to {formatDate(snapshot.period.end)} did not
            contain enough visitor conversations to analyze.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <ReportContent
      report={snapshot.report}
      onOpenConversation={onOpenConversation}
      onStartDraft={onStartDraft}
      canStartDraft={canStartDraft}
    />
  )
}

function ReportContent({
  report,
  onOpenConversation,
  onStartDraft,
  canStartDraft,
}: {
  report: AudiencePulseHydratedReport
  onOpenConversation: (evidence: AudiencePulseThemeEvidence) => void
  onStartDraft: (recommendation: AudiencePulseRecommendation) => void
  canStartDraft: boolean
}) {
  const themesById = useMemo(() => {
    const map = new Map<string, AudiencePulseTheme>()
    for (const theme of report.themes) map.set(theme.id, theme)
    return map
  }, [report.themes])

  const contentGapByTheme = useMemo(() => {
    const map = new Map<string, AudiencePulseContentGap>()
    for (const gap of report.contentGaps) map.set(gap.themeId, gap)
    return map
  }, [report.contentGaps])

  const { sampled, sampleSize, populationSize, facetReadyQuestionCount } = report.coverage
  const unclassifiedDenominator = sampled ? sampleSize : populationSize
  // Nothing in this window has been prepared for topic analysis yet — historical questions
  // that predate extraction, or a backfill still draining. Saying "no recurring themes"
  // here would describe the audience when the truth is that nothing has been computed.
  const awaitingTopicAnalysis = populationSize > 0 && facetReadyQuestionCount === 0
  const partiallyAnalysed = !sampled && facetReadyQuestionCount > 0 && facetReadyQuestionCount < populationSize
  const maxThemeShare = Math.max(...report.themes.map((theme) => theme.share))

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Last 30 days</CardTitle>
          <CardDescription>
            {formatDate(report.period.start)} – {formatDate(report.period.end)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Saved {formatDateTime(report.generatedAt)}.{' '}
            {sampled
              ? `Read ${numberFormat.format(sampleSize)} of ${numberFormat.format(populationSize)} questions.`
              : `Read all ${numberFormat.format(populationSize)} questions.`}
          </p>
          {awaitingTopicAnalysis ? (
            <p className="text-sm text-muted-foreground">
              Topic analysis is still being prepared for this period. The question counts above
              are final; topics appear once these questions have been processed.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{report.summary}</p>
          )}
        </CardContent>
      </Card>

      {partiallyAnalysed ? (
        <div className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            {numberFormat.format(facetReadyQuestionCount)} of{' '}
            {numberFormat.format(populationSize)} questions have been processed so far, so
            topics below cover part of this period.
          </p>
        </div>
      ) : null}

      {!awaitingTopicAnalysis
        && !partiallyAnalysed
        && report.unclassifiedQuestionCount > unclassifiedDenominator / 2 ? (
        <div className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            Most questions weren&apos;t grouped into a topic (
            {numberFormat.format(report.unclassifiedQuestionCount)} of{' '}
            {numberFormat.format(unclassifiedDenominator)}).
          </p>
        </div>
      ) : null}

      <section aria-labelledby="audience-pulse-recommendations">
        <h2 id="audience-pulse-recommendations" className="mb-2 text-base font-semibold text-foreground">
          Content opportunities
        </h2>
        {report.recommendations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recurring content opportunity was identified in this period.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {report.recommendations.map((recommendation) => {
              const theme = themesById.get(recommendation.themeId)
              const gap = contentGapByTheme.get(recommendation.themeId)
              return (
                <Card key={recommendation.id}>
                  <CardHeader>
                    <CardTitle className="text-sm">{recommendation.title}</CardTitle>
                    <CardDescription>
                      {theme && gap ? (
                        <>
                          From &ldquo;{theme.title}&rdquo; · asked {numberFormat.format(gap.eligibleEvidenceCount)}× in{' '}
                          {numberFormat.format(gap.distinctConversationCount)} conversations.
                        </>
                      ) : theme ? (
                        <>From &ldquo;{theme.title}&rdquo;.</>
                      ) : gap ? (
                        <>
                          Asked {numberFormat.format(gap.eligibleEvidenceCount)}× in{' '}
                          {numberFormat.format(gap.distinctConversationCount)} conversations.
                        </>
                      ) : null}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">{recommendation.rationale}</p>
                    {recommendation.questions.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Questions to cover
                        </p>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                          {recommendation.questions.map((question, index) => (
                            <li key={`${recommendation.id}-q-${index}`}>{question}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={!canStartDraft}
                        onClick={() => onStartDraft(recommendation)}
                        data-testid={`audience-pulse-start-draft-${recommendation.id}`}
                      >
                        <PenSquare className="mr-2 h-4 w-4" aria-hidden />
                        Start draft
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="audience-pulse-topics">
        <h2 id="audience-pulse-topics" className="mb-2 text-base font-semibold text-foreground">
          Topics
        </h2>
        {report.themes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {awaitingTopicAnalysis
              ? 'Topics appear here once the questions in this period have been processed.'
              : 'The analysis did not identify any recurring themes.'}
          </p>
        ) : (
          <Card className="gap-0 py-0">
            {report.themes.map((theme) => (
              <TopicRow
                key={theme.id}
                theme={theme}
                gap={contentGapByTheme.get(theme.id) ?? null}
                maxShare={maxThemeShare}
                onOpenConversation={onOpenConversation}
              />
            ))}
          </Card>
        )}
      </section>

      {report.caveats.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">What this doesn&apos;t tell you</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {report.caveats.map((caveat, index) => (
                <li key={`caveat-${index}`}>{caveat}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {sampled ? (
        <p className="text-xs text-muted-foreground">
          Counts reflect the questions we read, not total demand.
        </p>
      ) : null}
    </div>
  )
}

function TopicRow({
  theme,
  gap,
  maxShare,
  onOpenConversation,
}: {
  theme: AudiencePulseTheme
  gap: AudiencePulseContentGap | null
  maxShare: number
  onOpenConversation: (evidence: AudiencePulseThemeEvidence) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const contentId = `audience-pulse-topic-${theme.id}`
  const normalizedShare = normalizeTopicShare(theme.share, maxShare)
  const coverageGapFraction = getCoverageGapFraction(
    theme.grounding.contentGapEligible,
    theme.memberCount,
  )
  const memberCountDelta = getMemberCountDelta(theme)
  const transitionBadge = theme.transition?.kind === 'emerged'
    ? 'New'
    : theme.transition?.kind === 'split'
      ? 'Split'
      : theme.transition?.kind === 'merged'
        ? 'Merged'
        : null

  return (
    <div className="border-b last:border-b-0" data-testid="audience-pulse-topic-row">
      <div className="space-y-2 px-4 py-4 sm:px-6">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((prev) => !prev)}
          className="flex w-full items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{theme.title}</span>
            {transitionBadge ? <Badge variant="secondary">{transitionBadge}</Badge> : null}
            {theme.transition?.viaCentroidFallback ? (
              <Badge variant="outline" className="text-muted-foreground">Estimated</Badge>
            ) : null}
            {gap ? (
              <>
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100"
                >
                  Not covered
                </Badge>
                <span className="text-xs tabular-nums text-muted-foreground">
                  asked {numberFormat.format(gap.eligibleEvidenceCount)}× in{' '}
                  {numberFormat.format(gap.distinctConversationCount)}{' '}
                  {gap.distinctConversationCount === 1 ? 'conversation' : 'conversations'}
                </span>
              </>
            ) : null}
          </span>
          <TopicSparkline weeklyPulse={theme.weeklyPulse} />
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden
          />
          <span className="sr-only">{expanded ? 'Hide examples' : 'Show examples'}</span>
        </button>
        <TopicShareBar normalizedShare={normalizedShare} coverageGapFraction={coverageGapFraction} />
        <p className="text-xs tabular-nums text-muted-foreground">
          asked {numberFormat.format(theme.memberCount)}×
          {memberCountDelta ? ` · ${memberCountDelta}` : ''} · {percentFormat.format(theme.share)} of questions
        </p>
        {expanded ? (
          <div id={contentId} className="space-y-3 pt-1">
            <p className="text-sm text-muted-foreground">{theme.description}</p>
            <GroundingSummaryStrip grounding={theme.grounding} />
            {theme.evidence.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Examples · {numberFormat.format(theme.evidence.length)} of {numberFormat.format(theme.memberCount)}{' '}
                  {theme.memberCount === 1 ? 'question' : 'questions'}
                </p>
                <ul className="flex flex-col gap-1 text-sm">
                  {theme.evidence.map((evidence) => (
                    <li key={evidence.reference} className="flex items-start gap-2">
                      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <button
                        type="button"
                        onClick={() => onOpenConversation(evidence)}
                        className="text-left text-sm text-foreground underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
                      >
                        {evidence.question}
                        {evidence.occurrenceCount > 1
                          ? ` · asked ${numberFormat.format(evidence.occurrenceCount)}×`
                          : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TopicShareBar({
  normalizedShare,
  coverageGapFraction,
}: {
  normalizedShare: number
  coverageGapFraction: number
}) {
  const hasShare = normalizedShare > 0
  const hasCoverageGap = hasShare && coverageGapFraction > 0
  const primaryFraction = 1 - coverageGapFraction

  return (
    <div className="h-2 w-full rounded-full bg-muted" aria-hidden>
      {hasShare ? (
        <div
          className="relative h-full"
          style={{ width: `max(2px, ${normalizedShare * 100}%)` }}
        >
          {primaryFraction > 0 ? (
            <span
              className={`absolute inset-y-0 left-0 bg-primary ${hasCoverageGap ? '' : 'rounded-r-full'}`}
              style={{ width: `${primaryFraction * 100}%` }}
            />
          ) : null}
          {hasCoverageGap ? (
            <span
              className={`absolute inset-y-0 right-0 bg-amber-500 rounded-r-full ${primaryFraction > 0 ? 'border-l-2 border-card' : ''}`}
              style={{ width: `${coverageGapFraction * 100}%` }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// Renders inside the row's expand <button>, so it must stay non-interactive:
// the quality-tile Sparkline (recharts) adds a tooltip and a focusable
// accessibility layer, which cannot legally nest inside another control.
function TopicSparkline({ weeklyPulse }: { weeklyPulse: AudiencePulseTheme['weeklyPulse'] }) {
  const points = getSparklinePoints(weeklyPulse.map((week) => week.count))
  if (points.length === 0) return null

  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return null

  return (
    <span className="shrink-0">
      <svg
        viewBox="0 0 72 24"
        className="h-6 w-[72px] text-muted-foreground"
        aria-hidden
        focusable="false"
      >
        <polyline
          points={points.map((point) => `${point.x},${point.y}`).join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx={last.x}
          cy={last.y}
          r="3"
          className="fill-primary stroke-card"
          strokeWidth="2"
        />
      </svg>
      <span className="sr-only">
        Weekly questions by week: {points.map((point) => numberFormat.format(point.value)).join(', ')}.
      </span>
    </span>
  )
}

function GroundingSummaryStrip({
  grounding,
}: {
  grounding: AudiencePulseTheme['grounding']
}) {
  const entries: Array<{ label: string; value: number; tone: string; description: string }> = [
    { label: 'Answered from your docs', value: grounding.grounded, tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100', description: 'Answered with grounded support.' },
    { label: 'Partly answered', value: grounding.degraded, tone: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100', description: 'Answered with partial grounded support.' },
    { label: "Couldn't answer", value: grounding.noSupport, tone: 'border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-100', description: 'Answer had no grounded support.' },
    { label: 'Not recorded', value: grounding.unknown, tone: 'border-muted bg-muted text-muted-foreground', description: 'No grounding diagnostic was available.' },
  ]

  const visible = entries.filter((e) => e.value > 0)
  if (visible.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2" aria-label="Grounding summary">
      {visible.map((entry) => (
        <span
          key={entry.label}
          title={entry.description}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${entry.tone}`}
        >
          <span className="font-medium">{entry.label}</span>
          <span className="tabular-nums">{numberFormat.format(entry.value)}</span>
        </span>
      ))}
    </div>
  )
}
