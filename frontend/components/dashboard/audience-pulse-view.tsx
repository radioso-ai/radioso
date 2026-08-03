'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, FileText, PenSquare, RefreshCw, Info, Play } from 'lucide-react'

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
  type AudiencePulseWeeklyVolume,
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

interface AudiencePulseViewProps {
  accountId: string
  routeState: DashboardRouteState
}

type SnapshotState =
  | { kind: 'initial-loading' }
  | { kind: 'load-failed'; message: string }
  | { kind: 'empty' }
  | { kind: 'no-traffic'; period: { start: string; end: string }; weeklyVolume: AudiencePulseWeeklyVolume[] }
  | { kind: 'ready'; report: AudiencePulseHydratedReport }

type RefreshState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'cancelled' }
  | { kind: 'busy' }
  | { kind: 'capacity'; message: string }
  | { kind: 'unavailable'; reason: 'provider' | 'validation' | 'cancelled' }
  | { kind: 'error'; message: string }

const numberFormat = new Intl.NumberFormat()
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const weekFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

const formatDate = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date)
}

const formatDateTime = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date)
}

const formatWeek = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : weekFormat.format(date)
}

const pulseIntensity = (count: number, max: number): { label: string; className: string } => {
  if (max === 0 || count === 0) {
    return { label: 'no evidence', className: 'bg-muted text-muted-foreground' }
  }
  const ratio = count / max
  if (ratio < 0.25) return { label: 'low', className: 'bg-sky-500/20 text-sky-900 dark:text-sky-100' }
  if (ratio < 0.5) return { label: 'moderate', className: 'bg-sky-500/40 text-sky-950 dark:text-sky-50' }
  if (ratio < 0.75) return { label: 'high', className: 'bg-sky-600/60 text-white' }
  return { label: 'very high', className: 'bg-sky-700 text-white' }
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

  const handleRefresh = useCallback(async () => {
    if (refresh.kind === 'running') return
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
            : { kind: 'no-traffic', period: response.period, weeklyVolume: response.weeklyVolume },
        )
        setRefresh({ kind: 'idle' })
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
  }, [refresh.kind])

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

  const isRefreshing = refresh.kind === 'running'
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
      description="A read-only synthesis of the last 30 days of visitor conversations. Analysis runs only when you ask for it."
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

  if (state.kind === 'busy') {
    return (
      <div className={`${commonClass} border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100`} role="status">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Another refresh is already running for this workspace.</p>
          <p className="text-xs opacity-80">Try again in a moment. This is not a provider failure.</p>
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
    const label =
      state.reason === 'provider'
        ? 'Analysis provider is unavailable.'
        : state.reason === 'validation'
          ? 'The analysis result could not be validated.'
          : 'The refresh was cancelled.'
    return (
      <div className={`${commonClass} border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100`} role="alert">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{label}</p>
          <p className="text-xs opacity-80">
            {hasSavedReport
              ? `The previous saved report is still shown${finishedAt ? ` (attempt ended ${finishedAt})` : ''}.`
              : 'No report has been saved yet. Try again in a moment.'}
          </p>
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
            contain eligible visitor conversations to analyze. No provider call was made.
          </CardDescription>
        </CardHeader>
        {snapshot.weeklyVolume.length > 0 ? (
          <CardContent>
            <WeeklyVolumeTable weeklyVolume={snapshot.weeklyVolume} caption="Eligible visitor volume by week" />
          </CardContent>
        ) : null}
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

  const contentGapThemeIds = useMemo(
    () => new Set(report.contentGaps.map((gap) => gap.themeId)),
    [report.contentGaps],
  )
  const contentGapByTheme = useMemo(() => {
    const map = new Map<string, AudiencePulseContentGap>()
    for (const gap of report.contentGaps) map.set(gap.themeId, gap)
    return map
  }, [report.contentGaps])

  const sampled = report.coverage.sampled

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {formatDate(report.period.start)} to {formatDate(report.period.end)}
          </CardTitle>
          <CardDescription>
            Saved report generated {formatDateTime(report.generatedAt)}. Population:{' '}
            {numberFormat.format(report.coverage.populationSize)} eligible visitor questions. Analyzed sample:{' '}
            {numberFormat.format(report.coverage.sampleSize)}
            {sampled ? ' — theme intensity and counts below reflect the analyzed sample, not total demand.' : '.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{report.summary}</p>
          <WeeklyVolumeTable
            weeklyVolume={report.weeklyVolume}
            caption="Exact eligible visitor volume by week"
          />
        </CardContent>
      </Card>

      <section aria-labelledby="audience-pulse-topics">
        <h2 id="audience-pulse-topics" className="mb-2 text-base font-semibold text-foreground">
          Topics being discussed
        </h2>
        {report.themes.length === 0 ? (
          <p className="text-sm text-muted-foreground">The analysis did not identify any recurring themes.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {report.themes.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                sampled={sampled}
                isContentGap={contentGapThemeIds.has(theme.id)}
                onOpenConversation={onOpenConversation}
              />
            ))}
          </div>
        )}
      </section>

      {report.contentGaps.length > 0 ? (
        <section aria-labelledby="audience-pulse-gaps">
          <h2 id="audience-pulse-gaps" className="mb-2 text-base font-semibold text-foreground">
            Observed content gaps
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            These themes had recurring visitor questions whose assistant answers had no or degraded grounded support in
            the analyzed sample. This is a recurring sample signal — not proof that a document is absent from your
            workspace. Refine your source coverage or run a corpus check before assuming anything is missing.
          </p>
          <div className="flex flex-col gap-3">
            {report.contentGaps.map((gap) => {
              const theme = themesById.get(gap.themeId)
              if (!theme) return null
              return (
                <Card key={gap.themeId} className="border-amber-500/30">
                  <CardHeader>
                    <CardTitle className="text-sm">{theme.title}</CardTitle>
                    <CardDescription>
                      {numberFormat.format(gap.eligibleEvidenceCount)} eligible signals across{' '}
                      {numberFormat.format(gap.distinctConversationCount)} distinct conversations in the analyzed
                      sample.
                    </CardDescription>
                  </CardHeader>
                </Card>
              )
            })}
          </div>
        </section>
      ) : null}

      {report.recommendations.length > 0 ? (
        <section aria-labelledby="audience-pulse-recommendations">
          <h2 id="audience-pulse-recommendations" className="mb-2 text-base font-semibold text-foreground">
            Content opportunities
          </h2>
          <div className="flex flex-col gap-3">
            {report.recommendations.map((recommendation) => {
              const theme = themesById.get(recommendation.themeId)
              const gap = contentGapByTheme.get(recommendation.themeId)
              return (
                <Card key={recommendation.id}>
                  <CardHeader>
                    <CardTitle className="text-sm">{recommendation.title}</CardTitle>
                    <CardDescription>
                      {theme ? <>Anchored to theme <strong>{theme.title}</strong>. </> : null}
                      {gap ? (
                        <>
                          Based on {numberFormat.format(gap.eligibleEvidenceCount)} recurring signals across{' '}
                          {numberFormat.format(gap.distinctConversationCount)} conversations in the analyzed sample.
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
        </section>
      ) : null}

      {report.caveats.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Analysis caveats</CardTitle>
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
    </div>
  )
}

function ThemeCard({
  theme,
  sampled,
  isContentGap,
  onOpenConversation,
}: {
  theme: AudiencePulseTheme
  sampled: boolean
  isContentGap: boolean
  onOpenConversation: (evidence: AudiencePulseThemeEvidence) => void
}) {
  const maxPulse = theme.weeklyPulse.reduce((max, cell) => (cell.count > max ? cell.count : max), 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span>{theme.title}</span>
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
            {numberFormat.format(theme.sampleCount)} sampled
          </Badge>
          {isContentGap ? (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100">
              Observed content gap
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{theme.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <GroundingSummaryStrip
          grounding={theme.grounding}
          sampled={sampled}
        />
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {sampled ? 'Analyzed-sample weekly pulse' : 'Weekly pulse'}
          </p>
          <div
            className="flex flex-wrap gap-1"
            role="list"
            aria-label={sampled ? 'Analyzed-sample weekly pulse' : 'Weekly pulse'}
          >
            {theme.weeklyPulse.map((cell) => {
              const meta = pulseIntensity(cell.count, maxPulse)
              return (
                <span
                  key={cell.weekStart}
                  role="listitem"
                  aria-label={`Week of ${formatWeek(cell.weekStart)}: ${numberFormat.format(cell.count)} sampled visitor question${cell.count === 1 ? '' : 's'} (${meta.label})`}
                  className={`inline-flex min-w-[3.5rem] flex-col items-center rounded-md border border-transparent px-2 py-1 text-[10px] font-medium ${meta.className}`}
                >
                  <span className="text-[10px] uppercase opacity-80">{formatWeek(cell.weekStart)}</span>
                  <span className="text-xs" aria-hidden>{numberFormat.format(cell.count)}</span>
                </span>
              )
            })}
          </div>
        </div>
        {theme.evidence.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Representative evidence
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
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function GroundingSummaryStrip({
  grounding,
  sampled,
}: {
  grounding: AudiencePulseTheme['grounding']
  sampled: boolean
}) {
  const entries: Array<{ label: string; value: number; tone: string; description: string }> = [
    { label: 'Grounded', value: grounding.grounded, tone: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100', description: 'Answered with grounded support.' },
    { label: 'Degraded', value: grounding.degraded, tone: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100', description: 'Answered with partial grounded support.' },
    { label: 'No support', value: grounding.noSupport, tone: 'border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-100', description: 'Answer had no grounded support.' },
    { label: 'Unknown', value: grounding.unknown, tone: 'border-muted bg-muted text-muted-foreground', description: 'No grounding diagnostic was available.' },
    { label: 'Gap-eligible', value: grounding.contentGapEligible, tone: 'border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100', description: 'Signals that qualify for the recurring content-gap section.' },
  ]

  return (
    <div className="flex flex-wrap gap-2" aria-label={sampled ? 'Analyzed-sample grounding summary' : 'Grounding summary'}>
      {entries.map((entry) => (
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

function WeeklyVolumeTable({
  weeklyVolume,
  caption,
}: {
  weeklyVolume: AudiencePulseWeeklyVolume[]
  caption: string
}) {
  if (weeklyVolume.length === 0) return null
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
          <th scope="col" className="py-1 pr-2 font-medium">Week starting</th>
          <th scope="col" className="py-1 pr-2 font-medium">Visitor questions</th>
          <th scope="col" className="py-1 font-medium">Conversations</th>
        </tr>
      </thead>
      <tbody>
        {weeklyVolume.map((week) => (
          <tr key={week.weekStart} className="border-b border-border/40 last:border-b-0">
            <th scope="row" className="py-1 pr-2 font-normal text-foreground">{formatWeek(week.weekStart)}</th>
            <td className="py-1 pr-2 tabular-nums">{numberFormat.format(week.visitorQuestionCount)}</td>
            <td className="py-1 tabular-nums">{numberFormat.format(week.conversationCount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
