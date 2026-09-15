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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LogoSpinner } from '@/components/ui/spinner'
import { agentRevisionsApi, type AgentRevisionDetail, type AgentRevisionSummary } from '@/lib/api-agent-revisions'

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const revisionLabel = (revision: AgentRevisionSummary) =>
  revision.versionNumber === null ? revision.label : `v${revision.versionNumber}`

const changeSummary = (revision: AgentRevisionDetail) => {
  const changes = [
    revision.scopedChanges.customInstruction.changed ? 'instructions' : null,
    revision.scopedChanges.directives.length ? `${revision.scopedChanges.directives.length} directive${revision.scopedChanges.directives.length === 1 ? '' : 's'}` : null,
    revision.scopedChanges.routines.length ? `${revision.scopedChanges.routines.length} routine${revision.scopedChanges.routines.length === 1 ? '' : 's'}` : null,
    revision.scopedChanges.contextVariableEnablements.length ? `${revision.scopedChanges.contextVariableEnablements.length} context setting${revision.scopedChanges.contextVariableEnablements.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  return changes.length ? changes.join(' · ') : 'No scoped authoring changes recorded'
}

/** Immutable, published agent versions. Test conversations link to these versions but do not own their changelog. */
export function AgentRevisionHistory({ agentId }: { agentId: string }) {
  const [revisions, setRevisions] = useState<AgentRevisionSummary[] | null>(null)
  const [selected, setSelected] = useState<AgentRevisionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [reloadGeneration, setReloadGeneration] = useState(0)
  const listRequestGeneration = useRef(0)
  const detailRequestGeneration = useRef(0)

  useEffect(() => {
    let cancelled = false
    const generation = ++listRequestGeneration.current
    void agentRevisionsApi.listPublished(agentId)
      .then(({ revisions: next }) => {
        if (cancelled || listRequestGeneration.current !== generation) return
        setRevisions(next)
        setError(null)
      })
      .catch((cause) => {
        if (!cancelled && listRequestGeneration.current === generation) {
          setError(cause instanceof Error ? cause.message : 'Could not load agent changes.')
        }
      })
    return () => { cancelled = true }
  }, [agentId, reloadGeneration])

  const open = async (revisionId: string) => {
    const generation = ++detailRequestGeneration.current
    setOpeningId(revisionId)
    setError(null)
    try {
      const { revision } = await agentRevisionsApi.getRevision(agentId, revisionId)
      if (detailRequestGeneration.current === generation) {
        setSelected(revision)
        setError(null)
      }
    } catch (cause) {
      if (detailRequestGeneration.current === generation) {
        setError(cause instanceof Error ? cause.message : 'Could not load this version.')
      }
    } finally {
      if (detailRequestGeneration.current === generation) setOpeningId(null)
    }
  }

  if (revisions === null) {
    if (error) {
      return <div className="space-y-3 p-6"><p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p><Button variant="outline" onClick={() => { setError(null); setReloadGeneration((generation) => generation + 1) }}>Retry</Button></div>
    }
    return <div className="flex justify-center p-10"><LogoSpinner imageClassName="h-7 w-7" /></div>
  }

  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Published versions are immutable. Open a version to see exactly what changed.</p>
    {error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
    {revisions.length === 0 ? <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">No published versions yet. Publish a saved draft to create the first version.</p> : <DashboardTable minWidth="min-w-0">
      <DashboardTableHead>
        <DashboardTableHeader>Version</DashboardTableHeader>
        <DashboardTableHeader className="w-52">Published</DashboardTableHeader>
        <DashboardTableHeader className="w-28" />
      </DashboardTableHead>
      <DashboardTableBody>
        {revisions.map((revision) => <DashboardTableRow key={revision.id}>
          <DashboardTableCell className="font-medium">{revisionLabel(revision)}</DashboardTableCell>
          <DashboardTableCell className="w-52 text-sm text-muted-foreground">{revision.publishedAt ? timestampFormatter.format(new Date(revision.publishedAt)) : 'Not published'}</DashboardTableCell>
          <DashboardTableCell className="w-28 text-right"><Button size="sm" variant="outline" onClick={() => void open(revision.id)} disabled={openingId !== null}>{openingId === revision.id ? 'Opening…' : 'View changes'}</Button></DashboardTableCell>
        </DashboardTableRow>)}
      </DashboardTableBody>
    </DashboardTable>}
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{selected ? `${revisionLabel(selected)} changes` : 'Version changes'}</DialogTitle>
          <DialogDescription>{selected?.publishedAt ? `Published ${timestampFormatter.format(new Date(selected.publishedAt))}` : 'Saved version'}</DialogDescription>
        </DialogHeader>
        {selected ? <div className="space-y-4 text-sm">
          <p className="font-medium">{changeSummary(selected)}</p>
          {selected.scopedChanges.customInstruction.changed ? <section><h3 className="font-medium">Instructions</h3><div className="mt-1 grid gap-2 text-xs sm:grid-cols-2"><div className="rounded border bg-muted/40 p-2"><p className="mb-1 font-medium text-muted-foreground">Before</p><p className="whitespace-pre-wrap">{selected.scopedChanges.customInstruction.before ?? 'None'}</p></div><div className="rounded border p-2"><p className="mb-1 font-medium text-muted-foreground">After</p><p className="whitespace-pre-wrap">{selected.scopedChanges.customInstruction.after ?? 'None'}</p></div></div></section> : null}
          {selected.scopedChanges.directives.length ? <section><h3 className="font-medium">Directives</h3><ul className="mt-1 space-y-1 text-muted-foreground">{selected.scopedChanges.directives.map((change) => <li key={`${change.id}-${change.change}`}>{change.change}: {change.id}</li>)}</ul></section> : null}
          {selected.scopedChanges.routines.length ? <section><h3 className="font-medium">Routines</h3><ul className="mt-1 space-y-1 text-muted-foreground">{selected.scopedChanges.routines.map((change) => <li key={`${change.definitionId}-${change.change}`}>{change.change}: {change.definitionId}</li>)}</ul></section> : null}
          {selected.scopedChanges.contextVariableEnablements.length ? <section><h3 className="font-medium">Context</h3><ul className="mt-1 space-y-1 text-muted-foreground">{selected.scopedChanges.contextVariableEnablements.map((change) => <li key={`${change.contextVariableId}-${change.change}`}>{change.change}: {change.contextVariableId}</li>)}</ul></section> : null}
        </div> : null}
      </DialogContent>
    </Dialog>
  </div>
}
