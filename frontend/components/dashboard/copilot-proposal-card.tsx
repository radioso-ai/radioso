'use client'

import { useState } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'

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

const targetReference = (
  summary: CopilotProposalSummary,
  detail: CopilotProposalDetail | null,
  appliedRef: Record<string, unknown> | null,
  defaultAgentId?: string | null,
): { entity: CopilotEntityReference; agentId?: string } | null => {
  const ref = detail?.targetRef ?? detail?.target ?? {}
  const applied = appliedRef ?? {}
  const agentId = typeof (applied.agentId ?? ref.agentId ?? defaultAgentId) === 'string' ? String(applied.agentId ?? ref.agentId ?? defaultAgentId) : undefined
  if (summary.targetType === 'agent_setting') {
    const id = agentId
    return id ? { entity: { type: 'agent', id }, agentId: id } : null
  }
  const directiveId = applied.directiveId ?? ref.directiveId ?? ref.id
  return typeof directiveId === 'string' ? {
    entity: { type: 'directive', id: directiveId },
    ...(agentId ? { agentId } : {}),
  } : null
}

const statusMessage = (state: CopilotProposalCardState, detail: CopilotProposalDetail | null) => {
  if (state.status === 'stale') return 'The target changed since this proposal was drafted. Ask Copilot to draft it again.'
  if (state.status === 'failed') return state.reason ?? detail?.reason ?? detail?.failureReason ?? 'The proposal could not be applied.'
  return null
}

const statusFromProposalDetail = (detail: CopilotProposalDetail): CopilotProposalStatus =>
  detail.status === 'pending' && !detail.currentVersionMatches ? 'stale' : detail.status

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
  const entityTarget = targetReference(proposal, detail, effectiveState.appliedRef, defaultAgentId)

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
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-2">
        {statusMessage(effectiveState, detail) ?? (effectiveState.status === 'failed' ? proposal.reason : null) ? (
          <p className={`flex items-start gap-2 text-xs ${effectiveState.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} role="status">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{statusMessage(effectiveState, detail) ?? proposal.reason}</span>
          </p>
        ) : null}
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
            <AlertDialogTitle>Apply this proposal?</AlertDialogTitle>
            <AlertDialogDescription>This updates {proposal.targetLabel} with the proposed values. The target is checked again before the change is written.</AlertDialogDescription>
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
