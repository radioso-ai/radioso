'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'

import { ChatRetrievalInfo } from '@/components/dashboard/chat-retrieval-info'
import { ChatRetrievalTraceGraph } from '@/components/dashboard/chat-retrieval-trace-graph'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  type EvalCase,
  type EvalCaseResult,
  type EvalDatasetDetail,
  type EvalDatasetSummary,
  type EvalRunComparison,
  type EvalRun,
  evalApi,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'

export function EvalsView({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const [datasets, setDatasets] = useState<EvalDatasetSummary[]>([])
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(routeState.evalDatasetId ?? null)
  const [datasetDetail, setDatasetDetail] = useState<EvalDatasetDetail | null>(null)
  const [comparison, setComparison] = useState<EvalRunComparison | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [isInspectorOpen, setIsInspectorOpen] = useState(false)
  const [showGraph, setShowGraph] = useState(false)
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId],
  )

  useEffect(() => {
    let active = true

    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await evalApi.listDatasets()
        if (!active) return
        setDatasets(response.datasets)
        const nextSelectedId = routeState.evalDatasetId ?? response.datasets[0]?.id ?? null
        setSelectedDatasetId(nextSelectedId)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load eval datasets.'))
      } finally {
        if (active) setIsLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [routeState.evalDatasetId])

  useEffect(() => {
    if (!selectedDatasetId) {
      setDatasetDetail(null)
      setComparison(null)
      return
    }

    let active = true

    const loadDetail = async () => {
      try {
        const detail = await evalApi.getDataset(selectedDatasetId)
        if (!active) return
        setDatasetDetail(detail)
        const initialRun = detail.runs[0] ?? null
        const nextRunId = initialRun?.id ?? null
        const nextCaseId = initialRun?.results[0]?.caseId ?? detail.cases[0]?.id ?? null
        setSelectedRunId(nextRunId)
        setSelectedCaseId(nextCaseId)
        setIsInspectorOpen(false)
        setSelectedStageId(initialRun?.results[0]?.diagnostics.retrievalTrace?.stages[0]?.stageId)
        const latestRun = detail.runs[0]
        if (latestRun && (latestRun.baselineRunId || detail.runs[1])) {
          const nextComparison = await evalApi.getComparison(selectedDatasetId, latestRun.id, latestRun.baselineRunId ?? detail.runs[1]?.id)
          if (!active) return
          setComparison(nextComparison)
        } else {
          setComparison(null)
        }
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load eval dataset details.'))
      }
    }

    void loadDetail()
    return () => {
      active = false
    }
  }, [selectedDatasetId])

  const pushDatasetRoute = (datasetId?: string | null) => {
    router.push(buildDashboardHref(accountId, {
      ...routeState,
      section: 'evals',
      evalDatasetId: datasetId ?? undefined,
    }))
  }

  const handleCreateDataset = async () => {
    if (!name.trim()) {
      return
    }
    setIsCreating(true)
    setError(null)
    try {
      const dataset = await evalApi.createDataset({
        name: name.trim(),
        description: description.trim(),
      })
      const nextDatasets = [dataset, ...datasets]
      setDatasets(nextDatasets)
      setName('')
      setDescription('')
      setSelectedDatasetId(dataset.id)
      pushDatasetRoute(dataset.id)
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to create eval dataset.'))
    } finally {
      setIsCreating(false)
    }
  }

  const handleRunDataset = async () => {
    if (!selectedDatasetId || !datasetDetail) {
      return
    }

    setIsRunning(true)
    setError(null)
    try {
      const latestRun = datasetDetail.runs[0]
      await evalApi.runDataset(selectedDatasetId, {
        label: `Run ${new Date().toLocaleString()}`,
        baselineRunId: latestRun?.id,
      })
      const nextDetail = await evalApi.getDataset(selectedDatasetId)
      setDatasetDetail(nextDetail)
      const nextLatestRun = nextDetail.runs[0] ?? null
      setSelectedRunId(nextLatestRun?.id ?? null)
      setSelectedCaseId(nextLatestRun?.results[0]?.caseId ?? nextDetail.cases[0]?.id ?? null)
      setIsInspectorOpen(false)
      setSelectedStageId(nextLatestRun?.results[0]?.diagnostics.retrievalTrace?.stages[0]?.stageId)
      setDatasets((current) => current.map((dataset) => (
        dataset.id === selectedDatasetId
          ? {
              ...dataset,
              runCount: nextDetail.runs.length,
              caseCount: nextDetail.cases.length,
              lastRunAt: nextDetail.runs[0]?.completedAt ?? dataset.lastRunAt,
            }
          : dataset
      )))
      if (nextLatestRun && (nextLatestRun.baselineRunId || nextDetail.runs[1])) {
        const nextComparison = await evalApi.getComparison(selectedDatasetId, nextLatestRun.id, nextLatestRun.baselineRunId ?? nextDetail.runs[1]?.id)
        setComparison(nextComparison)
      } else {
        setComparison(null)
      }
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to run eval dataset.'))
    } finally {
      setIsRunning(false)
    }
  }

  const selectedRun = useMemo(
    () => datasetDetail?.runs.find((run) => run.id === selectedRunId) ?? datasetDetail?.runs[0] ?? null,
    [datasetDetail, selectedRunId],
  )

  const selectedCase = useMemo(
    () => datasetDetail?.cases.find((evalCase) => evalCase.id === selectedCaseId) ?? datasetDetail?.cases[0] ?? null,
    [datasetDetail, selectedCaseId],
  )

  const selectedResult = useMemo(
    () => selectedRun?.results.find((result) => result.caseId === selectedCase?.id) ?? null,
    [selectedCase?.id, selectedRun],
  )

  const baselineRun = useMemo(() => {
    if (!datasetDetail || !selectedRun) {
      return null
    }

    return (
      datasetDetail.runs.find((run) => run.id === selectedRun.baselineRunId) ??
      datasetDetail.runs.find((run) => run.id !== selectedRun.id) ??
      null
    )
  }, [datasetDetail, selectedRun])

  const baselineResult = useMemo(
    () => baselineRun?.results.find((result) => result.caseId === selectedCase?.id) ?? null,
    [baselineRun, selectedCase?.id],
  )

  useEffect(() => {
    setSelectedStageId(selectedResult?.diagnostics.retrievalTrace?.stages[0]?.stageId)
  }, [selectedResult?.caseId, selectedResult?.diagnostics.retrievalTrace?.traceId, selectedRun?.id])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium text-foreground">Evals</h1>
        <p className="text-sm text-muted-foreground">
          Replay saved cases, compare runs, and guard against retrieval regressions.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 p-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">New dataset</p>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Regression guards"
            />
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional description"
            />
            <Button type="button" onClick={() => void handleCreateDataset()} disabled={isCreating || !name.trim()}>
              {isCreating ? 'Creating...' : 'Create dataset'}
            </Button>
          </div>

          <div className="mt-6 space-y-2">
            <p className="text-sm font-medium text-foreground">Datasets</p>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="h-5 w-5" />
              </div>
            ) : datasets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No eval datasets yet.</p>
            ) : (
              datasets.map((dataset) => (
                <button
                  key={dataset.id}
                  type="button"
                  onClick={() => {
                    setSelectedDatasetId(dataset.id)
                    pushDatasetRoute(dataset.id)
                  }}
                  className={`w-full rounded-lg border p-3 text-left transition ${
                    selectedDataset?.id === dataset.id
                      ? 'border-primary/60 bg-primary/5'
                      : 'border-border bg-card hover:border-primary/30'
                  }`}
                >
                  <p className="font-medium text-foreground">{dataset.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dataset.caseCount} cases • {dataset.runCount} runs
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/50 p-4">
          {error ? (
            <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {!datasetDetail ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a dataset to inspect or run it.
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium text-foreground">{datasetDetail.name}</h2>
                  <p className="text-sm text-muted-foreground">{datasetDetail.description || 'No description yet.'}</p>
                </div>
                <Button
                  type="button"
                  onClick={() => void handleRunDataset()}
                  disabled={isRunning || datasetDetail.cases.length === 0}
                >
                  {isRunning ? 'Running...' : 'Run dataset'}
                </Button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="text-sm font-medium text-foreground">Cases</p>
                  <div className="mt-3 space-y-2">
                    {datasetDetail.cases.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Add cases from History to make this dataset useful.</p>
                    ) : datasetDetail.cases.map((evalCase) => (
                      <button
                        key={evalCase.id}
                        type="button"
                        onClick={() => {
                          setSelectedCaseId(evalCase.id)
                          setIsInspectorOpen(true)
                        }}
                        className={`w-full rounded-md border p-3 text-left transition ${
                          selectedCase?.id === evalCase.id
                            ? 'border-primary/60 bg-primary/5'
                            : 'border-border/70 hover:border-primary/40'
                        }`}
                      >
                        <p className="text-sm font-medium text-foreground">{evalCase.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{evalCase.query}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="text-sm font-medium text-foreground">Runs</p>
                  <div className="mt-3 space-y-2">
                    {datasetDetail.runs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No runs yet.</p>
                    ) : datasetDetail.runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => {
                          setSelectedRunId(run.id)
                          setIsInspectorOpen(true)
                        }}
                        className={`w-full rounded-md border p-3 text-left transition ${
                          selectedRun?.id === run.id
                            ? 'border-primary/60 bg-primary/5'
                            : 'border-border/70 hover:border-primary/40'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-foreground">{run.label || 'Unnamed run'}</p>
                          <span className="text-xs text-muted-foreground">{new Date(run.completedAt).toLocaleString()}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {run.summary.passCount} pass • {run.summary.failCount} fail • {run.summary.regressionCount} regressions
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {comparison ? (
                <div className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-foreground">Latest comparison</p>
                    <p className="text-xs text-muted-foreground">
                      {comparison.improvements} improved • {comparison.regressions} regressed • {comparison.unchanged} unchanged
                    </p>
                  </div>
                  <div className="mt-3 space-y-2">
                    {comparison.cases.map((item) => (
                      <div key={item.caseId} className="rounded-md border border-border/70 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-foreground">{item.title}</p>
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">{item.outcome}</span>
                        </div>
                        {item.reasons[0] ? (
                          <p className="mt-1 text-xs text-muted-foreground">{item.reasons[0]}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <Drawer
        open={isInspectorOpen && Boolean(selectedRun && selectedCase && selectedResult)}
        onOpenChange={(open) => {
          if (!open) {
            setIsInspectorOpen(false)
            setShowGraph(false)
            setSelectedStageId(undefined)
          }
        }}
        direction="right"
        handleOnly
      >
        <DrawerContent
          className={`h-full transition-[width,max-width] duration-300 ease-in-out data-[vaul-drawer-direction=right]:w-[96vw] sm:data-[vaul-drawer-direction=right]:max-w-[96vw] ${
            showGraph
              ? 'lg:data-[vaul-drawer-direction=right]:w-[94vw] lg:data-[vaul-drawer-direction=right]:max-w-[94vw]'
              : 'lg:data-[vaul-drawer-direction=right]:w-[88vw] lg:data-[vaul-drawer-direction=right]:max-w-[88vw]'
          }`}
        >
          <DrawerHeader className="border-b border-border">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <DrawerTitle className="sr-only">Eval case details</DrawerTitle>
                {selectedCase ? (
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{selectedCase.title}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{selectedCase.query}</p>
                  </div>
                ) : null}
                <DrawerDescription className="sr-only">Eval details panel</DrawerDescription>
              </div>
              <DrawerClose className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </DrawerClose>
            </div>
          </DrawerHeader>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {selectedRun && selectedCase && selectedResult ? (
              <EvalCaseInspector
                evalCase={selectedCase}
                selectedRun={selectedRun}
                selectedResult={selectedResult}
                baselineRun={baselineRun}
                baselineResult={baselineResult}
                showGraph={showGraph}
                onToggleGraph={() => setShowGraph((current) => !current)}
                selectedStageId={selectedStageId}
                onSelectStage={setSelectedStageId}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select a case to inspect it.
              </div>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function EvalCaseInspector({
  evalCase,
  selectedRun,
  selectedResult,
  baselineRun,
  baselineResult,
  showGraph,
  onToggleGraph,
  selectedStageId,
  onSelectStage,
}: {
  evalCase: EvalCase
  selectedRun: EvalRun
  selectedResult: EvalCaseResult
  baselineRun: EvalRun | null
  baselineResult: EvalCaseResult | null
  showGraph: boolean
  onToggleGraph: () => void
  selectedStageId?: string
  onSelectStage: (stageId: string) => void
}) {
  const trace = selectedResult.diagnostics.retrievalTrace
  const graphPane = trace ? (
    <ChatRetrievalTraceGraph
      retrievalTrace={trace}
      selectedStageId={selectedStageId ?? trace.stages[0]?.stageId ?? ''}
      onSelectStage={onSelectStage}
    />
  ) : null

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <section className="rounded-lg border border-border/70 bg-background/60 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Replay summary</p>
              <p className="mt-1 text-xs text-muted-foreground">
                One saved case, one selected run, and the answer that was judged.
              </p>
            </div>
            <span className={statusBadgeClass(selectedResult.status)}>{selectedResult.status}</span>
          </div>

          <div className="mt-4 space-y-4">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Case</p>
              <p className="mt-1 text-sm font-medium text-foreground">{evalCase.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{evalCase.query}</p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Run" value={selectedRun.label || 'Unnamed run'} />
              <MetricCard label="Answer outcome" value={selectedResult.diagnostics.answerOutcome.replaceAll('_', ' ')} />
              <MetricCard label="Latency" value={`${selectedResult.diagnostics.latencyMs}ms`} />
              <MetricCard label="Comparison" value={selectedResult.comparisonOutcome ?? 'unscored'} />
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Answer</p>
              <div className="mt-2 rounded-lg border border-border/70 bg-background/70 p-3">
                <p className="whitespace-pre-wrap text-sm text-foreground">{selectedResult.diagnostics.answer}</p>
              </div>
            </div>

            {selectedResult.score.reasons.length > 0 ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-foreground">
                {selectedResult.score.reasons.join(' ')}
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-foreground">
                All configured checks passed for this replay.
              </div>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-border/70 bg-background/60 p-4">
          <p className="text-sm font-medium text-foreground">What was checked</p>
          <div className="mt-3 space-y-2">
            <ScoreRow label="Document match" verdict={selectedResult.score.documentMatch.verdict} reason={selectedResult.score.documentMatch.reason} />
            <ScoreRow label="Citation match" verdict={selectedResult.score.citationMatch.verdict} reason={selectedResult.score.citationMatch.reason} />
            <ScoreRow label="Refusal behavior" verdict={selectedResult.score.refusalMatch.verdict} reason={selectedResult.score.refusalMatch.reason} />
            <ScoreRow label="Answer outcome" verdict={selectedResult.score.answerOutcomeMatch.verdict} reason={selectedResult.score.answerOutcomeMatch.reason} />
            <ScoreRow label="Phrase checks" verdict={selectedResult.score.answerContainsMatch.verdict} reason={selectedResult.score.answerContainsMatch.reason} />
            <ScoreRow label="Latency" verdict={selectedResult.score.latencyMatch.verdict} reason={selectedResult.score.latencyMatch.reason} />
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border/70 bg-background/60 p-4">
          <p className="text-sm font-medium text-foreground">Replay input</p>
          <p className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground">Prior conversation</p>
          {evalCase.conversationContext.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">This case replays as a standalone question.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {evalCase.conversationContext.map((message, index) => (
                <div key={`${message.role}-${index}`} className="rounded-md border border-border/70 bg-background/70 p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{message.role}</p>
                  <p className="mt-1 text-sm text-foreground">{message.content}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border/70 bg-background/60 p-4">
          <p className="text-sm font-medium text-foreground">Expectations</p>
          <div className="mt-3 space-y-2 text-sm text-foreground">
            <ExpectationRow label="Expected documents" value={formatStringList(evalCase.expectations.expectedDocumentIds)} />
            <ExpectationRow label="Expected citations" value={formatStringList(evalCase.expectations.expectedCitationTitles)} />
            <ExpectationRow label="Expected refusal behavior" value={evalCase.expectations.expectedRefusalBehavior} />
            <ExpectationRow label="Expected answer outcome" value={evalCase.expectations.expectedAnswerOutcome} />
            <ExpectationRow label="Required phrases" value={formatStringList(evalCase.expectations.requiredPhrases)} />
            <ExpectationRow label="Forbidden phrases" value={formatStringList(evalCase.expectations.forbiddenPhrases)} />
            <ExpectationRow
              label="Latency budget"
              value={typeof evalCase.expectations.latencyBudgetMs === 'number' ? `${evalCase.expectations.latencyBudgetMs}ms` : undefined}
            />
          </div>
        </section>
      </div>

      {baselineRun && baselineResult ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">Baseline comparison</p>
              <p className="text-xs text-muted-foreground">
                Reference run for judging regressions and improvements.
              </p>
            </div>
            <span className={statusBadgeClass(baselineResult.status)}>{baselineResult.status}</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Baseline run" value={baselineRun.label || 'Unnamed run'} />
            <MetricCard label="Completed" value={new Date(baselineRun.completedAt).toLocaleString()} />
            <MetricCard label="Answer outcome" value={baselineResult.diagnostics.answerOutcome.replaceAll('_', ' ')} />
            <MetricCard label="Latency" value={`${baselineResult.diagnostics.latencyMs}ms`} />
          </div>
          {selectedResult.comparisonReasons?.length ? (
            <div className="mt-4 rounded-lg border border-border/70 bg-background/70 p-3 text-sm text-foreground">
              {selectedResult.comparisonReasons.join(' ')}
            </div>
          ) : null}
        </section>
      ) : null}

      {trace ? (
        <section className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">Diagnostics</p>
              <p className="text-xs text-muted-foreground">
                Shared retrieval diagnostics for this eval replay.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={onToggleGraph}>
              {showGraph ? 'Hide graph' : 'Show graph'}
            </Button>
          </div>

          <div
            className="grid gap-4 overflow-hidden"
            style={{
              gridTemplateColumns: showGraph ? 'minmax(380px,1fr) minmax(0,1.1fr)' : '0px minmax(0,1fr)',
              transition: 'grid-template-columns 300ms ease',
            }}
          >
            <div
              className="overflow-hidden rounded-xl border border-border/70 bg-background/60 p-4"
              style={{
                opacity: showGraph ? 1 : 0,
                transform: showGraph ? 'translateX(0)' : 'translateX(12px)',
                transition: 'opacity 300ms ease, transform 300ms ease',
                pointerEvents: showGraph ? 'auto' : 'none',
              }}
            >
              <div className="mb-3">
                <p className="text-sm font-medium text-foreground">Trace graph</p>
                <p className="text-xs text-muted-foreground">
                  Top-down retrieval flow for this replayed answer.
                </p>
              </div>
              {graphPane}
            </div>

            <div>
              {showGraph ? (
                <ChatRetrievalInfo
                  retrievalInfo={selectedResult.diagnostics.retrievalInfo}
                  retrievalTrace={trace}
                  selectedStageId={selectedStageId}
                  graphMode
                />
              ) : (
                <ChatRetrievalInfo
                  retrievalInfo={selectedResult.diagnostics.retrievalInfo}
                  retrievalTrace={trace}
                  selectedStageId={undefined}
                />
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Detailed retrieval trace was not recorded for this replay.
        </section>
      )}
    </div>
  )
}

function ExpectationRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/70 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm text-foreground">{value && value.length > 0 ? value : 'Not checked'}</p>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/70 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm text-foreground">{value}</p>
    </div>
  )
}

function ScoreRow({
  label,
  verdict,
  reason,
}: {
  label: string
  verdict: 'pass' | 'fail' | 'unscored'
  reason?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-background/70 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {verdict === 'pass'
            ? 'Check passed.'
            : verdict === 'fail'
              ? reason ?? 'Check failed.'
              : 'This dimension is not configured for this case.'}
        </p>
      </div>
      <span className={statusBadgeClass(verdict)}>{verdict}</span>
    </div>
  )
}

function formatStringList(values?: string[]) {
  return values && values.length > 0 ? values.join(', ') : undefined
}

function statusBadgeClass(status: 'pass' | 'fail' | 'unscored' | 'skipped' | 'invalid' | 'improved' | 'regressed' | 'unchanged' | 'unscored') {
  if (status === 'pass' || status === 'improved') {
    return 'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700'
  }

  if (status === 'fail' || status === 'regressed' || status === 'invalid') {
    return 'rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-rose-700'
  }

  if (status === 'unchanged') {
    return 'rounded-full border border-slate-500/30 bg-slate-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-700'
  }

  return 'rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700'
}
