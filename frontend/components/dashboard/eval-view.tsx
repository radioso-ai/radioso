'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogoSpinner } from '@/components/ui/spinner'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
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

  const howToHint = (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
      <span className="text-foreground">New eval cases come from real conversations.</span>{' '}
      Open a <button type="button" onClick={goToChat} className="underline underline-offset-2 hover:text-foreground">chat</button>{' '}
      or browse <button type="button" onClick={goToActivity} className="underline underline-offset-2 hover:text-foreground">activity</button>,
      hover an assistant answer, and click the flask icon to capture it here.
    </div>
  )

  return (
    <DashboardPage
      title="Eval"
      description="Replay past conversations against the current corpus and settings, and verify the assistant behaves how you expect."
      headerContent={howToHint}
    >
      {error ? <p className="mb-4 text-sm text-rose-600">{error}</p> : null}
      {cases === null ? (
        <div className="flex justify-center py-12">
          <LogoSpinner imageClassName="h-6 w-6" />
        </div>
      ) : cases.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          No eval cases yet. Capture one from chat or activity using the steps above.
        </div>
      ) : (
        <DashboardTable aria-label="Eval cases" minWidth="min-w-[640px]">
          <DashboardTableHead>
            <DashboardTableHeader>Case</DashboardTableHeader>
            <DashboardTableHeader className="w-32">Status</DashboardTableHeader>
            <DashboardTableHeader className="w-40">Expectations</DashboardTableHeader>
            <DashboardTableHeader className="w-44">Updated</DashboardTableHeader>
          </DashboardTableHead>
          <DashboardTableBody>
            {cases.map((c) => (
              <DashboardTableRow
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => openCase(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openCase(c.id)
                  }
                }}
                className="cursor-pointer"
              >
                <DashboardTableCell>
                  <span className="block truncate font-medium text-foreground">{c.name}</span>
                </DashboardTableCell>
                <DashboardTableCell className="w-32">
                  <Badge variant="outline" className={statusBadgeClass(c.status)}>{c.status}</Badge>
                </DashboardTableCell>
                <DashboardTableCell className="w-40 text-muted-foreground">
                  {c.assertions.length === 0
                    ? 'None'
                    : `${c.assertions.length} expectation${c.assertions.length === 1 ? '' : 's'}`}
                </DashboardTableCell>
                <DashboardTableCell className="w-44 text-muted-foreground">
                  {formatRelative(c.updatedAt)}
                </DashboardTableCell>
              </DashboardTableRow>
            ))}
          </DashboardTableBody>
        </DashboardTable>
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

  // Best-effort: load a page of documents to resolve titles for the expectation
  // editor and run output. IDs not in the first page show as id slugs.
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

  // Auto-pick the run mode from the expectations: any answer/judge expectation
  // needs full_assistant; otherwise retrieval_only is enough and avoids an LLM call.
  const runAgain = useCallback(async () => {
    if (!caseWithRuns) return
    const mode: EvalRunMode = inferDefaultMode(caseWithRuns.assertions)
    setRunning(true)
    setError(null)
    try {
      await evalsApi.runCase(caseId, { mode })
      await load()
    } catch (err) {
      setError(getApiErrorMessage(err, 'Eval request failed'))
    } finally {
      setRunning(false)
    }
  }, [caseId, caseWithRuns, load])

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
  const originalAnswer = [...snapshot.messages].reverse().find((m) => m.role === 'assistant')?.content ?? null

  return (
    <DashboardPage
      title={caseWithRuns.name}
      description={`Captured ${formatRelative(snapshot.capturedAt)}`}
      headerContent={
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className={statusBadgeClass(caseWithRuns.status)}>
            {caseWithRuns.status}
          </Badge>
          <span>·</span>
          <span>
            {caseWithRuns.assertions.length === 0
              ? 'No expectations configured'
              : `${caseWithRuns.assertions.length} expectation${caseWithRuns.assertions.length === 1 ? '' : 's'}`}
          </span>
        </div>
      }
      actions={
        <>
          <Button variant="ghost" onClick={() => router.push(backHref)}>
            Back
          </Button>
          <Button onClick={runAgain} disabled={running}>
            {running ? 'Running…' : 'Run case'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {error ? <p className="text-sm text-rose-600">{error}</p> : null}

        {/* Conversation */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conversation</CardTitle>
            <CardDescription>
              {snapshot.messages.length} message{snapshot.messages.length === 1 ? '' : 's'} captured from this turn
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {snapshot.messages.map((m) => (
              <div key={m.id} className="flex gap-3 text-sm">
                <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
                  {m.role}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">{m.content}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Latest run */}
        <LatestRunCard
          run={latestRun}
          assertions={caseWithRuns.assertions}
          originalAnswer={originalAnswer}
          titleFor={titleFor}
        />

        {/* Expectations */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expectations</CardTitle>
            <CardDescription>
              Each run must satisfy every expectation for the case to pass. Editing expectations resets the case status.
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
  originalAnswer: string | null
  titleFor: (id: string) => string | undefined
}

function LatestRunCard({ run, assertions, originalAnswer, titleFor }: LatestRunCardProps) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Latest run</CardTitle>
          <CardDescription>
            {assertions.length === 0
              ? 'Add at least one expectation below to grade a run. You can also run without expectations to just capture output.'
              : 'No runs yet — click "Run case" above to execute.'}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }
  const newAnswer = run.observedOutput.answer
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Latest run</CardTitle>
        <CardDescription>{formatRelative(run.startedAt)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={statusBadgeClass(run.status)}>{run.status}</Badge>
          {run.outcomeReason ? (
            <span className="text-sm text-muted-foreground">{run.outcomeReason}</span>
          ) : null}
        </div>

        {newAnswer !== undefined ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Original answer
              </h4>
              <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm">
                {originalAnswer || <span className="text-muted-foreground">(not captured)</span>}
              </div>
            </div>
            <div className="space-y-1.5">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                New answer
              </h4>
              <div className="whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-sm">
                {newAnswer || <span className="text-muted-foreground">(empty)</span>}
              </div>
            </div>
          </div>
        ) : null}

        {run.assertionVerdicts.length > 0 ? (
          <div className="-mx-6 divide-y divide-border border-y border-border">
            {run.assertionVerdicts.map((v, i) => (
              <div key={i} className="flex items-start justify-between gap-3 px-6 py-3 text-sm">
                <div className="min-w-0">
                  <div className="text-foreground">{assertionSummary(v.assertion, titleFor)}</div>
                  {v.reason ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{v.reason}</p>
                  ) : null}
                </div>
                <Badge variant="outline" className={statusBadgeClass(v.status)}>
                  {v.status}
                </Badge>
              </div>
            ))}
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
