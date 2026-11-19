'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw, Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { PulseReport } from '@/components/dashboard/audience-pulse/pulse-report'
import { formatDay, formatDayMonthTime, formatPeriod } from '@/components/dashboard/audience-pulse/pulse-dates'
import { RefreshBanner, type RefreshState } from '@/components/dashboard/audience-pulse/refresh-banner'
import {
  audiencePulseApi,
  getAudiencePulseErrorCode,
  type AudiencePulseHydratedReport,
  type AudiencePulseReadResponse,
  type AudiencePulseRefreshResponse,
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
    (seed: AudiencePulseDraftSeed) => {
      if (!workspaceId) return
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
    <div className="flex items-center gap-3">
      {snapshot.kind === 'ready' ? (
        <span className="text-sm text-muted-foreground">
          {formatPeriod(snapshot.report.period)} · Updated {formatDayMonthTime(snapshot.report.generatedAt)}
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant={hasSavedReport ? 'outline' : 'default'}
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
    <DashboardPage title="Audience Pulse" actions={headerActions}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
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
  onStartDraft: (seed: AudiencePulseDraftSeed) => void
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
            The 30-day window from {formatDay(snapshot.period.start)} to {formatDay(snapshot.period.end)} did not
            contain enough visitor conversations to analyze.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <PulseReport
      report={snapshot.report}
      onOpenConversation={onOpenConversation}
      onStartDraft={onStartDraft}
      canStartDraft={canStartDraft}
    />
  )
}
