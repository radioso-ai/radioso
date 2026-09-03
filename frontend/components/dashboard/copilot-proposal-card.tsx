'use client'

import { useState } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, ExternalLink, Globe } from 'lucide-react'

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
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  copilotApi,
  isCopilotApiErrorStatus,
  type CopilotEntityReference,
  type CopilotProposalApplyResult,
  type CopilotProposalDetail,
  type CopilotProposalEvidenceCase,
  type CopilotProposalEvidenceSummary,
  type CopilotProposalPreview,
  type CopilotProposalSummary,
  type CopilotProposalStatus,
} from '@/lib/api-copilot'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  createCopilotProposalCardState,
  failCopilotProposalApply,
  optimisticallyApplyCopilotProposal,
  optimisticallyDismissCopilotProposal,
  reconcileCopilotProposalApply,
  reconcileCopilotProposalDetail,
  reconcileCopilotProposalDismiss,
  revertCopilotProposalDismiss,
  type CopilotProposalCardState,
} from '@/lib/copilot-proposal-state'

const STATUS_LABELS: Record<CopilotProposalStatus, string> = {
  pending: 'Pending review',
  applied: 'Applied',
  dismissed: 'Dismissed',
  failed: 'Failed',
  stale: 'Stale',
}

const statusVariant = (status: CopilotProposalStatus) => {
  if (status === 'applied') return 'secondary' as const
  return 'outline' as const
}

const statusBadgeClassName = (status: CopilotProposalStatus) =>
  status === 'failed' || status === 'stale' ? 'border-destructive/40 text-destructive' : undefined

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
)

export interface CopilotProposalDiffRow {
  path: string
  current: unknown
  proposed: unknown
  kind: 'added' | 'changed' | 'removed'
}

const displayPath = (path: string) => path === '$' ? 'Value' : path.replace(/^\$\./, '')

const valuesEqual = (left: unknown, right: unknown) => {
  if (Object.is(left, right)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

const appendDiff = (rows: CopilotProposalDiffRow[], path: string, current: unknown, proposed: unknown) => {
  if (valuesEqual(current, proposed)) return
  if ((current === null || current === undefined) && isRecord(proposed)) {
    const keys = Object.keys(proposed).sort()
    for (const key of keys) appendDiff(rows, `${path}.${key}`, undefined, proposed[key])
    return
  }
  if (isRecord(current) && (proposed === null || proposed === undefined)) {
    for (const key of Object.keys(current).sort()) appendDiff(rows, `${path}.${key}`, current[key], undefined)
    return
  }
  if (isRecord(current) && isRecord(proposed)) {
    const keys = [...new Set([...Object.keys(current), ...Object.keys(proposed)])].sort()
    for (const key of keys) appendDiff(rows, `${path}.${key}`, current[key], proposed[key])
    return
  }
  rows.push({
    path,
    current,
    proposed,
    kind: current === undefined ? 'added' : proposed === undefined ? 'removed' : 'changed',
  })
}

export const buildCopilotProposalDiff = (preview: CopilotProposalPreview): CopilotProposalDiffRow[] => {
  const rows: CopilotProposalDiffRow[] = []
  appendDiff(rows, '$', preview.current, preview.proposed)
  return rows
}

const formatValue = (value: unknown) => {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const targetReference = (
  summary: CopilotProposalSummary,
  detail: CopilotProposalDetail | null,
  appliedRef: Record<string, unknown> | null,
  defaultAgentId?: string | null,
): { entity: CopilotEntityReference; agentId?: string } | null => {
  const ref = detail?.targetRef ?? detail?.target ?? {}
  const applied = appliedRef ?? {}
  const agentId = typeof (applied.agentId ?? ref.agentId ?? defaultAgentId) === 'string' ? String(applied.agentId ?? ref.agentId ?? defaultAgentId) : undefined
  if (summary.targetType === 'agent_setting' || summary.targetType === 'context_variable') {
    const id = agentId
    return id ? { entity: { type: 'agent', id }, agentId: id } : null
  }
  if (summary.targetType === 'routine') {
    const routineId = applied.routineId ?? ref.routineId ?? ref.id
    return typeof routineId === 'string' ? {
      entity: { type: 'routine', id: routineId },
      ...(agentId ? { agentId } : {}),
    } : null
  }
  if (summary.targetType === 'agent_skill') {
    // A skill proposal that has not yet been applied carries a null skillId when it drafts a new
    // skill (the id does not exist until the operator applies it), so no link renders until then.
    const skillId = applied.skillId ?? ref.skillId
    return typeof skillId === 'string' ? {
      entity: { type: 'agent_skill', id: skillId },
      ...(agentId ? { agentId } : {}),
    } : null
  }
  if (summary.targetType === 'document') {
    // Once a removal has been applied there is nothing to open. Keyed off appliedRef rather than
    // the summary's status: after an in-place Apply the card's own state advances while the
    // proposal prop it was rendered from still reads 'pending' until the next reload.
    if (summary.removal === true && applied.documentId !== undefined) return null
    // A create carries a null documentId until it is applied, the same as a drafted skill.
    const documentId = applied.documentId ?? ref.documentId
    return typeof documentId === 'string' ? { entity: { type: 'document', id: documentId } } : null
  }
  if (summary.targetType === 'agent') {
    // The agent does not exist until the proposal is applied, so there is nothing to open before
    // then - the same as a drafted skill or a drafted document.
    const proposedAgentId = applied.agentId
    return typeof proposedAgentId === 'string'
      ? { entity: { type: 'agent', id: proposedAgentId }, agentId: proposedAgentId }
      : null
  }
  if (summary.targetType === 'website_crawl') {
    // A crawl has no target until it is applied and the job resolves a source.
    const sourceId = applied.sourceId
    return typeof sourceId === 'string' ? { entity: { type: 'document_source', id: sourceId } } : null
  }
  if (summary.targetType === 'ingestion_settings') {
    return { entity: { type: 'ingestion_settings' } }
  }
  if (summary.targetType === 'workspace_setting') {
    return { entity: { type: 'workspace_settings' } }
  }
  if (summary.targetType === 'directive') {
    const directiveId = applied.directiveId ?? ref.directiveId ?? ref.id
    return typeof directiveId === 'string' ? {
      entity: { type: 'directive', id: directiveId },
      ...(agentId ? { agentId } : {}),
    } : null
  }
  // A target type with no branch here links nowhere rather than borrowing the directive's.
  return null
}

/**
 * The one sentence the card states about its own status, from every source that can carry one. It
 * takes the summary's reason rather than leaving the call site to fall back to it: the guard
 * deciding whether to render and the span deciding what to render used to apply different
 * fallbacks, so a reason that arrived only on the summary was counted by one and dropped by the
 * other.
 */
const statusMessage = (
  state: CopilotProposalCardState,
  detail: CopilotProposalDetail | null,
  proposalReason?: string | null,
) => {
  if (state.status === 'stale') return 'The target changed since this proposal was drafted. Ask Ray to draft it again.'
  if (state.status === 'failed') return state.reason ?? detail?.reason ?? detail?.failureReason ?? proposalReason ?? 'The proposal could not be applied.'
  // An apply can succeed at the thing the proposal is named for and still leave a step for the
  // operator - creating an agent whose website did not queue is applied, and is not finished.
  if (state.status === 'applied') return state.reason ?? detail?.reason ?? proposalReason ?? null
  return null
}

const statusFromProposalDetail = (detail: CopilotProposalDetail): CopilotProposalStatus =>
  detail.status === 'pending' && !detail.currentVersionMatches ? 'stale' : detail.status

export type CopilotProposalApplyConfirmationKind = 'irreversible-removal' | 'reach-change' | 'reversible-update'

/**
 * What kind of confirmation an Apply click should show. A removal (e.g. propose_directive_removal)
 * permanently deletes its target and cannot be undone, so its confirmation must say so plainly
 * instead of the generic "this updates X" copy every other proposal gets - and it must be
 * knowable from the summary card alone, before the operator ever expands the diff, since Apply is
 * reachable without expanding it. Reads the structural `removal` signal the backend's proposal
 * card already carries, not `summary`'s prose.
 */
export const applyConfirmationKind = (proposal: CopilotProposalSummary): CopilotProposalApplyConfirmationKind => {
  if (proposal.removal) return 'irreversible-removal'
  // Reversible, so not a removal - but it decides who can talk to the agent, which is a different
  // question from whether the wording is right, and the generic "this updates X" copy does not ask
  // it. Same reasoning as the removal branch: read the structural signal, never the prose.
  if (proposal.reach) return 'reach-change'
  return 'reversible-update'
}

export function CopilotProposalCard({
  proposal,
  canApply,
  defaultAgentId,
  onOpenEntity,
}: {
  proposal: CopilotProposalSummary
  canApply: boolean
  defaultAgentId?: string | null
  onOpenEntity: (entity: CopilotEntityReference, agentId?: string) => void
}) {
  const [cardState, setCardState] = useState(() => createCopilotProposalCardState(proposal.status))
  const [detail, setDetail] = useState<CopilotProposalDetail | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const status = cardState.status === 'pending' && proposal.status !== 'pending' ? proposal.status : cardState.status
  const effectiveState = status === cardState.status ? cardState : { ...cardState, status }
  const diff = detail ? buildCopilotProposalDiff(detail.preview) : []
  // The detail read is authoritative; the streamed card only carries the summary until it loads.
  const evidenceSummary = detail?.evidence ?? proposal.evidence
  const entityTarget = targetReference(proposal, detail, effectiveState.appliedRef, defaultAgentId)
  const statusText = statusMessage(effectiveState, detail, proposal.reason)

  const loadDetail = async () => {
    if (detail || isLoadingDetail) return
    setIsLoadingDetail(true)
    setDetailError(null)
    try {
      const nextDetail = await copilotApi.getProposal(proposal.id)
      setDetail(nextDetail)
      setCardState((current) => reconcileCopilotProposalDetail(current, { ...nextDetail, status: statusFromProposalDetail(nextDetail) }))
    } catch (error) {
      setDetailError(getApiErrorMessage(error, 'Could not load the proposed changes.'))
    } finally {
      setIsLoadingDetail(false)
    }
  }

  const reconcileFromServer = async (fallback: string) => {
    try {
      const nextDetail = await copilotApi.getProposal(proposal.id)
      setDetail(nextDetail)
      setCardState((current) => reconcileCopilotProposalDetail(current, { ...nextDetail, status: statusFromProposalDetail(nextDetail) }))
    } catch {
      setCardState((current) => ({ ...current, isApplying: false, status: current.status === 'applied' ? 'failed' : current.status, reason: fallback }))
    }
  }

  const apply = async () => {
    setConfirmOpen(false)
    setCardState((current) => optimisticallyApplyCopilotProposal(current))
    try {
      const result: CopilotProposalApplyResult = await copilotApi.applyProposal(proposal.id)
      setCardState((current) => reconcileCopilotProposalApply(current, result))
    } catch (error) {
      if (isCopilotApiErrorStatus(error, 409)) {
        await reconcileFromServer('This proposal was already resolved.')
        return
      }
      setCardState((current) => failCopilotProposalApply(current, getApiErrorMessage(error, 'The proposal could not be applied.')))
    }
  }

  const dismiss = async () => {
    setCardState((current) => optimisticallyDismissCopilotProposal(current))
    try {
      await copilotApi.dismissProposal(proposal.id)
      setCardState((current) => reconcileCopilotProposalDismiss(current))
    } catch (error) {
      if (isCopilotApiErrorStatus(error, 409)) {
        await reconcileFromServer('This proposal was already resolved.')
        return
      }
      setCardState((current) => revertCopilotProposalDismiss(current, getApiErrorMessage(error, 'The proposal could not be dismissed.')))
    }
  }

  return (
    <Card className="mt-4 border-secondary/50 bg-secondary/5" aria-label={`Proposal: ${proposal.targetLabel}`}>
      <CardHeader className="space-y-2 p-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Proposed change</p>
            <p className="mt-1 truncate text-sm font-medium">{proposal.targetLabel}</p>
          </div>
          <Badge variant={statusVariant(effectiveState.status)} className={statusBadgeClassName(effectiveState.status)}>{STATUS_LABELS[effectiveState.status]}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{proposal.summary}</p>
        {proposal.reach ? (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>Changes who can reach the agent.</span>
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-2">
        {statusText ? (
          <p className={`flex items-start gap-2 text-xs ${effectiveState.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} role="status">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{statusText}</span>
          </p>
        ) : null}
        {evidenceSummary ? <ProposalEvidence summary={evidenceSummary} cases={detail?.evidenceCases ?? null} /> : null}
        {effectiveState.status === 'applied' && entityTarget ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onOpenEntity(entityTarget.entity, entityTarget.agentId)}>
            <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Open {proposal.targetLabel}
            <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
        <Collapsible open={expanded} onOpenChange={(open) => { setExpanded(open); if (open) void loadDetail() }}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" aria-label={`${expanded ? 'Hide' : 'Show'} proposed changes for ${proposal.targetLabel}`}>
              {expanded ? <ChevronDown className="mr-1.5 h-4 w-4" aria-hidden /> : <ChevronRight className="mr-1.5 h-4 w-4" aria-hidden />}
              {expanded ? 'Hide changes' : 'Show changes'}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            {isLoadingDetail ? <p className="text-xs text-muted-foreground">Loading proposed changes…</p> : null}
            {detailError ? <p className="text-xs text-destructive" role="alert">{detailError}</p> : null}
            {detail && diff.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-border/70 text-xs" aria-label="Proposal changes">
                <div className="grid grid-cols-[minmax(5rem,.7fr)_minmax(0,1fr)_minmax(0,1fr)] border-b border-border/70 bg-muted/30 px-3 py-2 font-medium">
                  <span>Field</span><span>Current</span><span>Proposed</span>
                </div>
                {diff.map((row) => (
                  <div className="grid grid-cols-[minmax(5rem,.7fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-border/50 px-3 py-2 last:border-b-0" key={row.path}>
                    <span className="font-medium text-muted-foreground">{displayPath(row.path)}</span>
                    <span className="break-words text-muted-foreground">{formatValue(row.current)}</span>
                    <span className="break-words">{formatValue(row.proposed)}</span>
                  </div>
                ))}
              </div>
            ) : detail && diff.length === 0 ? <p className="text-xs text-muted-foreground">The proposed value matches the current value.</p> : null}
          </CollapsibleContent>
        </Collapsible>
        {effectiveState.status === 'pending' ? (
          <div className="flex flex-wrap gap-2">
            {canApply ? <Button type="button" size="sm" onClick={() => setConfirmOpen(true)} disabled={effectiveState.isApplying || effectiveState.isDismissing}>Apply</Button> : null}
            <Button type="button" variant="outline" size="sm" onClick={() => void dismiss()} disabled={effectiveState.isApplying || effectiveState.isDismissing}>Dismiss</Button>
          </div>
        ) : null}
      </CardContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            {applyConfirmationKind(proposal) === 'irreversible-removal' ? (
              <>
                <AlertDialogTitle>Delete {proposal.targetLabel} permanently?</AlertDialogTitle>
                <AlertDialogDescription>This permanently deletes {proposal.targetLabel}. This cannot be undone.</AlertDialogDescription>
              </>
            ) : applyConfirmationKind(proposal) === 'reach-change' ? (
              <>
                <AlertDialogTitle>Change who can reach the agent?</AlertDialogTitle>
                <AlertDialogDescription>This updates {proposal.targetLabel} and changes which people can reach the agent. You can change it back afterwards.</AlertDialogDescription>
              </>
            ) : (
              <>
                <AlertDialogTitle>Apply this proposal?</AlertDialogTitle>
                <AlertDialogDescription>This updates {proposal.targetLabel} with the proposed values. The target is checked again before the change is written.</AlertDialogDescription>
              </>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void apply()}>Apply proposal</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

const VERDICT_LABELS: Record<CopilotProposalEvidenceCase['after'], string> = {
  pass: 'passed',
  fail: 'failed',
  error: 'errored',
  recorded: 'not scored',
}

const RECORDED_LABELS: Record<CopilotProposalEvidenceCase['before'], string> = {
  pending: 'not yet run',
  passing: 'passing',
  failing: 'failing',
  error: 'errored',
}

/**
 * A replay measures the configuration its eval case froze, never the live agent, so what dates a
 * measurement is the agent being edited after that capture. Saying it ran "before the agent
 * changed" would give the wrong chronology for an old case replayed today.
 */
const staleExplanation = (summary: CopilotProposalEvidenceSummary): string =>
  summary.stale === summary.total
    ? 'These replays measured the configuration each case captured, and this agent has changed since. They may not describe how it behaves now.'
    : `${summary.stale} of these measured a captured configuration the agent has changed since, so they may not describe how it behaves now.`

const evidenceHeadline = (summary: CopilotProposalEvidenceSummary): string => {
  const parts = [`${summary.improved} improved`]
  if (summary.regressed > 0) parts.push(`${summary.regressed} regressed`)
  if (summary.unchanged > 0) parts.push(`${summary.unchanged} unchanged`)
  return parts.join(', ')
}

function ProposalEvidence({
  summary,
  cases,
}: {
  summary: CopilotProposalEvidenceSummary
  cases: CopilotProposalEvidenceCase[] | null
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background/50 p-3" aria-label="Replay evidence">
      <p className="text-xs font-medium">
        Verified against {summary.total} {summary.total === 1 ? 'case' : 'cases'} — {evidenceHeadline(summary)}
      </p>
      {summary.stale > 0 ? (
        <p className="mt-1 flex items-start gap-2 text-xs text-muted-foreground" role="status">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{staleExplanation(summary)}</span>
        </p>
      ) : null}
      {cases && cases.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {cases.map((measurement) => (
            <li className="text-xs text-muted-foreground" key={measurement.runId}>
              <span className="font-medium text-foreground">{measurement.caseName}</span>
              {' — was '}{RECORDED_LABELS[measurement.before]}{', '}{VERDICT_LABELS[measurement.after]}{' with this change'}
              {measurement.stale ? ' (agent changed since this case was captured)' : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
