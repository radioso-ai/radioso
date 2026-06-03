'use client'

import { useMemo, useState } from 'react'
import { Minimize2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { ActivityTrace, ConversationTraceStage, TurnTraceEnvelope } from '@/lib/api'
import { envelopeToFlowGraph, type TurnFlowNode } from '@/lib/turn-flow'
import { ActivityTraceDetail } from './activity-trace-detail'
import { SpineStageDetail } from './spine-stage-detail'
import { TurnFlowGraph } from './turn-flow-graph'

function NodeDetail({
  node,
  spineStages,
  leafTrace,
}: {
  node: TurnFlowNode | null
  spineStages: ConversationTraceStage[]
  leafTrace?: ActivityTrace
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
      <SpineStageDetail stage={stage} />
    ) : (
      <p className="text-sm text-muted-foreground">No recorded detail for this stage.</p>
    )
  }
  if (node.detail.kind === 'leaf' && leafTrace) {
    return <ActivityTraceDetail activityTrace={leafTrace} selectedStageId={node.detail.leafStageId} />
  }
  return (
    <div className="space-y-1">
      <p className="text-base font-medium text-foreground">{node.label}</p>
      {node.sublabel ? <p className="text-sm text-muted-foreground">{node.sublabel}</p> : null}
      <p className="text-sm text-muted-foreground">No further detail recorded for this node.</p>
    </div>
  )
}

/**
 * Full-screen turn flow: the whole turn as a left-to-right graph (inputs → engine
 * → skill path → outcome) with a side detail pane. Opened from the drawer header
 * rather than crammed into the inline diagnostics column, so a deep retrieval
 * path has room to be examined.
 */
export function TurnFlowOverlay({
  open,
  envelope,
  leafTrace,
  onClose,
}: {
  open: boolean
  envelope: TurnTraceEnvelope
  leafTrace?: ActivityTrace
  onClose: () => void
}) {
  const graph = useMemo(() => envelopeToFlowGraph(envelope), [envelope])
  const initialNode = useMemo(
    () =>
      graph.nodes.find((node) => node.nodeKind === 'skill') ??
      graph.nodes.find((node) => node.nodeKind === 'engine') ??
      null,
    [graph.nodes],
  )
  const [selectedNode, setSelectedNode] = useState<TurnFlowNode | null>(null)

  if (!open) {
    return null
  }

  const activeNode = selectedNode ?? initialNode

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-foreground">Turn flow</p>
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
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <div className="min-h-0">
          <TurnFlowGraph
            graph={graph}
            selectedNodeId={activeNode?.id}
            onSelectNode={setSelectedNode}
            showMiniMap
          />
        </div>
        <div className="min-h-0 overflow-y-auto border-l border-border p-4">
          <NodeDetail node={activeNode} spineStages={envelope.spine.stages} leafTrace={leafTrace} />
        </div>
      </div>
    </div>
  )
}
