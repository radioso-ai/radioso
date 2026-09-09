'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { agentRevisionsApi, type AgentRevisionDetail, type AgentRevisionState, type PublishRevisionCommand } from '@/lib/api-agent-revisions'
import { contextVariablesApi } from '@/lib/api-context-variables'
import type { ContextVariable } from '@/lib/api-types'

const statusLabel = (state: AgentRevisionState) => {
  if (state.status === 'unpublished') return 'Private until first publish'
  if (state.status === 'draft_dirty') return 'Draft changes'
  if (state.status === 'published_changed_since_draft') return 'Published changed; review draft'
  return 'Draft matches published'
}

/** A clean saved draft holds the published scoped authoring, so publishing it would allocate a version nobody can tell apart from the live one. */
const hasPublishableChanges = (state: AgentRevisionState) => state.status !== 'draft_clean'

type PublicationCommand = PublishRevisionCommand & { revisionId: string }

const valueLabel = (value: unknown, fallback: string) => {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['name', 'title', 'label']) {
      if (typeof record[key] === 'string' && record[key]) return record[key]
    }
  }
  return fallback
}

const DIFF_FIELDS = ['source', 'surfacing', 'enabled', 'resolverSkillId', 'maxAgeSeconds', 'resolverTimeoutMs', 'action', 'condition', 'priority', 'version', 'activation', 'steps', 'transitions', 'terminals', 'completionExport']

const fieldLabels: Record<string, string> = {
  source: 'Source', surfacing: 'Surfacing', enabled: 'Enabled', resolverSkillId: 'Resolver skill', maxAgeSeconds: 'Maximum age', resolverTimeoutMs: 'Resolver timeout', action: 'Action', condition: 'Condition', priority: 'Priority', version: 'Version', activation: 'Activation', steps: 'Steps', transitions: 'Transitions', terminals: 'Terminal states', completionExport: 'Completion export',
}

const readableValue = (value: unknown) => {
  if (value === null) return 'None'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

const changedFields = (before: unknown, after: unknown) => {
  const beforeRecord = before && typeof before === 'object' ? before as Record<string, unknown> : {}
  const afterRecord = after && typeof after === 'object' ? after as Record<string, unknown> : {}
  return DIFF_FIELDS.filter((field) => field in beforeRecord || field in afterRecord).filter((field) => JSON.stringify(beforeRecord[field]) !== JSON.stringify(afterRecord[field]))
}

function ChangeDetail({ before, after }: { before: unknown; after: unknown }) {
  const fields = changedFields(before, after)
  if (!fields.length) return null
  return <dl className="mt-1 max-h-44 overflow-auto break-words rounded border bg-muted/40 p-2 text-xs">
    <div className="grid gap-1 border-b pb-1 font-medium text-muted-foreground sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]"><dt>Field</dt><dd>Before</dd><dd>After</dd></div>
    {fields.map((field) => <div key={field} className="grid gap-1 py-1 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]"><dt className="font-medium">{fieldLabels[field] ?? field}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{readableValue((before as Record<string, unknown> | undefined)?.[field])}</dd><dd className="whitespace-pre-wrap">{readableValue((after as Record<string, unknown> | undefined)?.[field])}</dd></div>)}
  </dl>
}

export function AgentRevisionHeader({
  agentId,
  saveState,
  canSaveDraft,
  testChatHref,
}: {
  agentId: string
  saveState: 'idle' | 'saved' | 'saving' | 'error'
  canSaveDraft: boolean
  testChatHref: string
}) {
  const [state, setState] = useState<AgentRevisionState | null>(null)
  const [detail, setDetail] = useState<AgentRevisionDetail | null>(null)
  const [catalog, setCatalog] = useState<ContextVariable[]>([])
  const [publicationCommand, setPublicationCommand] = useState<PublicationCommand | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  /** Shared across loadState and review: any new request for this mounted agent supersedes an older one in flight. */
  const agentRequestGeneration = useRef(0)
  const loadState = useCallback(async () => {
    // Bump before the request so an earlier call's response, arriving after a
    // newer one already applied, is recognized as stale and discarded.
    const requestGeneration = ++agentRequestGeneration.current
    try {
      const next = await agentRevisionsApi.getState(agentId)
      if (agentRequestGeneration.current !== requestGeneration) return
      setState(next); setError(null)
    } catch (cause) {
      if (agentRequestGeneration.current !== requestGeneration) return
      setState(null)
      setError(cause instanceof Error ? cause.message : 'Draft publication state is unavailable.')
    }
  }, [agentId])
  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadState() }, 0)
    return () => window.clearTimeout(timeout)
  }, [loadState])
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ agentId?: string }>).detail?.agentId === agentId) void loadState()
    }
    window.addEventListener('radioso:agent-draft-saved', refresh)
    return () => window.removeEventListener('radioso:agent-draft-saved', refresh)
  }, [agentId, loadState])

  const review = async () => {
    if (!state || reviewing || canSaveDraft || !hasPublishableChanges(state)) return
    const requestGeneration = ++agentRequestGeneration.current
    setReviewing(true)
    try {
      const [candidateResult, variablesResult] = await Promise.all([
        agentRevisionsApi.createCandidate(agentId, state.draft.generation),
        contextVariablesApi.listCatalog(),
      ])
      const result = await agentRevisionsApi.getRevision(agentId, candidateResult.candidate.id)
      if (agentRequestGeneration.current !== requestGeneration) return
      setCatalog(variablesResult.contextVariables)
      setDetail(result.revision)
      // This command is deliberately frozen when review opens. A retry after a
      // timeout is the same publication command, not a second publish request.
      setPublicationCommand({
        revisionId: result.revision.id,
        expectedDraftGeneration: state.draft.generation,
        expectedPublishedRevisionId: state.publishedRevision?.id ?? null,
        idempotencyKey: crypto.randomUUID(),
      })
    } catch (cause) {
      if (agentRequestGeneration.current === requestGeneration) setError(cause instanceof Error ? cause.message : 'Unable to load publication review.')
    } finally { if (agentRequestGeneration.current === requestGeneration) setReviewing(false) }
  }
  const publish = async () => {
    if (!detail || !publicationCommand) return
    setPublishing(true)
    try {
      const result = await agentRevisionsApi.publish(agentId, publicationCommand.revisionId, publicationCommand)
      setState(result.state)
      setDetail(null)
      setPublicationCommand(null)
      window.dispatchEvent(new CustomEvent('radioso:agent-draft-saved', { detail: { agentId } }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publication failed. Retry this same publication or cancel the review.')
    }
    finally { setPublishing(false) }
  }

  return <>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-muted-foreground">{state ? statusLabel(state) : 'Loading draft status…'}</span>
      {saveState === 'saving' ? <span className="text-muted-foreground">Saving settings…</span> : null}
      {canSaveDraft && saveState !== 'saving' ? <span className="text-amber-700 dark:text-amber-300">Unsaved changes</span> : null}
      {saveState === 'error' ? <span className="text-destructive">Draft save needs attention</span> : null}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {canSaveDraft ? <Button type="button" size="sm" variant="outline" disabled={saveState === 'saving'} onClick={() => window.dispatchEvent(new CustomEvent('radioso:save-agent-draft', { detail: { agentId } }))}>Save draft</Button> : null}
      {!canSaveDraft && state?.canPublish ? <Button type="button" size="sm" onClick={() => void review()} disabled={reviewing || !hasPublishableChanges(state)} title={hasPublishableChanges(state) ? 'Review saved draft before publishing' : 'The saved draft already matches the published revision'}>{reviewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Review &amp; publish</Button> : null}
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) { setDetail(null); setPublicationCommand(null) } }}><DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-hidden"><DialogHeader><DialogTitle>Review draft publication</DialogTitle><DialogDescription>{detail?.label} is immutable. Publishing changes the revision used for new conversations; existing conversations keep their current revision.</DialogDescription></DialogHeader>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{detail ? <div className="max-h-[60vh] space-y-3 overflow-y-auto break-words pr-1 text-sm"><section className="rounded-md bg-muted/40 p-3"><p className="font-medium">What changes</p><ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground"><li>Only saved draft instructions, directives, routines, and context enablements are included.</li><li>Live channel, skill, name, model, answer, and branding settings are not included.</li></ul></section><section><p className="font-medium">Custom instructions</p>{detail.scopedChanges.customInstruction.changed ? <div className="mt-1 space-y-2 text-xs"><div className="max-h-28 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2"><p className="mb-1 font-medium text-muted-foreground">Before</p>{detail.scopedChanges.customInstruction.before ?? 'None'}</div><div className="max-h-28 overflow-auto whitespace-pre-wrap rounded border p-2"><p className="mb-1 font-medium text-muted-foreground">After</p>{detail.scopedChanges.customInstruction.after ?? 'None'}</div></div> : <p className="text-muted-foreground">Unchanged</p>}</section><section><p className="font-medium">Directives</p><ul className="space-y-2">{detail.scopedChanges.directives.length ? detail.scopedChanges.directives.map((change) => <li key={`${change.id}-${change.change}`}><span className="font-medium">{valueLabel(change.after ?? change.before, change.id)}</span> ({change.change})<ChangeDetail before={change.before} after={change.after} /></li>) : <li className="text-muted-foreground">Unchanged</li>}</ul></section><section><p className="font-medium">Routines</p><ul className="space-y-2">{detail.scopedChanges.routines.length ? detail.scopedChanges.routines.map((change) => <li key={`${change.definitionId}-${change.change}`}><span className="font-medium">{valueLabel(change.after ?? change.before, change.definitionId)}</span> ({change.change})<ChangeDetail before={change.before} after={change.after} /></li>) : <li className="text-muted-foreground">Unchanged</li>}</ul></section><section><p className="font-medium">Context selections</p><ul className="space-y-2">{detail.scopedChanges.contextVariableEnablements.length ? detail.scopedChanges.contextVariableEnablements.map((change) => <li key={`${change.contextVariableId}-${change.change}`}><span className="font-medium">{catalog.find((variable) => variable.id === change.contextVariableId)?.name ?? change.contextVariableId}</span> ({change.change})<ChangeDetail before={change.before} after={change.after} /></li>) : <li className="text-muted-foreground">Unchanged</li>}</ul></section><section className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">Evidence for this candidate</p><p className="mt-1 text-muted-foreground">No evidence loaded for this revision. <Link className="underline" href={testChatHref}>Test in Test Chat</Link>; optional tests never block publication.</p></section>{detail.dependencyWarnings.map((warning) => <p key={warning.code} className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-100">{warning.message}</p>)}</div> : null}<DialogFooter><Button variant="outline" onClick={() => { setDetail(null); setPublicationCommand(null) }} disabled={publishing}>Cancel</Button><Button onClick={() => void publish()} disabled={publishing}>{publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Publish revision</Button></DialogFooter></DialogContent></Dialog>
  </>
}
