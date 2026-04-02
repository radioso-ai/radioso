'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  type EvalDatasetDetail,
  type EvalDatasetSummary,
  type EvalRunComparison,
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
      const nextLatestRun = nextDetail.runs[0]
      if (nextLatestRun && (nextLatestRun.baselineRunId || nextDetail.runs[1])) {
        const nextComparison = await evalApi.getComparison(selectedDatasetId, nextLatestRun.id, nextLatestRun.baselineRunId ?? nextDetail.runs[1]?.id)
        setComparison(nextComparison)
      }
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to run eval dataset.'))
    } finally {
      setIsRunning(false)
    }
  }

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
                      <div key={evalCase.id} className="rounded-md border border-border/70 p-3">
                        <p className="text-sm font-medium text-foreground">{evalCase.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{evalCase.query}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="text-sm font-medium text-foreground">Runs</p>
                  <div className="mt-3 space-y-2">
                    {datasetDetail.runs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No runs yet.</p>
                    ) : datasetDetail.runs.map((run) => (
                      <div key={run.id} className="rounded-md border border-border/70 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-foreground">{run.label || 'Unnamed run'}</p>
                          <span className="text-xs text-muted-foreground">{new Date(run.completedAt).toLocaleString()}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {run.summary.passCount} pass • {run.summary.failCount} fail • {run.summary.regressionCount} regressions
                        </p>
                      </div>
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
    </div>
  )
}
