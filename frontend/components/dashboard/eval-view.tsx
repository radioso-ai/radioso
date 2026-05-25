'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogoSpinner } from '@/components/ui/spinner'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { AssertionEditor } from './eval/assertion-editor'
import { evalsApi, documentsApi } from '@/lib/api'
import type {
  AssertionVerdict,
  AssertionVerdictStatus,
  EvalAssertion,
  EvalCase,
  EvalCaseStatus,
  EvalCaseWithRuns,
  EvalRun,
  EvalRunMode,
  EvalRunStatus,
  EvalSnapshot,
} from '@/lib/api-eval'
import type { DocumentSummary } from '@/lib/api-types'
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'

type AnyStatus = EvalCaseStatus | EvalRunStatus | AssertionVerdictStatus

const statusBadgeClass = (status: AnyStatus): string => {
  switch (status) {
    case 'passing':
    case 'pass':
      return 'border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200'
    case 'failing':
    case 'fail':
      return 'border-transparent bg-rose-100 text-rose-900 dark:bg-rose-900/30 dark:text-rose-200'
    case 'error':
      return 'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
    default:
      return 'border-border bg-background text-foreground'
  }
}

const formatRelative = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

const assertionSummary = (a: EvalAssertion, titleFor: (id: string) => string | undefined): string => {
  switch (a.type) {
    case 'retrieval_includes_document':
    case 'retrieval_excludes_document':
    case 'retrieval_top_k_includes_document': {
      const docLabel = titleFor(a.documentId) ?? `document ${a.documentId.slice(0, 8)}`
      if (a.type === 'retrieval_includes_document') return `Retrieval should include ${docLabel}`
      if (a.type === 'retrieval_excludes_document') return `Retrieval should NOT include ${docLabel}`
      return `${docLabel} should rank in the top ${a.k}`
    }
    case 'answer_contains':
      return `Answer should ${a.matchMode === 'regex' ? 'match regex' : 'contain'} ${JSON.stringify(a.pattern)}`
    case 'answer_does_not_contain':
      return `Answer should NOT ${a.matchMode === 'regex' ? 'match regex' : 'contain'} ${JSON.stringify(a.pattern)}`
    case 'llm_judge':
      return `LLM judge against reference answer`
  }
}

// A case with any answer-based or judge assertion needs full_assistant mode
// for those assertions to grade. The detail page auto-selects this mode.
const inferDefaultMode = (assertions: EvalAssertion[]): EvalRunMode => {
  const needsAnswer = assertions.some(
    (a) =>
      a.type === 'answer_contains' ||
      a.type === 'answer_does_not_contain' ||
      a.type === 'llm_judge',
  )
  return needsAnswer ? 'full_assistant' : 'retrieval_only'
}

interface EvalListProps {
  accountId: string
  routeState: DashboardRouteState
}

function EvalList({ accountId, routeState }: EvalListProps) {
  const router = useRouter()
  const [cases, setCases] = useState<EvalCase[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await evalsApi.listCases()
      setCases(response.cases)
      setError(null)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Eval request failed'))
      setCases([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openCase = (caseId: string) => {
    router.push(buildDashboardHref(accountId, { ...routeState, section: 'eval', evalCaseId: caseId }))
  }

  const goToChat = () => {
    router.push(buildDashboardHref(accountId, { ...routeState, section: 'agents' }))
  }

  const goToActivity = () => {
    router.push(buildDashboardHref(accountId, { ...routeState, section: 'activity' }))
  }

  return (
    <DashboardPage
      title="Eval"
      description="Replay past conversations against the current corpus and settings, and verify the assistant behaves how you expect."
    >
      {error ? <p className="mb-4 text-sm text-rose-600">{error}</p> : null}
      {cases === null ? (
        <div className="flex justify-center py-12">
          <LogoSpinner imageClassName="h-6 w-6" />
        </div>
      ) : cases.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No eval cases yet</CardTitle>
            <CardDescription>
              Eval cases come from real conversations. Open a chat or browse activity, hover an assistant
              answer, and click the flask icon to send it here.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={goToChat}>Open chat</Button>
            <Button variant="ghost" onClick={goToActivity}>Browse activity</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {cases.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => openCase(c.id)}
              className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-background p-4 text-left hover:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground">{c.name}</span>
                  <Badge variant="outline" className={statusBadgeClass(c.status)}>{c.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.assertions.length === 0
                    ? 'No assertions configured'
                    : `${c.assertions.length} assertion${c.assertions.length === 1 ? '' : 's'}`}
                  {' · '}updated {formatRelative(c.updatedAt)}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </DashboardPage>
  )
}

interface EvalDetailProps {
  accountId: string
  routeState: DashboardRouteState
  caseId: string
}

function EvalDetail({ accountId, routeState, caseId }: EvalDetailProps) {
  const router = useRouter()
  const [caseWithRuns, setCaseWithRuns] = useState<EvalCaseWithRuns | null>(null)
  const [snapshot, setSnapshot] = useState<EvalSnapshot | null>(null)
  const [docTitlesById, setDocTitlesById] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runMode, setRunMode] = useState<EvalRunMode>('retrieval_only')

  const load = useCallback(async () => {
    try {
      const c = await evalsApi.getCase(caseId)
      setCaseWithRuns(c)
      const snap = await evalsApi.getSnapshot(c.snapshotId)
      setSnapshot(snap)
      setError(null)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Eval request failed'))
    }
  }, [caseId])

  useEffect(() => {
    void load()
  }, [load])

  // Auto-switch to full_assistant when the assertions need it.
  useEffect(() => {
    if (caseWithRuns) {
      setRunMode(inferDefaultMode(caseWithRuns.assertions))
    }
  }, [caseWithRuns])

  // Best-effort: load a page of documents to resolve titles for the assertion editor
  // and run output. Document IDs that aren't in the first page show as id slugs.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await documentsApi.listDocuments({ limit: 100 })
        if (cancelled) return
        const next = new Map<string, string>()
        for (const d of (response.documents ?? []) as DocumentSummary[]) {
          if (d.id && d.title) next.set(d.id, d.title)
        }
        setDocTitlesById(next)
      } catch {
        // Silent: title resolution is non-essential.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const titleFor = useCallback((id: string) => docTitlesById.get(id), [docTitlesById])

  const runAgain = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      await evalsApi.runCase(caseId, { mode: runMode })
      await load()
    } catch (err) {
      setError(getApiErrorMessage(err, 'Eval request failed'))
    } finally {
      setRunning(false)
    }
  }, [caseId, load, runMode])

  const backHref = useMemo(
    () => buildDashboardHref(accountId, { ...routeState, section: 'eval', evalCaseId: undefined }),
    [accountId, routeState],
  )

  if (!caseWithRuns || !snapshot) {
    return (
      <DashboardPage title="Eval case" description="Loading…">
        {error ? (
          <p className="text-sm text-rose-600">{error}</p>
        ) : (
          <div className="flex justify-center py-12">
            <LogoSpinner imageClassName="h-6 w-6" />
          </div>
        )}
      </DashboardPage>
    )
  }

  const latestRun = caseWithRuns.runs[0] ?? null
  const hasAssertions = caseWithRuns.assertions.length > 0

  return (
    <DashboardPage
      title={caseWithRuns.name}
      titleAccessory={
        <Badge variant="outline" className={statusBadgeClass(caseWithRuns.status)}>
          {caseWithRuns.status}
        </Badge>
      }
      description={`Snapshot ${snapshot.id.slice(0, 8)} · fidelity: ${snapshot.fidelity}`}
      actions={
        <>
          <Button variant="ghost" onClick={() => router.push(backHref)}>
            Back
          </Button>
          <div className="flex items-center gap-1 rounded-md border border-border bg-background p-1 text-xs">
            {(['retrieval_only', 'full_assistant'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setRunMode(mode)}
                disabled={running}
                className={`rounded px-2 py-1 transition-colors ${
                  runMode === mode
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {mode === 'retrieval_only' ? 'Retrieval only' : 'Full assistant'}
              </button>
            ))}
          </div>
          <Button onClick={runAgain} disabled={running}>
            {running ? 'Running…' : hasAssertions ? 'Run case' : 'Run (no assertions)'}
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6">
        {error ? <p className="text-sm text-rose-600">{error}</p> : null}

        {/* Assertions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assertions</CardTitle>
            <CardDescription>
              Each run must satisfy all assertions for the case to pass. Editing assertions resets case status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AssertionEditor
              caseId={caseWithRuns.id}
              initial={caseWithRuns.assertions}
              resolveDocumentTitle={titleFor}
              onSaved={(updated) => {
                setCaseWithRuns((prev) => (prev ? { ...prev, ...updated, runs: prev.runs } : prev))
              }}
            />
          </CardContent>
        </Card>

        {/* Latest run */}
        <LatestRunCard
          run={latestRun}
          assertions={caseWithRuns.assertions}
          titleFor={titleFor}
        />

        {/* Conversation */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conversation</CardTitle>
            <CardDescription>
              {snapshot.messages.length} message{snapshot.messages.length === 1 ? '' : 's'} captured from conversation {snapshot.sourceConversationId.slice(0, 8)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {snapshot.messages.map((m) => (
              <div key={m.id} className="rounded-md border border-border bg-background p-3">
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{m.role}</div>
                <div className="whitespace-pre-wrap text-sm text-foreground">{m.content}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Run history */}
        {caseWithRuns.runs.length > 1 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Run history</CardTitle>
              <CardDescription>{caseWithRuns.runs.length} runs</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {caseWithRuns.runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <span className="text-muted-foreground">{formatRelative(r.startedAt)}</span>
                    <Badge variant="outline" className={statusBadgeClass(r.status)}>
                      {r.status}
                    </Badge>
                    {r.outcomeReason ? (
                      <span className="truncate text-xs text-muted-foreground">{r.outcomeReason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </DashboardPage>
  )
}

interface LatestRunCardProps {
  run: EvalRun | null
  assertions: EvalAssertion[]
  titleFor: (id: string) => string | undefined
}

function LatestRunCard({ run, assertions, titleFor }: LatestRunCardProps) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Latest run</CardTitle>
          <CardDescription>
            {assertions.length === 0
              ? 'Add at least one assertion above to grade a run. You can also run without assertions to just capture output.'
              : 'No runs yet — click "Run case" above to execute.'}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Latest run</CardTitle>
        <CardDescription>
          {formatRelative(run.startedAt)} · {run.mode}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={statusBadgeClass(run.status)}>{run.status}</Badge>
          {run.outcomeReason ? (
            <span className="text-sm text-muted-foreground">{run.outcomeReason}</span>
          ) : null}
        </div>

        {run.observedOutput.answer !== undefined ? (
          <div className="space-y-1">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Generated answer
            </h4>
            <div className="whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-sm">
              {run.observedOutput.answer || <span className="text-muted-foreground">(empty)</span>}
            </div>
          </div>
        ) : null}

        {run.assertionVerdicts.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Per-assertion verdicts
            </h4>
            <ul className="space-y-2">
              {run.assertionVerdicts.map((v, i) => (
                <li key={i} className="rounded-md border border-border bg-background p-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 text-sm text-foreground">
                      {assertionSummary(v.assertion, titleFor)}
                    </span>
                    <Badge variant="outline" className={statusBadgeClass(v.status)}>
                      {v.status}
                    </Badge>
                  </div>
                  {v.reason ? (
                    <p className="mt-1 text-xs text-muted-foreground">{v.reason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <ChunksList run={run} verdicts={run.assertionVerdicts} titleFor={titleFor} />
      </CardContent>
    </Card>
  )
}

interface ChunksListProps {
  run: EvalRun
  verdicts: AssertionVerdict[]
  titleFor: (id: string) => string | undefined
}

function ChunksList({ run, verdicts, titleFor }: ChunksListProps) {
  if (run.observedOutput.retrievedChunks.length === 0) {
    return <p className="text-sm text-muted-foreground">No chunks retrieved.</p>
  }

  // Map a documentId → the most informative verdict that references it
  // (fail beats error beats pass for visibility).
  const verdictByDoc = new Map<string, AssertionVerdict>()
  for (const v of verdicts) {
    if (!('documentId' in v.assertion)) continue
    const existing = verdictByDoc.get(v.assertion.documentId)
    if (!existing) {
      verdictByDoc.set(v.assertion.documentId, v)
      continue
    }
    const rank = (s: AssertionVerdictStatus) => (s === 'fail' ? 2 : s === 'error' ? 1 : 0)
    if (rank(v.status) > rank(existing.status)) {
      verdictByDoc.set(v.assertion.documentId, v)
    }
  }

  return (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Retrieved chunks
      </h4>
      <ul className="space-y-1 text-sm">
        {run.observedOutput.retrievedChunks.map((c, index) => {
          const verdict = verdictByDoc.get(c.documentId)
          const className = verdict
            ? verdict.status === 'pass'
              ? 'font-medium text-emerald-700 dark:text-emerald-300'
              : verdict.status === 'fail'
                ? 'font-medium text-rose-700 dark:text-rose-300'
                : 'text-amber-700 dark:text-amber-300'
            : undefined
          const docTitle = c.title || titleFor(c.documentId)
          return (
            <li key={c.chunkId} className={className}>
              <span className="text-muted-foreground">#{index}</span>{' '}
              {docTitle ? (
                <span>{docTitle}</span>
              ) : (
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{c.documentId}</code>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface EvalViewProps {
  accountId: string
  routeState: DashboardRouteState
}

export function EvalView({ accountId, routeState }: EvalViewProps) {
  if (routeState.evalCaseId) {
    return <EvalDetail accountId={accountId} routeState={routeState} caseId={routeState.evalCaseId} />
  }
  return <EvalList accountId={accountId} routeState={routeState} />
}
