'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Link2 } from 'lucide-react'

import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  agentRevisionsApi,
  type AgentRevisionSummary,
  type TestExecutionHistoryDetail,
  type TestExecutionHistoryListItem,
} from '@/lib/api-agent-revisions'
import { useCopyDashboardLink } from '@/hooks/use-copy-dashboard-link'

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const revisionLabel = (revision: AgentRevisionSummary): string => {
  if (revision.kind === 'published' && revision.versionNumber !== null) return `v${revision.versionNumber}`
  if (revision.kind === 'candidate') return `Draft · ${timestampFormatter.format(new Date(revision.createdAt))}`
  return 'Legacy revision'
}

/** The URL to copy by hand when the page has no clipboard access (a plain-HTTP host). */
export function UncopiedLink({ url }: { url: string }) {
  return <p role="status" className="break-all rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">Copy this link: <span className="select-all font-mono text-foreground">{url}</span></p>
}

/** Durable private revision tests. Legacy operator sessions remain in TestSessionsView. */
export function TestExecutionHistoryView({
  agentId,
  onOpen,
  linkFor,
}: {
  agentId: string
  onOpen: (execution: TestExecutionHistoryDetail) => void
  /** The dashboard link that opens one saved test; without it the row offers no link. */
  linkFor?: (executionId: string) => string
}) {
  const [executions, setExecutions] = useState<TestExecutionHistoryListItem[] | null>(null)
  const link = useCopyDashboardLink()
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
      <DashboardTableHeader className="w-24 text-right">Messages</DashboardTableHeader>
      <DashboardTableHeader className="w-44">Created</DashboardTableHeader>
      <DashboardTableHeader className="w-36" />
    </DashboardTableHead>
    <DashboardTableBody>
      {executions.map((execution) => <DashboardTableRow key={execution.id}>
        <DashboardTableCell className="max-w-0 font-medium">
          <span className="flex min-w-0 items-center gap-2">
            {execution.firstMessage
              ? <span className="truncate" title={execution.firstMessage}>{execution.firstMessage}</span>
              : <span className="truncate font-normal text-muted-foreground">No messages yet</span>}
            {execution.mode === 'compare' ? <Badge variant="outline" className="shrink-0">Comparison</Badge> : null}
            {execution.skillEffects === 'allowed' ? (
              <Badge variant="outline" className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                Skills ran for real
              </Badge>
            ) : null}
          </span>
          {link.uncopied?.key === execution.id ? <div className="mt-2 font-normal"><UncopiedLink url={link.uncopied.url} /></div> : null}
        </DashboardTableCell>
        <DashboardTableCell className="text-sm text-muted-foreground">{execution.sides.map((side) => revisionLabel(side.revision)).join(' · ')}</DashboardTableCell>
        <DashboardTableCell className="w-24 text-right text-sm tabular-nums text-muted-foreground">{execution.turnCount}</DashboardTableCell>
        <DashboardTableCell className="w-44 text-sm text-muted-foreground">{timestampFormatter.format(new Date(execution.createdAt))}</DashboardTableCell>
        <DashboardTableCell className="w-36 text-right">
          <span className="inline-flex items-center gap-1">
            {linkFor ? (
              <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={link.copiedKey === execution.id ? 'Link copied' : 'Copy link'} title="Copy link" onClick={() => void link.copy(execution.id, linkFor(execution.id))}>
                {link.copiedKey === execution.id ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => void open(execution.id)} disabled={openingId !== null}>{openingId === execution.id ? 'Opening…' : 'Open'}</Button>
          </span>
        </DashboardTableCell>
      </DashboardTableRow>)}
    </DashboardTableBody>
  </DashboardTable>{nextCursor ? <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</Button> : null}</div>
}
