'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight } from 'lucide-react'

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
import { ChatMessageThread, type ChatThreadMessage } from './chat-message-thread'
import type { CitationOpenResult } from './chat-citations'
import { MarkdownContent } from '@/components/markdown/markdown-content'
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
  EvalRunModelOverride,
  EvalRunStatus,
  EvalSnapshot,
} from '@/lib/api-eval'
import { llmProvidersApi, type KnownModelsByProvider, type LlmProviderName } from '@/lib/api-llm-providers'
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

const noopOpenDocument = async (): Promise<CitationOpenResult> => 'unavailable'

// Map a frozen snapshot message to the shape ChatMessageThread expects so the
// eval detail page can reuse the same bubble + markdown renderer the dashboard
// chat uses. Snapshots don't carry citations / suggestions / feedback per
// message yet, so those slots stay empty and ChatMessageThread degrades to
// plain bubbles + markdown — which is exactly what we want here.
const toThreadMessages = (
  messages: EvalSnapshot['messages'],
): ChatThreadMessage[] => messages.map((m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  createdAt: m.createdAt,
}))

const formatRunModel = (run: { resolvedConfig: Record<string, unknown> }): string | null => {
  const config = run.resolvedConfig as { modelProvider?: string; modelId?: string }
  if (!config.modelId) return null
  return config.modelProvider ? `${config.modelProvider}/${config.modelId}` : config.modelId
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

interface ModelOption {
  provider: LlmProviderName
  model: string
}

const WORKSPACE_DEFAULT_MODEL_VALUE = '__workspace_default__'
const encodeModelValue = (m: EvalRunModelOverride) => `${m.provider}::${m.model}`
const decodeModelValue = (value: string): EvalRunModelOverride | null => {
  if (value === WORKSPACE_DEFAULT_MODEL_VALUE) return null
  const sep = value.indexOf('::')
  if (sep === -1) return null
  return {
    provider: value.slice(0, sep) as LlmProviderName,
    model: value.slice(sep + 2),
  }
}

function EvalDetail({ accountId, routeState, caseId }: EvalDetailProps) {
  const router = useRouter()
  const [caseWithRuns, setCaseWithRuns] = useState<EvalCaseWithRuns | null>(null)
  const [snapshot, setSnapshot] = useState<EvalSnapshot | null>(null)
  const [docTitlesById, setDocTitlesById] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [modelOverride, setModelOverride] = useState<EvalRunModelOverride | null>(null)
  const [workspaceChatModel, setWorkspaceChatModel] = useState<{ provider: LlmProviderName; model: string } | null>(null)
  const [knownModels, setKnownModels] = useState<KnownModelsByProvider | null>(null)
  // null means "haven't looked yet OR the credentials lookup wasn't available
  // (likely 403)" — in that case the picker falls back to showing every known
  // provider rather than starving. When a non-null Set is present we strictly
  // filter to credentialed/env-configured providers.
  const [availableProviders, setAvailableProviders] = useState<Set<LlmProviderName> | null>(null)

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

  // Pull workspace chat model + known models + credential availability for
  // the Advanced model picker.
  //
  // Availability is a soft filter, not a hard one: if listCredentials fails
  // or returns no signal we fall back to showing every known provider, so a
  // permission gap on /settings/credentials doesn't starve the picker. The
  // run still resolves the capability at call time, so an unreachable model
  // would error there with a clear message rather than silently disappear
  // from the dropdown.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [models, credentials] = await Promise.all([
          llmProvidersApi.getModels(),
          llmProvidersApi.listCredentials().catch(() => null),
        ])
        if (cancelled) return
        setKnownModels(models.knownModelsByProvider)
        if (models.chat) {
          setWorkspaceChatModel({
            provider: models.chat.provider as LlmProviderName,
            model: models.chat.model,
          })
        }

        if (!credentials) {
          // No availability info — let everything through and let the run
          // surface the real error if the picked provider is unreachable.
          setAvailableProviders(null)
          return
        }

        const available = new Set<LlmProviderName>()
        for (const cred of credentials.credentials) {
          available.add(cred.provider)
        }
        for (const [provider, hasEnv] of Object.entries(credentials.envProviderAvailability)) {
          if (hasEnv) available.add(provider as LlmProviderName)
        }
        // Always include the workspace's configured chat provider — if a run
        // is hitting it today, eval should be able to too.
        if (models.chat) {
          available.add(models.chat.provider as LlmProviderName)
        }
        // If the credentials lookup came back fully empty, surface every
        // known provider rather than offering nothing. This handles the
        // case where the operator can read settings but creds returned no
        // entries (unusual but observed).
        setAvailableProviders(available.size > 0 ? available : null)
      } catch {
        // Operator can still run; they just can't pick a different model.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-pick the run mode from the expectations: any answer/judge expectation
  // needs full_assistant; otherwise retrieval_only is enough and avoids an LLM call.
  const runAgain = useCallback(async () => {
    if (!caseWithRuns) return
    const mode: EvalRunMode = inferDefaultMode(caseWithRuns.assertions)
    setRunning(true)
    setError(null)
    try {
      await evalsApi.runCase(caseId, {
        mode,
        overrides: modelOverride ? { modelOverride } : undefined,
      })
      await load()
    } catch (err) {
      setError(getApiErrorMessage(err, 'Eval request failed'))
    } finally {
      setRunning(false)
    }
  }, [caseId, caseWithRuns, load, modelOverride])

  const backHref = useMemo(
    () => buildDashboardHref(accountId, { ...routeState, section: 'eval', evalCaseId: undefined }),
    [accountId, routeState],
  )

  // Computed BEFORE the loading early return — must run on every render to
  // keep hook ordering stable.
  // When availableProviders is a Set we filter to providers the workspace
  // can actually call (credentialed or env-configured). When it's null we
  // couldn't determine availability and surface every known provider rather
  // than starving the picker; an unreachable pick will surface a clear
  // error at run time instead. 'openai-compatible' is intentionally omitted
  // because it serves arbitrary self-hosted model ids that aren't
  // enumerable and would need a free-form input.
  const modelOptions: ModelOption[] = useMemo(() => {
    if (!knownModels) return []
    const out: ModelOption[] = []
    for (const [provider, models] of Object.entries(knownModels)) {
      const providerName = provider as LlmProviderName
      if (providerName === 'openai-compatible') continue
      if (availableProviders && !availableProviders.has(providerName)) continue
      for (const model of models) {
        out.push({ provider: providerName, model })
      }
    }
    return out
  }, [availableProviders, knownModels])

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

  // When a run exists with an answer, the original assistant answer is the
  // left-hand side of the Latest run diff — no need to repeat it in the
  // conversation card. Drop the trailing assistant turn (and only that) so
  // the conversation reads "what the user asked + any prior context" and the
  // diff card owns the answer being graded.
  const hasRunWithAnswer = latestRun?.observedOutput.answer !== undefined
  const conversationMessages = (() => {
    if (!hasRunWithAnswer || snapshot.messages.length === 0) return snapshot.messages
    const last = snapshot.messages[snapshot.messages.length - 1]
    return last?.role === 'assistant' ? snapshot.messages.slice(0, -1) : snapshot.messages
  })()

  return (
    <DashboardPage
      title={caseWithRuns.name}
      description={`Captured ${formatRelative(snapshot.capturedAt)}`}
      headerContent={
        <div className="space-y-2">
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
            {modelOverride ? (
              <>
                <span>·</span>
                <span>Next run uses {modelOverride.provider}/{modelOverride.model}</span>
              </>
            ) : null}
          </div>
          <details
            className="group rounded-md border border-border bg-background/50"
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
              Advanced
            </summary>
            <div className="space-y-3 border-t border-border px-3 py-3">
              <div className="space-y-1.5">
                <label htmlFor="eval-model-select" className="block text-xs font-medium text-foreground">
                  Model for this run
                </label>
                <select
                  id="eval-model-select"
                  className="w-full max-w-md rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  value={modelOverride ? encodeModelValue(modelOverride) : WORKSPACE_DEFAULT_MODEL_VALUE}
                  onChange={(e) => setModelOverride(decodeModelValue(e.target.value))}
                  disabled={running}
                >
                  <option value={WORKSPACE_DEFAULT_MODEL_VALUE}>
                    Workspace default{workspaceChatModel ? ` (${workspaceChatModel.provider}/${workspaceChatModel.model})` : ''}
                  </option>
                  {modelOptions.map((o) => (
                    <option key={`${o.provider}::${o.model}`} value={encodeModelValue(o)}>
                      {o.provider} / {o.model}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  One-shot override for the next run. Doesn't change the workspace's chat model. The judge always uses the workspace default.
                </p>
              </div>
            </div>
          </details>
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
              {conversationMessages.length} message{conversationMessages.length === 1 ? '' : 's'} captured from this turn
              {hasRunWithAnswer ? ' — original answer shown in the latest-run diff below' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChatMessageThread
              messages={toThreadMessages(conversationMessages)}
              onOpenDocument={noopOpenDocument}
              showCitations={false}
            />
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
          <RunHistoryCard
            runs={caseWithRuns.runs.slice(1)}
            originalAnswer={originalAnswer}
            titleFor={titleFor}
          />
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Latest run</CardTitle>
        <CardDescription>
          {formatRelative(run.startedAt)}
          {formatRunModel(run) ? ` · ${formatRunModel(run)}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RunOutputDetail run={run} originalAnswer={originalAnswer} titleFor={titleFor} />
      </CardContent>
    </Card>
  )
}

interface RunOutputDetailProps {
  run: EvalRun
  originalAnswer: string | null
  titleFor: (id: string) => string | undefined
  /** When true, omits the top status row (caller renders its own). */
  hideStatus?: boolean
}

function RunOutputDetail({ run, originalAnswer, titleFor, hideStatus = false }: RunOutputDetailProps) {
  const newAnswer = run.observedOutput.answer
  return (
    <div className="space-y-5">
      {hideStatus ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={statusBadgeClass(run.status)}>{run.status}</Badge>
          {run.outcomeReason ? (
            <span className="text-sm text-muted-foreground">{run.outcomeReason}</span>
          ) : null}
        </div>
      )}

      {newAnswer !== undefined ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Original answer
            </h4>
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              {originalAnswer ? (
                <MarkdownContent content={originalAnswer} variant="chat" />
              ) : (
                <span className="text-muted-foreground">(not captured)</span>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              New answer
            </h4>
            <div className="rounded-md border border-border bg-background p-3 text-sm">
              {newAnswer ? (
                <MarkdownContent content={newAnswer} variant="chat" />
              ) : (
                <span className="text-muted-foreground">(empty)</span>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {run.assertionVerdicts.length > 0 ? (
        <div className="divide-y divide-border border-y border-border">
          {run.assertionVerdicts.map((v, i) => (
            <div key={i} className="flex items-start justify-between gap-3 py-3 text-sm">
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
    </div>
  )
}

interface RunHistoryCardProps {
  runs: EvalRun[]
  originalAnswer: string | null
  titleFor: (id: string) => string | undefined
}

function RunHistoryCard({ runs, originalAnswer, titleFor }: RunHistoryCardProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Run history</CardTitle>
        <CardDescription>
          {runs.length} earlier run{runs.length === 1 ? '' : 's'} — click a row to see its answer, verdicts, and retrieved chunks.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border border-t border-border">
          {runs.map((r) => {
            const isExpanded = expandedId === r.id
            const Chevron = isExpanded ? ChevronDown : ChevronRight
            return (
              <Fragment key={r.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : r.id)}
                  className="flex w-full items-center gap-3 px-6 py-3 text-left text-sm transition-colors hover:bg-accent/40"
                  aria-expanded={isExpanded}
                >
                  <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="w-44 shrink-0 text-muted-foreground">{formatRelative(r.startedAt)}</span>
                  <Badge variant="outline" className={statusBadgeClass(r.status)}>{r.status}</Badge>
                  {formatRunModel(r) ? (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {formatRunModel(r)}
                    </span>
                  ) : null}
                  {r.outcomeReason ? (
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{r.outcomeReason}</span>
                  ) : null}
                </button>
                {isExpanded ? (
                  <div className="border-t border-border bg-muted/10 px-6 py-4">
                    <RunOutputDetail
                      run={r}
                      originalAnswer={originalAnswer}
                      titleFor={titleFor}
                      hideStatus
                    />
                  </div>
                ) : null}
              </Fragment>
            )
          })}
        </div>
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
