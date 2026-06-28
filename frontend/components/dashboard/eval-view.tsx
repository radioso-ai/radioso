'use client'

import { Fragment, useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Bug, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Minimize2, Play, RefreshCw, Trash2, Workflow, XCircle } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import { ActivityTraceDetail } from './activity-trace-detail'
import { ChatMessageThread, type ChatThreadMessage } from './chat-message-thread'
import { AssistantMessageContent, type CitationOpenResult } from './chat-citations'
import { AssertionEditor } from './eval/assertion-editor'
import { TrainingView } from './workbench/training-view'
import { WorkbenchOverridePanel } from './workbench/workbench-override-panel'
import {
  buildWorkbenchBaseline,
  createWorkbenchOverrideState,
  workbenchOverrideReducer,
  type WorkbenchOverrideState,
  type WorkbenchOverrideValues,
  type WorkbenchSeedTurn,
} from './workbench/use-workbench-state'
import { evalsApi, documentsApi, agentsApi, directivesApi, type AgentSettings, type ChatConversationDetail, type ChatConversationTurn, type Directive } from '@/lib/api'
import type {
  AssertionVerdictStatus,
  AgentConfigOverrideInput,
  EvalAssertion,
  EvalCase,
  EvalCaseListItem,
  EvalCaseStatus,
  EvalCaseWithRuns,
  EvalRun,
  EvalRunStatus,
  EvalSnapshot,
  EvalSuiteSummary,
  WorkbenchReplayRunResponse,
} from '@/lib/api-eval'
import type { DocumentSummary } from '@/lib/api-types'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  type DiagnosticPresentation,
  presentActivityOutcome,
  presentRunParameters,
} from '@/lib/activity-diagnostics'
import type { ConversationTraceStage } from '@/lib/api-types'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useSkillCatalog } from '@/lib/skill-catalog'
import { activityTraceToFlowGraph, envelopeToFlowGraph, type TurnFlowNode } from '@/lib/turn-flow'
import { getPrimaryLeafTrace } from '@/lib/turn-trace'
import { RETRIEVAL_ANSWER_SKILL_NAME } from '@/lib/retrieval-skill-settings'
import { TurnFlowGraph } from './turn-flow-graph'

type AnyStatus = EvalCaseStatus | EvalRunStatus | AssertionVerdictStatus

const diagnosticToneStyles: Record<DiagnosticPresentation['tone'], string> = {
  neutral: 'border-border/70 bg-background/60',
  ok: 'border-emerald-500/30 bg-emerald-500/10',
  warning: 'border-amber-500/30 bg-amber-500/10',
  error: 'border-destructive/30 bg-destructive/10',
}

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

// Verdict reasons reference the target document by its stable id. Resolve that
// id to the human document title for display so the panel never surfaces raw
// UUIDs. Falls back to the original reason when the title is not yet loaded.
const humanizeVerdictReason = (
  verdict: { assertion: EvalAssertion; reason: string | null },
  titleFor: (id: string) => string | undefined,
): string | null => {
  const reason = verdict.reason
  if (!reason) return reason
  const documentId = 'documentId' in verdict.assertion ? verdict.assertion.documentId : null
  if (!documentId) return reason
  const title = titleFor(documentId)
  return title ? reason.split(documentId).join(title) : reason
}

// Map a frozen snapshot message to the shape ChatMessageThread expects so the
// eval detail page can reuse the same bubble + markdown renderer the dashboard
// chat uses. Newer snapshots also preserve assistant citation artifacts so
// eval citations render with the same inline markers and sources rail as chat.
const toThreadMessages = (
  messages: EvalSnapshot['messages'],
): ChatThreadMessage[] => messages.map((m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  createdAt: m.createdAt,
  citations: m.citations,
  answerSegments: m.answerSegments,
}))

const snapshotMessageToTurn = (
  snapshot: EvalSnapshot,
  message: EvalSnapshot['messages'][number],
): ChatConversationTurn => ({
  id: message.id,
  role: message.role,
  source: message.role === 'assistant' ? 'ai_agent' : message.role === 'user' ? 'customer' : 'system',
  content: message.content,
  createdAt: message.createdAt,
  citations: message.citations,
  answerSegments: message.answerSegments,
} as ChatConversationTurn)

const buildSnapshotConversation = (snapshot: EvalSnapshot): ChatConversationDetail => ({
  conversationId: snapshot.sourceConversationId,
  workspaceId: snapshot.workspaceId,
  agentId: snapshot.sourceAgentId,
  sourceChannel: null,
  sourceOrigin: null,
  channelContext: null,
  createdAt: snapshot.capturedAt,
  updatedAt: snapshot.capturedAt,
  messageCount: snapshot.messages.length,
  userMessageCount: snapshot.messages.filter((message) => message.role === 'user').length,
  assistantMessageCount: snapshot.messages.filter((message) => message.role === 'assistant').length,
  messagesTotal: snapshot.messages.length,
  messageWindowOffset: 0,
  messageWindowLimit: snapshot.messages.length,
  hasOlderMessages: false,
  nextCursor: null,
  tailCursor: null,
  messages: snapshot.messages.map((message) => snapshotMessageToTurn(snapshot, message)),
} as ChatConversationDetail)

const buildEvalSeedTurn = (snapshot: EvalSnapshot): WorkbenchSeedTurn | null => {
  const conversation = buildSnapshotConversation(snapshot)
  const messages = conversation.messages
  if (messages.length === 0) return null

  const selectedIndex = snapshot.sourceMessageId
    ? messages.findIndex((message) => message.id === snapshot.sourceMessageId)
    : -1
  const assistantIndex = selectedIndex >= 0 && messages[selectedIndex]?.role === 'assistant'
    ? selectedIndex
    : (() => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'assistant') return index
      }
      return -1
    })()

  const assistantTurn = assistantIndex >= 0 ? messages[assistantIndex] : null
  const userSearchStart = assistantIndex >= 0 ? assistantIndex - 1 : messages.length - 1
  for (let index = userSearchStart; index >= 0; index -= 1) {
    const turn = messages[index]
    if (turn?.role === 'user') {
      return { conversation, userTurn: turn, assistantTurn }
    }
  }

  const firstUser = messages.find((message) => message.role === 'user')
  return firstUser ? { conversation, userTurn: firstUser, assistantTurn } : null
}

const emptyReplayBaseline: WorkbenchOverrideValues = {
  chatModelOverride: null,
  customInstruction: '',
  retrievalSkillSettings: {},
  authoredDirectives: [],
}

const asDirectiveOverride = (
  directive: Record<string, unknown>,
): WorkbenchOverrideValues['authoredDirectives'][number] => ({
  name: typeof directive.name === 'string' ? directive.name : 'Directive',
  condition: (directive.condition ?? {}) as WorkbenchOverrideValues['authoredDirectives'][number]['condition'],
  action: typeof directive.action === 'string' ? directive.action : '',
  priority: typeof directive.priority === 'number' ? directive.priority : null,
  requiredCapabilities: Array.isArray(directive.requiredCapabilities) ? directive.requiredCapabilities.filter((value): value is string => typeof value === 'string') : [],
  dependsOn: Array.isArray(directive.dependsOn) ? directive.dependsOn.filter((value): value is string => typeof value === 'string') : [],
  excludes: Array.isArray(directive.excludes) ? directive.excludes.filter((value): value is string => typeof value === 'string') : [],
  routes: Array.isArray(directive.routes) ? directive.routes as WorkbenchOverrideValues['authoredDirectives'][number]['routes'] : [],
  tags: Array.isArray(directive.tags) ? directive.tags.filter((value): value is string => typeof value === 'string') : [],
  description: typeof directive.description === 'string' ? directive.description : null,
  metadata: directive.metadata && typeof directive.metadata === 'object' && !Array.isArray(directive.metadata)
    ? directive.metadata as Record<string, unknown>
    : {},
})

const buildSnapshotReplayBaseline = (snapshot: EvalSnapshot | null): WorkbenchOverrideValues => {
  const config = snapshot?.originalAgentConfig
  if (!config) return emptyReplayBaseline
  return {
    chatModelOverride: config.chatModelOverride ?? null,
    customInstruction: config.customInstruction ?? '',
    retrievalSkillSettings: (
      config.skillSettings?.[RETRIEVAL_ANSWER_SKILL_NAME] &&
      typeof config.skillSettings[RETRIEVAL_ANSWER_SKILL_NAME] === 'object' &&
      !Array.isArray(config.skillSettings[RETRIEVAL_ANSWER_SKILL_NAME])
    )
      ? { ...config.skillSettings[RETRIEVAL_ANSWER_SKILL_NAME] }
      : {},
    authoredDirectives: Array.isArray(config.authoredDirectives)
      ? config.authoredDirectives.map((directive) => asDirectiveOverride(directive as unknown as Record<string, unknown>))
      : [],
  }
}

const buildEffectiveAgentConfigOverride = (
  baseline: WorkbenchOverrideValues,
  state: WorkbenchOverrideState,
): AgentConfigOverrideInput => {
  const retrievalSkillSettings = state.touched.retrievalSkillSettings
    ? { ...baseline.retrievalSkillSettings, ...state.values.retrievalSkillSettings }
    : baseline.retrievalSkillSettings

  return {
    chatModelOverride: state.touched.chatModelOverride
      ? state.values.chatModelOverride
      : baseline.chatModelOverride,
    customInstruction: state.touched.customInstruction
      ? state.values.customInstruction
      : baseline.customInstruction,
    skillSettings: {
      [RETRIEVAL_ANSWER_SKILL_NAME]: retrievalSkillSettings,
    },
    authoredDirectives: state.touched.authoredDirectives
      ? state.values.authoredDirectives
      : baseline.authoredDirectives,
  }
}

const snapshotAgentToSettings = (snapshot: EvalSnapshot): AgentSettings | null => {
  const config = snapshot.originalAgentConfig
  if (!config || !snapshot.sourceAgentId) return null
  return {
    id: snapshot.sourceAgentId,
    workspaceId: snapshot.workspaceId,
    name: typeof config.name === 'string' ? config.name : 'Captured agent',
    customInstruction: config.customInstruction ?? '',
    chatModelOverride: config.chatModelOverride ?? null,
    skillSettings: config.skillSettings ?? {},
    authoredDirectives: config.authoredDirectives ?? [],
    createdAt: snapshot.capturedAt,
    updatedAt: snapshot.capturedAt,
    assistantLinkUtmEnabled: false,
  } as unknown as AgentSettings
}

const formatRunModel = (run: { resolvedConfig: Record<string, unknown> }): string | null => {
  const config = run.resolvedConfig as { modelProvider?: string; modelId?: string }
  if (!config.modelId) return null
  return config.modelProvider ? `${config.modelProvider}/${config.modelId}` : config.modelId
}

function DiagnosticPresentationSection({
  label,
  presentation,
}: {
  label: string
  presentation: DiagnosticPresentation
}) {
  return (
    <section className={`rounded-lg border p-3 ${diagnosticToneStyles[presentation.tone]}`}>
      <p className="text-[11px] font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-medium text-foreground">{presentation.title}</p>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{presentation.summary}</p>
      {presentation.facts.length ? (
        <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {presentation.facts.map((fact) => (
            <div key={`${label}-${fact.label}`} className="min-w-0">
              <dt className="text-[11px] font-medium uppercase text-muted-foreground">{fact.label}</dt>
              <dd className="mt-0.5 break-words text-sm text-foreground">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}

const presentEvalRunOutcome = (run: EvalRun, activityTrace: EvalRun['observedOutput']['activityTrace']): DiagnosticPresentation => {
  if (activityTrace) {
    return presentActivityOutcome({ trace: activityTrace })
  }

  const retrievedCount = run.observedOutput.retrievedChunks.length
  if (retrievedCount > 0) {
    return {
      title: 'Answered from workspace documents',
      summary: `The eval run retrieved ${retrievedCount} passage${retrievedCount === 1 ? '' : 's'} from workspace documents.`,
      facts: [
        { label: 'Route', value: 'Used workspace documents' },
        { label: 'Selected passages', value: String(retrievedCount) },
      ],
      tone: 'ok',
    }
  }

  return presentActivityOutcome({})
}

type EvalBannerTone = 'pass' | 'fail' | 'error' | 'stale' | 'neutral'

const evalBannerToneClass: Record<EvalBannerTone, string> = {
  pass: 'border-emerald-500/30 bg-emerald-500/10',
  fail: 'border-rose-500/30 bg-rose-500/10',
  error: 'border-amber-500/30 bg-amber-500/10',
  stale: 'border-amber-500/30 bg-amber-500/10',
  neutral: 'border-border bg-muted/30',
}

const evalBannerIcon: Record<EvalBannerTone, { Icon: typeof CheckCircle2; className: string }> = {
  pass: { Icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400' },
  fail: { Icon: XCircle, className: 'text-rose-600 dark:text-rose-400' },
  error: { Icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-400' },
  stale: { Icon: RefreshCw, className: 'text-amber-600 dark:text-amber-400' },
  neutral: { Icon: CircleDashed, className: 'text-muted-foreground' },
}

const pluralExpectations = (n: number): string => `${n} expectation${n === 1 ? '' : 's'}`

// Reduce the case status and its latest run into the single headline a reviewer
// most wants: did this case pass right now, and how many expectations held.
const deriveEvalBanner = (
  caseStatus: EvalCaseStatus,
  latestRun: EvalRun | null,
): { tone: EvalBannerTone; title: string; subtitle: string } => {
  if (!latestRun) {
    return {
      tone: 'neutral',
      title: 'Not run yet',
      subtitle: 'Run the case to evaluate it against your expectations.',
    }
  }

  const verdicts = latestRun.assertionVerdicts
  const total = verdicts.length
  if (total === 0) {
    return {
      tone: 'neutral',
      title: 'Run recorded',
      subtitle: 'Add an expectation to start scoring this case.',
    }
  }

  // Editing expectations resets the case to pending, so a pending case that
  // already has a run is showing stale verdicts against the new expectations.
  if (caseStatus === 'pending') {
    return {
      tone: 'stale',
      title: 'Expectations changed since the last run',
      subtitle: 'Re-run the case to score it against the current expectations.',
    }
  }

  const notMet = verdicts.filter((v) => v.status !== 'pass').length
  switch (caseStatus) {
    case 'passing':
      return {
        tone: 'pass',
        title: 'Passing',
        subtitle: `All ${pluralExpectations(total)} met.`,
      }
    case 'failing':
      return {
        tone: 'fail',
        title: 'Failing',
        subtitle: `${notMet} of ${pluralExpectations(total)} not met.`,
      }
    case 'error':
      return {
        tone: 'error',
        title: 'Run error',
        subtitle: latestRun.outcomeReason ?? 'The case could not be evaluated.',
      }
    default:
      return {
        tone: 'neutral',
        title: 'Recorded',
        subtitle: `${pluralExpectations(total)} checked.`,
      }
  }
}

function EvalResultBanner({
  caseStatus,
  latestRun,
}: {
  caseStatus: EvalCaseStatus
  latestRun: EvalRun | null
}) {
  const banner = deriveEvalBanner(caseStatus, latestRun)
  const { Icon, className } = evalBannerIcon[banner.tone]
  const meta = latestRun
    ? `Last run ${formatRelative(latestRun.completedAt ?? latestRun.startedAt)}${formatRunModel(latestRun) ? ` · ${formatRunModel(latestRun)}` : ''}`
    : null

  return (
    <section
      aria-live="polite"
      className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-1 rounded-xl border p-4 ${evalBannerToneClass[banner.tone]}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${className}`} aria-hidden />
        <div className="min-w-0">
          <p className="text-base font-semibold text-foreground">{banner.title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{banner.subtitle}</p>
        </div>
      </div>
      {meta ? <span className="shrink-0 text-xs text-muted-foreground">{meta}</span> : null}
    </section>
  )
}

interface EvalListProps {
  accountId: string
  routeState: DashboardRouteState
}

function EvalList({ accountId, routeState }: EvalListProps) {
  const router = useRouter()
  const [cases, setCases] = useState<EvalCaseListItem[] | null>(null)
  const [summary, setSummary] = useState<EvalSuiteSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<EvalCase | null>(null)
  const [deletingCaseId, setDeletingCaseId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const loadCases = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const response = await evalsApi.listCases()
      if (signal?.cancelled) return
      setCases(response.cases)
      setSummary(response.summary)
      setError(null)
    } catch (err) {
      if (signal?.cancelled) return
      setError(getApiErrorMessage(err, 'Eval request failed'))
      setCases([])
      setSummary(null)
    }
  }, [])

  useEffect(() => {
    const signal = { cancelled: false }
    void (async () => {
      await loadCases(signal)
    })()
    return () => {
      signal.cancelled = true
    }
  }, [loadCases])

  const runAll = useCallback(async () => {
    setRunning(true)
    setRunError(null)
    try {
      const result = await evalsApi.runAll()
      // Refresh the rows (last-run column) from persisted state, then keep the
      // run's summary as the headline. The GET summary is derived from persisted
      // case status, which does not capture a case that errored before a run was
      // recorded (a missing/broken snapshot) — letting it win here would silently
      // flip such a case back to passing in the pass rate.
      await loadCases()
      setSummary(result.summary)
    } catch (err) {
      setRunError(getApiErrorMessage(err, 'Failed to run eval suite'))
    } finally {
      setRunning(false)
    }
  }, [loadCases])

  const openCase = (caseId: string) => {
    router.push(buildDashboardHref(accountId, { ...routeState, section: 'eval', evalCaseId: caseId }))
  }

  const goToChat = () => {
    router.push(buildDashboardHref(accountId, { ...routeState, section: 'agents' }))
  }

  const goToActivity = () => {
    router.push(buildDashboardHref(accountId, { ...routeState, section: 'activity' }))
  }

  const deleteCase = useCallback(async () => {
    if (!deleteCandidate) return
    setDeletingCaseId(deleteCandidate.id)
    setDeleteError(null)
    try {
      await evalsApi.deleteCase(deleteCandidate.id)
      setCases((prev) => prev?.filter((c) => c.id !== deleteCandidate.id) ?? prev)
      setDeleteCandidate(null)
    } catch (err) {
      setDeleteError(getApiErrorMessage(err, 'Failed to delete eval case'))
    } finally {
      setDeletingCaseId(null)
    }
  }, [deleteCandidate])

  const howToHint = (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
      <span className="text-foreground">New eval cases come from real conversations.</span>{' '}
      Open a <button type="button" onClick={goToChat} className="underline underline-offset-2 hover:text-foreground">chat</button>{' '}
      or browse <button type="button" onClick={goToActivity} className="underline underline-offset-2 hover:text-foreground">activity</button>,
      hover an assistant answer, and click the flask icon to capture it here.
    </div>
  )

  const passRateText = summary
    ? summary.scored === 0
      ? 'No scored cases yet'
      : `${summary.passing} of ${summary.scored} ${summary.scored === 1 ? 'case' : 'cases'} passing`
    : ''
  const passRateDetailParts: string[] = []
  if (summary) {
    if (summary.failing) passRateDetailParts.push(`${summary.failing} failing`)
    if (summary.error) passRateDetailParts.push(`${summary.error} error`)
    if (summary.pending) passRateDetailParts.push(`${summary.pending} not run`)
    if (summary.unscored) passRateDetailParts.push(`${summary.unscored} without expectations`)
  }
  const passRateDetail = passRateDetailParts.join(' · ')
  const hasCases = cases !== null && cases.length > 0
  const canRunAll = (summary?.scored ?? 0) > 0

  return (
    <DashboardPage
      title="Eval"
      description="Replay past conversations against the current corpus and settings, and verify the assistant behaves how you expect."
      headerContent={howToHint}
    >
      {error ? <p className="mb-4 text-sm text-rose-600">{error}</p> : null}
      {hasCases ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span className="font-medium text-foreground">{passRateText}</span>
            {passRateDetail ? <span className="text-muted-foreground">{passRateDetail}</span> : null}
          </div>
          <div className="flex items-center gap-3">
            {runError ? <span className="text-sm text-rose-600">{runError}</span> : null}
            <Button type="button" onClick={runAll} disabled={running || !canRunAll}>
              {running ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
                  Running all…
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Run all
                </>
              )}
            </Button>
          </div>
        </div>
      ) : null}
      <EvalCaseDeleteDialog
        candidate={deleteCandidate}
        deleting={Boolean(deletingCaseId)}
        error={deleteError}
        onOpenChange={(open) => {
          if (!open && !deletingCaseId) {
            setDeleteCandidate(null)
            setDeleteError(null)
          }
        }}
        onConfirm={deleteCase}
      />
      {cases === null ? (
        <div className="flex justify-center py-12">
          <LogoSpinner imageClassName="h-6 w-6" />
        </div>
      ) : cases.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          No eval cases yet. Capture one from chat or activity using the steps above.
        </div>
      ) : (
        <DashboardTable aria-label="Eval cases" minWidth="min-w-[760px]">
          <DashboardTableHead>
            <DashboardTableHeader>Case</DashboardTableHeader>
            <DashboardTableHeader className="w-32">Status</DashboardTableHeader>
            <DashboardTableHeader className="w-40">Last run</DashboardTableHeader>
            <DashboardTableHeader className="w-40">Expectations</DashboardTableHeader>
            <DashboardTableHeader className="w-44">Updated</DashboardTableHeader>
            <DashboardTableHeader className="w-16">
              <span className="sr-only">Actions</span>
            </DashboardTableHeader>
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
                <DashboardTableCell className="w-40">
                  {c.latestRun ? (
                    <div className="flex flex-col gap-1">
                      <Badge variant="outline" className={`w-fit ${statusBadgeClass(c.latestRun.status)}`}>
                        {c.latestRun.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatRelative(c.latestRun.completedAt ?? c.latestRun.startedAt)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </DashboardTableCell>
                <DashboardTableCell className="w-40 text-muted-foreground">
                  {c.assertions.length === 0
                    ? 'None'
                    : `${c.assertions.length} expectation${c.assertions.length === 1 ? '' : 's'}`}
                </DashboardTableCell>
                <DashboardTableCell className="w-44 text-muted-foreground">
                  {formatRelative(c.updatedAt)}
                </DashboardTableCell>
                <DashboardTableCell className="w-16">
                  <div className="flex justify-end">
                    <button
                      type="button"
                      aria-label={`Delete eval case ${c.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteCandidate(c)
                        setDeleteError(null)
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      disabled={deletingCaseId === c.id}
                    >
                      {deletingCaseId === c.id ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </DashboardTableCell>
              </DashboardTableRow>
            ))}
          </DashboardTableBody>
        </DashboardTable>
      )}
    </DashboardPage>
  )
}

function EvalCaseDeleteDialog({
  candidate,
  deleting,
  error,
  onOpenChange,
  onConfirm,
}: {
  candidate: EvalCase | null
  deleting: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={candidate !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete eval case?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently remove{' '}
            <span className="font-medium text-foreground">{candidate?.name ?? 'this eval case'}</span>.
            Past runs are kept as historical records, but they will no longer be attached to this case.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? (
              <>
                <Spinner className="mr-2 h-4 w-4" />
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface EvalDetailProps {
  accountId: string
  routeState: DashboardRouteState
  caseId: string
}

function EvalDetail({ accountId, routeState, caseId }: EvalDetailProps) {
  const router = useRouter()
  const skillCatalog = useSkillCatalog(caseId)
  const [caseWithRuns, setCaseWithRuns] = useState<EvalCaseWithRuns | null>(null)
  const [snapshot, setSnapshot] = useState<EvalSnapshot | null>(null)
  const [currentAgent, setCurrentAgent] = useState<AgentSettings | null>(null)
  const [currentDirectives, setCurrentDirectives] = useState<Directive[]>([])
  const [agentSettingsStatus, setAgentSettingsStatus] = useState<'idle' | 'loading' | 'ready' | 'fallback'>('idle')
  const [docTitlesById, setDocTitlesById] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [deleteCandidate, setDeleteCandidate] = useState<EvalCase | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [replayOverrideState, dispatchReplayOverride] = useReducer(
    workbenchOverrideReducer,
    emptyReplayBaseline,
    createWorkbenchOverrideState,
  )

  const loadCase = useCallback(async () => {
    const c = await evalsApi.getCase(caseId)
    const snap = await evalsApi.getSnapshot(c.snapshotId)
    return { c, snap }
  }, [caseId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { c, snap } = await loadCase()
        if (cancelled) return
        setCaseWithRuns(c)
        setSnapshot(snap)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(getApiErrorMessage(err, 'Eval request failed'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadCase])

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

  // Prefer the source agent's current settings for new runs. If the agent was
  // deleted or cannot be read, replay can still fall back to the frozen config
  // captured on the snapshot.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!snapshot?.sourceAgentId) {
        setCurrentAgent(null)
        setCurrentDirectives([])
        setAgentSettingsStatus('fallback')
        return
      }
      setAgentSettingsStatus('loading')
      try {
        const [agent, directives] = await Promise.all([
          agentsApi.getAgent(snapshot.sourceAgentId),
          directivesApi.listDirectives(snapshot.sourceAgentId).catch(() => ({ directives: [] })),
        ])
        if (cancelled) return
        setCurrentAgent(agent)
        setCurrentDirectives(directives.directives)
        setAgentSettingsStatus('ready')
      } catch {
        if (cancelled) return
        setCurrentAgent(null)
        setCurrentDirectives([])
        setAgentSettingsStatus('fallback')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [snapshot?.sourceAgentId])

  const replayBaseline = useMemo(
    () => currentAgent
      ? buildWorkbenchBaseline(currentAgent, currentDirectives)
      : buildSnapshotReplayBaseline(snapshot),
    [currentAgent, currentDirectives, snapshot],
  )

  useEffect(() => {
    dispatchReplayOverride({ type: 'reset', baseline: replayBaseline })
  }, [replayBaseline])

  const agentReplayAvailable = Boolean(snapshot?.sourceAgentId && snapshot.originalAgentConfig)
  const effectiveAgentConfigOverride = useMemo(
    () => agentReplayAvailable
      ? buildEffectiveAgentConfigOverride(replayBaseline, replayOverrideState)
      : undefined,
    [agentReplayAvailable, replayBaseline, replayOverrideState],
  )

  const evalSeedTurn = useMemo(
    () => (snapshot ? buildEvalSeedTurn(snapshot) : null),
    [snapshot],
  )

  const selectedAgentForTraining = useMemo(
    () => currentAgent ?? (snapshot ? snapshotAgentToSettings(snapshot) : null),
    [currentAgent, snapshot],
  )

  const runAgain = useCallback(async () => {
    if (!caseWithRuns) return
    setRunning(true)
    setError(null)
    try {
      await evalsApi.runCase(caseId, {
        mode: 'full_assistant',
        overrides: effectiveAgentConfigOverride
          ? { agentConfigOverride: effectiveAgentConfigOverride }
          : undefined,
      })
      const { c, snap } = await loadCase()
      setCaseWithRuns(c)
      setSnapshot(snap)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Eval request failed'))
    } finally {
      setRunning(false)
    }
  }, [caseId, caseWithRuns, effectiveAgentConfigOverride, loadCase])

  const refreshLoadedCase = useCallback(async () => {
    const { c, snap } = await loadCase()
    setCaseWithRuns(c)
    setSnapshot(snap)
  }, [loadCase])

  const evalCoachDeps = useMemo(
    () => ({
      replay: async (input: { snapshotId: string; agentConfigOverride: AgentConfigOverrideInput }): Promise<WorkbenchReplayRunResponse> => {
        const result = await evalsApi.runCase(caseId, {
          mode: 'full_assistant',
          overrides: { agentConfigOverride: input.agentConfigOverride },
        })
        return {
          ...result,
          answer: result.run.observedOutput.answer,
          citations: result.run.observedOutput.citations,
          answerSegments: result.run.observedOutput.answerSegments,
          turnTrace: result.run.observedOutput.turnTrace,
          resolvedConfig: {
            ...result.run.resolvedConfig,
            retrievedChunks: result.run.observedOutput.retrievedChunks,
          },
        }
      },
    }),
    [caseId],
  )

  const backHref = useMemo(
    () => buildDashboardHref(accountId, { ...routeState, section: 'eval', evalCaseId: undefined }),
    [accountId, routeState],
  )

  const deleteCase = useCallback(async () => {
    if (!deleteCandidate) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await evalsApi.deleteCase(deleteCandidate.id)
      router.push(backHref)
    } catch (err) {
      setDeleteError(getApiErrorMessage(err, 'Failed to delete eval case'))
    } finally {
      setDeleting(false)
    }
  }, [backHref, deleteCandidate, router])

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
  const originalAssistantMessage = [...snapshot.messages].reverse().find((m) => m.role === 'assistant') ?? null
  const originalAnswer = originalAssistantMessage?.content ?? null

  const handleOpenCitation = async (documentId: string): Promise<CitationOpenResult> => {
    try {
      await documentsApi.getDocument(documentId)
      router.push(buildDashboardHref(accountId, {
        ...routeState,
        section: 'knowledge',
        knowledgeTab: 'documents',
        documentId,
      }))
      return 'opened'
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'error' in err &&
        err.error &&
        typeof err.error === 'object' &&
        'code' in err.error &&
        err.error.code === 'not_found'
      ) {
        return 'unavailable'
      }

      return 'error'
    }
  }

  // The captured assistant answer is reference material for the eval, not
  // the generated eval answer. Drop the trailing assistant turn so the
  // conversation panel shows the prompt context plus the latest run answer
  // when one exists.
  const capturedAnswerIsTrailing = snapshot.messages.at(-1)?.role === 'assistant'
  const conversationMessages = (() => {
    if (!capturedAnswerIsTrailing) return snapshot.messages
    return snapshot.messages.slice(0, -1)
  })()
  const latestRunAnswer = latestRun?.observedOutput.answer
  const conversationThreadMessages = toThreadMessages(conversationMessages)

  const expectationSummary =
    caseWithRuns.assertions.length === 0
      ? 'No expectations configured'
      : `${caseWithRuns.assertions.length} expectation${caseWithRuns.assertions.length === 1 ? '' : 's'}`

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="sticky top-0 z-30 space-y-3 border-b border-border bg-background/95 px-6 py-4 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            className="-ml-3 h-8 px-3 text-muted-foreground"
            onClick={() => router.push(backHref)}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to eval cases
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setAdvancedOpen(true)}
              aria-expanded={advancedOpen}
            >
              <ChevronRight className="mr-2 h-4 w-4" />
              Advanced
            </Button>
            <Button type="button" onClick={runAgain} disabled={running}>
              {running ? 'Running…' : 'Run case'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                setDeleteCandidate(caseWithRuns)
                setDeleteError(null)
              }}
              disabled={running || deleting}
            >
              {deleting ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
              <span className="sr-only">Delete eval case</span>
            </Button>
          </div>
        </div>

        <div className="min-w-0">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-foreground [overflow-wrap:anywhere]">{caseWithRuns.name}</h1>
              <Badge variant="outline" className={statusBadgeClass(caseWithRuns.status)}>
                {caseWithRuns.status}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>Captured {formatRelative(snapshot.capturedAt)}</span>
              <span>{expectationSummary}</span>
              <span>
                {agentSettingsStatus === 'ready'
                  ? 'Next run uses current agent settings'
                  : agentSettingsStatus === 'loading'
                    ? 'Loading current agent settings'
                    : 'Next run uses captured agent settings'}
              </span>
            </div>
          </div>
        </div>

        <Drawer open={advancedOpen} onOpenChange={setAdvancedOpen} direction="right" handleOnly>
          <DrawerContent className="flex h-full !w-[min(92vw,540px)] !max-w-[min(92vw,540px)] flex-col">
            <DrawerHeader className="border-b border-border py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <DrawerTitle>Advanced eval settings</DrawerTitle>
                  <DrawerDescription>
                    Temporary replay overrides for the next agent run.
                  </DrawerDescription>
                </div>
                <DrawerClose asChild>
                  <Button type="button" size="sm" variant="secondary">
                    Close
                  </Button>
                </DrawerClose>
              </div>
            </DrawerHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <WorkbenchOverridePanel
                baseline={replayBaseline}
                state={replayOverrideState}
                dispatch={dispatchReplayOverride}
                variant="drawer"
              />
            </div>
          </DrawerContent>
        </Drawer>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="space-y-6">
        {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        <EvalCaseDeleteDialog
          candidate={deleteCandidate}
          deleting={deleting}
          error={deleteError}
          onOpenChange={(open) => {
            if (!open && !deleting) {
              setDeleteCandidate(null)
              setDeleteError(null)
            }
          }}
          onConfirm={deleteCase}
        />

        <EvalResultBanner caseStatus={caseWithRuns.status} latestRun={latestRun} />

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(360px,0.8fr)]">
          {/* Conversation */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Conversation</CardTitle>
              <CardDescription>
                {conversationMessages.length} context message{conversationMessages.length === 1 ? '' : 's'} captured before the answer under test
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChatMessageThread
                messages={conversationThreadMessages}
                onOpenDocument={handleOpenCitation}
                showCitations
                analyticsSurface="eval"
                skillCatalog={skillCatalog}
              />
              {originalAssistantMessage ? (
                <details className="group mt-4 rounded-md border border-border bg-muted/20">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium text-muted-foreground">
                    Original captured answer
                    <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t border-border p-3 text-sm">
                    <EvalAnswerContent
                      answer={originalAnswer}
                      citations={originalAssistantMessage?.citations}
                      answerSegments={originalAssistantMessage?.answerSegments}
                      onOpenDocument={handleOpenCitation}
                      emptyLabel="(not captured)"
                    />
                  </div>
                </details>
              ) : null}
              {latestRunAnswer !== undefined && latestRun ? (
                <EvalGeneratedAnswer
                  run={latestRun}
                  answer={latestRunAnswer}
                  onOpenDocument={handleOpenCitation}
                  titleFor={titleFor}
                />
              ) : (
                <div className="mt-4 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                  Run the case to generate a new answer for this turn.
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
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
                  key={`${caseWithRuns.id}:${JSON.stringify(caseWithRuns.assertions)}`}
                  caseId={caseWithRuns.id}
                  initial={caseWithRuns.assertions}
                  resolveDocumentTitle={titleFor}
                  onSaved={(updated) => {
                    setCaseWithRuns((prev) => (prev ? { ...prev, ...updated, runs: prev.runs } : prev))
                  }}
                />
              </CardContent>
            </Card>

            {selectedAgentForTraining && evalSeedTurn ? (
              <Card>
                <CardContent className="pt-6">
                  <TrainingView
                    selectedAgent={selectedAgentForTraining}
                    seedTurn={evalSeedTurn}
                    snapshotId={snapshot.id}
                    coachDeps={evalCoachDeps}
                    onPreviewCreated={() => {
                      void refreshLoadedCase()
                    }}
                    onOpenDocument={(documentId) => {
                      void handleOpenCitation(documentId)
                    }}
                  />
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>

        {/* Run history */}
        {caseWithRuns.runs.length > 1 ? (
          <RunHistoryCard
            runs={caseWithRuns.runs.slice(1)}
            titleFor={titleFor}
          />
        ) : null}
        </div>
      </div>
    </div>
  )
}

interface RunOutputDetailProps {
  run: EvalRun
  titleFor: (id: string) => string | undefined
  /** When true, omits the top status row (caller renders its own). */
  hideStatus?: boolean
}

function EvalAnswerContent({
  answer,
  citations,
  answerSegments,
  onOpenDocument,
  emptyLabel,
}: {
  answer?: string | null
  citations?: EvalRun['observedOutput']['citations']
  answerSegments?: EvalRun['observedOutput']['answerSegments']
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
  emptyLabel: string
}) {
  if (!answer) {
    return <span className="text-muted-foreground">{emptyLabel}</span>
  }

  return (
    <AssistantMessageContent
      content={answer}
      citations={citations ?? []}
      answerSegments={answerSegments}
      onOpenDocument={onOpenDocument}
    />
  )
}

function EvalGeneratedAnswer({
  run,
  answer,
  onOpenDocument,
  titleFor,
}: {
  run: EvalRun
  answer: string
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
  titleFor: (id: string) => string | undefined
}) {
  return (
    <article className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Badge variant="secondary" className="border-primary/30 bg-primary/10 text-primary">
          Eval run
        </Badge>
        <span className="text-xs text-muted-foreground">
          {formatRelative(run.completedAt ?? run.startedAt)}
          {formatRunModel(run) ? ` · ${formatRunModel(run)}` : ''}
        </span>
      </div>
      <EvalAnswerContent
        answer={answer}
        citations={run.observedOutput.citations}
        answerSegments={run.observedOutput.answerSegments}
        onOpenDocument={onOpenDocument}
        emptyLabel="(empty answer)"
      />
      <div className="mt-4 border-t border-primary/20 pt-3">
        <RunOutputDetail
          run={run}
          titleFor={titleFor}
        />
      </div>
    </article>
  )
}

function RunOutputDetail({
  run,
  titleFor,
  hideStatus = false,
}: RunOutputDetailProps) {
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

      <EvalRunDiagnosticsPanel
        key={`${run.id}:${run.observedOutput.activityTrace?.traceId ?? run.observedOutput.turnTrace?.spine.traceId ?? 'no-trace'}`}
        run={run}
      />

      {run.assertionVerdicts.length > 0 ? (
        <div className="divide-y divide-border border-y border-border">
          {run.assertionVerdicts.map((v, i) => (
            <div key={i} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <div className="text-foreground">{assertionSummary(v.assertion, titleFor)}</div>
                {v.reason ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{humanizeVerdictReason(v, titleFor)}</p>
                ) : null}
              </div>
              <Badge variant="outline" className={statusBadgeClass(v.status)}>
                {v.status}
              </Badge>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function EvalRunDiagnosticsPanel({ run }: { run: EvalRun }) {
  const turnTrace = run.observedOutput.turnTrace
  const leafTrace = turnTrace ? getPrimaryLeafTrace(turnTrace) : undefined
  const activityTrace = run.observedOutput.activityTrace ?? leafTrace
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [flowOpen, setFlowOpen] = useState(false)
  const flowGraph = useMemo(
    () => (turnTrace ? envelopeToFlowGraph(turnTrace) : activityTrace ? activityTraceToFlowGraph(activityTrace, 'eval') : null),
    [activityTrace, turnTrace],
  )
  const initialFlowNode = useMemo(
    () =>
      flowGraph?.nodes.find((node) => node.id === 'input:message') ??
      flowGraph?.nodes.find((node) => node.nodeKind === 'input') ??
      flowGraph?.nodes.find((node) => node.nodeKind === 'engine') ??
      flowGraph?.nodes.find((node) => node.nodeKind === 'skill') ??
      flowGraph?.nodes.find((node) => node.nodeKind === 'stage') ??
      null,
    [flowGraph],
  )
  const [selectedFlowNode, setSelectedFlowNode] = useState<TurnFlowNode | null>(null)
  const activeFlowNode = selectedFlowNode ?? initialFlowNode

  const outcomePresentation = presentEvalRunOutcome(run, activityTrace)
  const runParameters = presentRunParameters(activityTrace)

  return (
    <>
      <div className="flex">
        <Button
          type="button"
          variant={drawerOpen ? 'secondary' : 'outline'}
          className="gap-1.5"
          onClick={() => setDrawerOpen(true)}
        >
          <Bug className="h-4 w-4" />
          Debug
        </Button>
      </div>

      <Drawer
        open={drawerOpen}
        onOpenChange={(open) => {
          setDrawerOpen(open)
          if (!open) setFlowOpen(false)
        }}
        direction="right"
        handleOnly
      >
        <DrawerContent className="h-full !w-[96vw] !max-w-[96vw] lg:!w-[94vw] lg:!max-w-[94vw]">
          <DrawerHeader className="border-b border-border py-3">
            <div className="flex items-center justify-between gap-4">
              <DrawerTitle className="sr-only">Eval run debug</DrawerTitle>
              <div className="flex min-w-0 items-center gap-3">
                <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Eval run
                </span>
                <span className="min-w-0 truncate font-mono text-sm text-foreground">{run.id}</span>
              </div>
              <div className="flex items-center gap-2">
                {flowGraph ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => setFlowOpen(true)}
                  >
                    <Workflow className="h-3.5 w-3.5" />
                    Flow
                  </Button>
                ) : null}
                <DrawerClose asChild>
                  <Button type="button" size="sm" variant="secondary" className="gap-1.5">
                    <Bug className="h-3.5 w-3.5" />
                    Close
                  </Button>
                </DrawerClose>
              </div>
            </div>
            <DrawerDescription className="sr-only">Eval diagnostics panel</DrawerDescription>
          </DrawerHeader>

          <div className="min-h-0 flex-1 overflow-hidden p-4">
            <div className="h-full min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
              <div className="space-y-4">
                {run.observedOutput.error?.message ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    {run.observedOutput.error.message}
                  </div>
                ) : null}

                <DiagnosticPresentationSection label="Outcome summary" presentation={outcomePresentation} />

                {runParameters ? (
                  <DiagnosticPresentationSection label="Run parameters" presentation={runParameters} />
                ) : null}

                {flowGraph ? (
                  <p className="text-xs text-muted-foreground">
                    Open <span className="font-medium text-foreground">Flow</span> to explore this eval run as a graph.
                  </p>
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                    Activity trace unavailable for this run.
                  </div>
                )}
              </div>
            </div>
          </div>

          {flowGraph ? (
            <EvalFlowOverlay
              open={flowOpen}
              graph={flowGraph}
              selectedNode={activeFlowNode}
              onSelectNode={setSelectedFlowNode}
              onClose={() => setFlowOpen(false)}
              spineStages={turnTrace?.spine.stages ?? []}
              leafTrace={activityTrace}
            />
          ) : null}
        </DrawerContent>
      </Drawer>
    </>
  )
}

function EvalFlowOverlay({
  open,
  graph,
  selectedNode,
  onSelectNode,
  onClose,
  spineStages,
  leafTrace,
}: {
  open: boolean
  graph: ReturnType<typeof envelopeToFlowGraph>
  selectedNode: TurnFlowNode | null
  onSelectNode: (node: TurnFlowNode) => void
  onClose: () => void
  spineStages: ConversationTraceStage[]
  leafTrace?: EvalRun['observedOutput']['activityTrace']
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-foreground">Eval flow</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          aria-label="Close eval flow"
          onClick={onClose}
        >
          <Minimize2 className="h-3.5 w-3.5" />
          Close
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(360px,520px)]">
        <div className="min-h-0">
          <TurnFlowGraph
            graph={graph}
            selectedNodeId={selectedNode?.id}
            onSelectNode={onSelectNode}
            showMiniMap
          />
        </div>
        <div data-testid="eval-flow-stage-detail" className="min-h-0 overflow-y-auto border-l border-border p-4">
          <EvalTurnFlowNodeDetail
            node={selectedNode}
            spineStages={spineStages}
            leafTrace={leafTrace}
          />
        </div>
      </div>
    </div>
  )
}

function EvalTurnFlowNodeDetail({
  node,
  spineStages,
  leafTrace,
}: {
  node: TurnFlowNode | null
  spineStages: ConversationTraceStage[]
  leafTrace?: EvalRun['observedOutput']['activityTrace']
}) {
  if (!node) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Select a node to inspect it.
      </div>
    )
  }

  if (node.detail.kind === 'leaf' && leafTrace) {
    return <ActivityTraceDetail activityTrace={leafTrace} selectedStageId={node.detail.leafStageId} />
  }

  let spineStage: ConversationTraceStage | undefined
  if (node.detail.kind === 'spine') {
    const { spineStageId } = node.detail
    spineStage = spineStages.find((stage) => stage.id === spineStageId)
  }

  if (!spineStage) {
    return (
      <div className="space-y-1">
        <p className="text-base font-medium text-foreground">{node.label}</p>
        {node.sublabel ? <p className="text-sm text-muted-foreground">{node.sublabel}</p> : null}
        <p className="text-sm text-muted-foreground">No further detail recorded for this node.</p>
      </div>
    )
  }

  const durationMs = getConversationStageDurationMs(spineStage)

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Selected step</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-xl font-semibold text-foreground">{node.label}</p>
          <Badge variant="outline">{spineStage.status}</Badge>
          <span className="text-sm text-muted-foreground">{spineStage.kind}</span>
        </div>
        {node.sublabel ? <p className="mt-2 text-sm text-muted-foreground">{node.sublabel}</p> : null}
        {durationMs !== null ? (
          <p className="mt-2 text-sm text-muted-foreground">{durationMs}ms</p>
        ) : null}
      </div>

      <EvalTraceJsonBlock title="Inputs" value={spineStage.inputs} />
      <EvalTraceJsonBlock title="Outputs" value={spineStage.outputs} />
    </div>
  )
}

function getConversationStageDurationMs(stage: ConversationTraceStage): number | null {
  if (!stage.startedAt || !stage.completedAt) return null
  const startedAt = Date.parse(stage.startedAt)
  const completedAt = Date.parse(stage.completedAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null
  return Math.max(0, completedAt - startedAt)
}

function EvalTraceJsonBlock({ title, value }: { title: string; value: unknown }) {
  const formatted = JSON.stringify(value ?? {}, null, 2)
  const hasValue = formatted !== '{}'

  return (
    <details className="group rounded-lg border border-border bg-background/50" open={hasValue}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium text-foreground">
        {title}
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <pre className="max-h-64 overflow-auto border-t border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
        {formatted}
      </pre>
    </details>
  )
}

interface RunHistoryCardProps {
  runs: EvalRun[]
  titleFor: (id: string) => string | undefined
}

function RunHistoryCard({
  runs,
  titleFor,
}: RunHistoryCardProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const counts = runs.reduce<Record<EvalRunStatus, number>>(
    (acc, run) => {
      acc[run.status] += 1
      return acc
    },
    { pass: 0, fail: 0, error: 0, recorded: 0 },
  )
  const visibleCounts = (Object.entries(counts) as Array<[EvalRunStatus, number]>)
    .filter(([, count]) => count > 0)

  return (
    <Card>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-6">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Run history</CardTitle>
              <span className="text-sm text-muted-foreground">
                {runs.length} earlier run{runs.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {visibleCounts.map(([status, count]) => (
                <Badge key={status} variant="outline" className={statusBadgeClass(status)}>
                  {count} {status}
                </Badge>
              ))}
            </div>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
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
      </details>
    </Card>
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
