'use client'

import { useMemo, useState } from 'react'
import { Minimize2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { ActivityTrace, ConversationTraceStage, TurnTraceEnvelope } from '@/lib/api'
import { formatStageDuration } from '@/lib/activity-stage-presentation'
import { envelopeToFlowGraph, leafTraceFor, type TurnFlowNode, type TurnFlowTotals } from '@/lib/turn-flow'
import { ActivityTraceDetail } from './activity-trace-detail'
import {
  readDirectiveAdherence,
  SpineStageDetail,
  type ConversationMessageRecord,
  type DirectiveAdherenceDetail,
} from './spine-stage-detail'
import { TurnFlowGraph } from './turn-flow-graph'

function NodeDetail({
  node,
  spineStages,
  leafTrace,
  messages,
  assistantMessageId,
  directiveAdherence,
}: {
  node: TurnFlowNode | null
  spineStages: ConversationTraceStage[]
  leafTrace?: ActivityTrace
  messages?: ConversationMessageRecord[]
  assistantMessageId?: string
  directiveAdherence?: DirectiveAdherenceDetail[]
}) {
  if (!node) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        Select a node to inspect it.
      </div>
    )
  }
  if (node.detail.kind === 'spine') {
    const { spineStageId } = node.detail
    const stage = spineStages.find((candidate) => candidate.id === spineStageId)
    return stage ? (
      <SpineStageDetail
        stage={stage}
        messages={messages}
        assistantMessageId={assistantMessageId}
        directiveAdherence={directiveAdherence}
      />
    ) : (
      <p className="text-sm text-muted-foreground">No recorded detail for this stage.</p>
    )
  }
  const nodeLeafTrace = node.detail.kind === 'leaf' ? leafTraceFor(node.detail, spineStages, leafTrace) : undefined
  if (node.detail.kind === 'leaf' && nodeLeafTrace) {
    return <ActivityTraceDetail activityTrace={nodeLeafTrace} selectedStageId={node.detail.leafStageId} />
  }
  return (
    <div className="space-y-1">
      <p className="text-base font-medium text-foreground">{node.label}</p>
      {node.sublabel ? <p className="text-sm text-muted-foreground">{node.sublabel}</p> : null}
      <p className="text-sm text-muted-foreground">No further detail recorded for this node.</p>
    </div>
  )
}

/** The turn's model-call collection has no step of its own; its totals open it. */
export const modelCallsDetailNode = (totals: TurnFlowTotals | undefined): TurnFlowNode | null =>
  totals?.modelCallsStageId
    ? {
        id: 'totals:model_calls',
        nodeKind: 'stage',
        label: 'Model calls',
        tone: 'neutral',
        detail: { kind: 'spine', spineStageId: totals.modelCallsStageId },
      }
    : null

export function TurnFlowTotalsSummary({
  totals,
  selected,
  onSelectModelCalls,
}: {
  totals?: TurnFlowTotals
  selected: boolean
  onSelectModelCalls?: () => void
}) {
  if (!totals) return null
  const calls = totals.modelCallCount
  const recorded = totals.recordedModelCallCount
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {totals.totalMs !== undefined ? <span className="font-mono tabular-nums">{formatStageDuration(totals.totalMs)}</span> : null}
      {calls !== undefined ? (
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground ${selected ? 'bg-muted text-foreground' : ''}`}
          disabled={!onSelectModelCalls}
          onClick={onSelectModelCalls}
        >
          {calls} model call{calls === 1 ? '' : 's'}
          {recorded !== undefined && recorded !== calls ? ` (${recorded} recorded)` : ''}
          {totals.modelTimeMs !== undefined ? ` · ${formatStageDuration(totals.modelTimeMs)}` : ''}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Full-screen turn flow: the whole turn as a top-to-bottom progression
 * (understand → the skill or routine that acted → answer → verdict) with a side
 * detail pane. Opened from the drawer header rather than crammed into the
 * inline diagnostics column, so a deep retrieval path has room to be examined.
 *
 * Rendered as its own modal Radix layer so the sheet or drawer that opened it
 * keeps treating clicks on the graph as inside interaction: while the flow is on
 * top, only the flow reacts to Escape and to pointer-downs, and closing it hands
 * control back to the host with its debug state intact.
 */
export function TurnFlowOverlay({
  open,
  envelope,
  leafTrace,
  onClose,
  messages,
  assistantMessageId,
}: {
  open: boolean
  envelope: TurnTraceEnvelope
  leafTrace?: ActivityTrace
  onClose: () => void
  /**
   * The drawer's already-loaded conversation messages. The trace carries only
   * structural references (event/message IDs, role, length); the spine detail
   * renderers join back to these records to show the actual user/history/answer
   * text, so raw content stays out of audit/debug surfaces.
   */
  messages?: ConversationMessageRecord[]
  /** The assistant message this turn produced, used to resolve the compose answer. */
  assistantMessageId?: string
}) {
  const graph = useMemo(() => envelopeToFlowGraph(envelope, { messages }), [envelope, messages])
  // The detail pane opens on the message the visitor sent, at the top of the
  // progression.
  const initialNode = useMemo(
    () => graph.nodes.find((node) => node.id === 'input:message') ?? graph.nodes[0] ?? null,
    [graph.nodes],
  )
  const modelCallsNode = useMemo(() => modelCallsDetailNode(graph.totals), [graph.totals])
  const [selectedNode, setSelectedNode] = useState<TurnFlowNode | null>(null)

  if (!open) {
    return null
  }

  const activeNode = selectedNode ?? initialNode
  const rawDirectiveAdherence = envelope.spine.stages.find((stage) => stage.kind === 'compose')?.outputs?.adherence
  const directiveAdherence = readDirectiveAdherence(rawDirectiveAdherence)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 left-0 z-[60] flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 shadow-none sm:max-w-none"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <DialogTitle className="text-sm font-medium text-foreground">Turn flow</DialogTitle>
            <TurnFlowTotalsSummary
              totals={graph.totals}
              selected={activeNode?.id === modelCallsNode?.id}
              onSelectModelCalls={modelCallsNode ? () => setSelectedNode(modelCallsNode) : undefined}
            />
          </div>
          <DialogDescription className="sr-only">
            The turn as a graph with a detail pane for the selected node.
          </DialogDescription>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            aria-label="Close turn flow"
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
              selectedNodeId={activeNode?.id}
              onSelectNode={setSelectedNode}
            />
          </div>
          <div data-testid="turn-flow-stage-detail" className="min-h-0 overflow-y-auto border-l border-border p-4">
            <NodeDetail
              node={activeNode}
              spineStages={envelope.spine.stages}
              leafTrace={leafTrace}
              messages={messages}
              assistantMessageId={assistantMessageId}
              directiveAdherence={directiveAdherence}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
