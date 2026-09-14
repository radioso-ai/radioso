'use client'

import { useEffect, useRef, useState } from 'react'

import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  agentRevisionsApi,
  type AgentRevisionSummary,
  type TestExecutionHistoryDetail,
  type TestExecutionHistoryItem,
} from '@/lib/api-agent-revisions'

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const revisionLabel = (revision: AgentRevisionSummary): string => {
  if (revision.kind === 'published' && revision.versionNumber !== null) return `v${revision.versionNumber}`
  if (revision.kind === 'candidate') return `Draft · ${timestampFormatter.format(new Date(revision.createdAt))}`
  return 'Legacy revision'
}

/** Durable private revision tests. Legacy operator sessions remain in TestSessionsView. */
export function TestExecutionHistoryView({
  agentId,
  onOpen,
}: {
  agentId: string
  onOpen: (execution: TestExecutionHistoryDetail) => void
}) {
  const [executions, setExecutions] = useState<TestExecutionHistoryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const openRequestGeneration = useRef(0)
  const pageRequestGeneration = useRef(0)

  useEffect(() => {
    let cancelled = false
    const requestGeneration = pageRequestGeneration.current + 1
    pageRequestGeneration.current = requestGeneration
    void agentRevisionsApi.listTestExecutions(agentId, { limit: 50 })
      .then((response) => {
        if (!cancelled && pageRequestGeneration.current === requestGeneration) {
          setExecutions(response.executions)
          setNextCursor(response.nextCursor)
          setError(null)
        }
      })
      .catch((cause) => {
        if (!cancelled && pageRequestGeneration.current === requestGeneration) setError(cause instanceof Error ? cause.message : 'Could not load saved revision tests.')
      })
    return () => {
      cancelled = true
      if (pageRequestGeneration.current === requestGeneration) pageRequestGeneration.current += 1
      openRequestGeneration.current += 1
    }
  }, [agentId])

  const open = async (executionId: string) => {
    const requestGeneration = openRequestGeneration.current + 1
    openRequestGeneration.current = requestGeneration
    setOpeningId(executionId)
    try {
      const response = await agentRevisionsApi.getTestExecution(agentId, executionId)
      if (openRequestGeneration.current !== requestGeneration) return
      onOpen(response.execution)
    } catch (cause) {
      if (openRequestGeneration.current === requestGeneration) setError(cause instanceof Error ? cause.message : 'Could not reopen this private test.')
    } finally {
      if (openRequestGeneration.current === requestGeneration) setOpeningId(null)
    }
  }

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    const requestGeneration = pageRequestGeneration.current + 1
    pageRequestGeneration.current = requestGeneration
    setLoadingMore(true)
    try {
      const response = await agentRevisionsApi.listTestExecutions(agentId, { limit: 50, cursor: nextCursor })
      if (pageRequestGeneration.current !== requestGeneration) return
      setExecutions((current) => current ? [...current, ...response.executions] : response.executions)
      setNextCursor(response.nextCursor)
    } catch (cause) {
      if (pageRequestGeneration.current === requestGeneration) setError(cause instanceof Error ? cause.message : 'Could not load more saved revision tests.')
    } finally {
      if (pageRequestGeneration.current === requestGeneration) setLoadingMore(false)
    }
  }

  if (error && executions === null) return <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>
  if (executions === null) return <div className="flex justify-center p-10"><LogoSpinner imageClassName="h-7 w-7" /></div>
  if (executions.length === 0) return <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">No saved revision tests yet. Your first message creates one and keeps its selected revisions and test values.</p>

  return <div className="space-y-3">{error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}<DashboardTable minWidth="min-w-0">
    <DashboardTableHead>
      <DashboardTableHeader>Test</DashboardTableHeader>
      <DashboardTableHeader>Versions</DashboardTableHeader>
      <DashboardTableHeader className="w-44">Created</DashboardTableHeader>
      <DashboardTableHeader className="w-28" />
    </DashboardTableHead>
    <DashboardTableBody>
      {executions.map((execution) => <DashboardTableRow key={execution.id}>
        <DashboardTableCell className="font-medium">{execution.mode === 'compare' ? 'Comparison' : 'Single revision test'}</DashboardTableCell>
        <DashboardTableCell className="text-sm text-muted-foreground">{execution.sides.map((side) => revisionLabel(side.revision)).join(' · ')}</DashboardTableCell>
        <DashboardTableCell className="w-44 text-sm text-muted-foreground">{timestampFormatter.format(new Date(execution.createdAt))}</DashboardTableCell>
        <DashboardTableCell className="w-28 text-right"><Button size="sm" variant="outline" onClick={() => void open(execution.id)} disabled={openingId !== null}>{openingId === execution.id ? 'Opening…' : 'Open'}</Button></DashboardTableCell>
      </DashboardTableRow>)}
    </DashboardTableBody>
  </DashboardTable>{nextCursor ? <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</Button> : null}</div>
}
