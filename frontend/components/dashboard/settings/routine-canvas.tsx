'use client'

import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, Waypoints } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useTheme } from '@/components/theme-provider'
import { layoutFlowGraph } from '@/lib/turn-flow-layout'
import {
  routineBlockDocToFlowGraph,
  type RoutineFlowGraph,
  type RoutineFlowNode,
} from '@/lib/routine-flow'
import { branchDecisionLabel } from '@/lib/routine-document'
import { routineToBlockDoc } from '@/lib/routine-prose'
import type { RoutineDefinitionDraft } from '@/lib/api'

/**
 * Read-only map of one routine. It answers "what will this routine do, and where can
 * it vary" — "what did it do" is the conversation debug panel's job, over the per-turn
 * routine trace.
 *
 * It opens on demand rather than sitting above the document: a routine being written
 * is one step and an ending, and a graph of that is a lot of surface for very little
 * shape. Opening it gives the graph the whole viewport width, which is what a
 * left-to-right flow wants anyway.
 *
 * Split like the turn flow: `RoutineCanvasGraph` is pure presentation, this file's
 * outer component owns selection and the inspector.
 */

const NODE_SIZE: Record<RoutineFlowNode['nodeKind'], { width: number; height: number }> = {
  activation: { width: 216, height: 60 },
  step: { width: 200, height: 92 },
  ending: { width: 168, height: 62 },
  unresolved: { width: 168, height: 62 },
}

const STEP_ACCENT: Record<string, string> = {
  chat: 'bg-primary',
  tool: 'bg-muted-foreground/60',
  approval: 'bg-sky-500',
  action: 'bg-foreground/70',
}

const EDGE_COLOR = {
  rule: 'var(--muted-foreground, #94a3b8)',
  judgment: 'var(--chart-2, #bf8a00)',
  escalate: 'var(--chart-3, #1e3df1)',
  unresolved: 'var(--destructive, #dc2626)',
}

const LANE_PADDING = 24
const LANE_LABEL_SPACE = 22

type CanvasNodeData = RoutineFlowNode & { isSelected?: boolean; isFaded?: boolean; [key: string]: unknown }

const shellClass = (data: CanvasNodeData, base: string) =>
  `${base} ${data.isSelected ? 'ring-2 ring-primary' : ''} ${data.isFaded ? 'opacity-50' : ''}`

function StepCard({ data }: NodeProps<Node<CanvasNodeData>>) {
  return (
    <div className={shellClass(data, 'h-full w-full overflow-hidden rounded-lg border border-border bg-background shadow-sm transition')}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      {/* A back edge re-enters from the top so a bounded retry reads as a loop. */}
      <Handle type="target" position={Position.Top} id="loop" className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <div className={`h-[3px] ${STEP_ACCENT[data.stepKind ?? ''] ?? 'bg-border'}`} />
      <div className="px-3 py-2">
        <span className="text-[9px] font-bold uppercase tracking-[0.09em] text-muted-foreground">{data.stepKind}</span>
        <p className="mt-0.5 truncate font-mono text-xs font-semibold text-foreground">{data.label}</p>
        <p className="line-clamp-2 text-[11px] text-muted-foreground">{data.sublabel}</p>
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  )
}

function EndingCard({ data }: NodeProps<Node<CanvasNodeData>>) {
  const handoff = data.terminalKind === 'handoff'
  return (
    <div className={shellClass(data, `h-full w-full rounded-lg border px-3 py-2 transition ${handoff ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-border bg-background'}`)}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <p className="truncate text-xs font-semibold text-foreground">{data.label}</p>
      <p className="line-clamp-2 text-[11px] text-muted-foreground">{data.sublabel}</p>
    </div>
  )
}

function UnresolvedCard({ data }: NodeProps<Node<CanvasNodeData>>) {
  return (
    <div className={shellClass(data, 'h-full w-full rounded-lg border border-dashed border-destructive/60 bg-destructive/5 px-3 py-2 transition')}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.09em] text-destructive">
        <AlertTriangle className="h-3 w-3" />missing
      </span>
      <p className="truncate font-mono text-xs font-semibold text-foreground">{data.label}</p>
    </div>
  )
}

function ActivationCard({ data }: NodeProps<Node<CanvasNodeData>>) {
  return (
    <div className={shellClass(data, 'flex h-full w-full flex-col justify-center rounded-full border border-dashed border-border bg-background px-4 transition')}>
      <span className="text-[9px] font-bold uppercase tracking-[0.09em] text-muted-foreground">{data.label}</span>
      <p className="line-clamp-2 text-[11px] text-foreground">{data.sublabel || 'No trigger described yet.'}</p>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  )
}

function LaneCard() {
  return (
    <div className="pointer-events-none relative h-full w-full rounded-xl border border-dashed border-sky-500/30 bg-sky-500/[0.04]">
      <span className="absolute left-3 top-1.5 text-[10px] font-medium uppercase tracking-wide text-sky-600/80">
        turn spine · always on
      </span>
    </div>
  )
}

const nodeTypes = {
  routineStep: StepCard,
  routineEnding: EndingCard,
  routineUnresolved: UnresolvedCard,
  routineActivation: ActivationCard,
  lane: LaneCard,
}

const NODE_TYPE: Record<RoutineFlowNode['nodeKind'], string> = {
  activation: 'routineActivation',
  step: 'routineStep',
  ending: 'routineEnding',
  unresolved: 'routineUnresolved',
}

/**
 * Pure presentation. `showConditions` floats every guard sentence over the graph;
 * otherwise only the branches the model decides are labelled, because a rule is the
 * expectation and labelling all of them is chrome without information.
 */
function RoutineCanvasGraph({
  graph,
  showConditions,
  selectedNodeId,
  onSelectNode,
}: {
  graph: RoutineFlowGraph
  showConditions: boolean
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
}) {
  const { resolvedTheme } = useTheme()

  const { nodes, edges } = useMemo(() => {
    const positions = layoutFlowGraph(
      graph.nodes.map((node) => ({ id: node.id, ...NODE_SIZE[node.nodeKind] })),
      graph.edges,
      { rankdir: 'LR', nodesep: 26, ranksep: 62, margin: 24 },
    )

    // The turn-spine lane, built like the capability lane in the turn flow: one
    // bounding box behind the nodes it contains.
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const node of graph.nodes) {
      const box = positions.get(node.id)
      if (!box) continue
      bounds.minX = Math.min(bounds.minX, box.x)
      bounds.minY = Math.min(bounds.minY, box.y)
      bounds.maxX = Math.max(bounds.maxX, box.x + box.width)
      bounds.maxY = Math.max(bounds.maxY, box.y + box.height)
    }
    const laneNodes: Node[] = Number.isFinite(bounds.minX)
      ? [{
          id: 'lane:turn-spine',
          type: 'lane',
          position: { x: bounds.minX - LANE_PADDING, y: bounds.minY - LANE_PADDING - LANE_LABEL_SPACE },
          data: {},
          draggable: false,
          selectable: false,
          zIndex: 0,
          style: {
            width: bounds.maxX - bounds.minX + LANE_PADDING * 2,
            height: bounds.maxY - bounds.minY + LANE_PADDING * 2 + LANE_LABEL_SPACE,
          },
        }]
      : []

    const flowNodes: Node<CanvasNodeData>[] = graph.nodes.map((node) => {
      const box = positions.get(node.id) ?? { x: 0, y: 0, ...NODE_SIZE[node.nodeKind] }
      return {
        id: node.id,
        type: NODE_TYPE[node.nodeKind],
        position: { x: box.x, y: box.y },
        data: {
          ...node,
          isSelected: node.id === selectedNodeId,
          isFaded: showConditions && node.id !== selectedNodeId,
        },
        draggable: false,
        zIndex: 1,
        style: { width: box.width, height: box.height },
      }
    })

    const flowEdges: Edge[] = graph.edges.map((edge) => {
      const stroke = edge.unresolved
        ? EDGE_COLOR.unresolved
        : edge.provenance === 'judgment'
          ? EDGE_COLOR.judgment
          : edge.escalates
            ? EDGE_COLOR.escalate
            : EDGE_COLOR.rule
      const decision = edge.guardKind ? branchDecisionLabel(edge.guardKind) : ''
      const label = showConditions
        ? (edge.isDecision ? `${decision} · ${edge.sentence}` : undefined)
        : (edge.provenance === 'judgment' ? decision : undefined)
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        targetHandle: edge.selfLoop ? 'loop' : undefined,
        type: 'smoothstep',
        label,
        labelShowBg: true,
        labelBgPadding: [5, 2],
        labelBgBorderRadius: 5,
        labelBgStyle: { fill: 'var(--background, #fff)', stroke, strokeWidth: 1 },
        labelStyle: { fill: stroke, fontSize: 10, fontWeight: 500 },
        // Edges draw below nodes; raise them when the labels carry the conditions, or a
        // sentence disappears behind the card it points at.
        zIndex: showConditions ? 1000 : 0,
        style: {
          stroke,
          strokeWidth: edge.provenance === 'judgment' ? 2 : 1.4,
          strokeDasharray: edge.provenance === 'judgment' || edge.unresolved ? '5 3' : undefined,
          opacity: edge.source === 'activation' ? 0.5 : 1,
        },
      }
    })

    return { nodes: [...laneNodes, ...flowNodes], edges: flowEdges }
  }, [graph, showConditions, selectedNodeId])

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type !== 'lane') onSelectNode(node.id)
    },
    [onSelectNode],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1.2 }}
      minZoom={0.4}
      maxZoom={1.6}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={onNodeClick}
    >
      <Background gap={18} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

function Inspector({ graph, nodeId }: { graph: RoutineFlowGraph; nodeId: string | null }) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) {
    return (
      <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
        Select a step to inspect it.
      </p>
    )
  }
  const exits = graph.edges.filter((edge) => edge.source === node.id)
  return (
    <div className="space-y-3 text-xs">
      <div>
        <p className={node.nodeKind === 'step' ? 'font-mono text-sm font-semibold' : 'text-sm font-semibold'}>{node.label}</p>
        {node.sublabel ? <p className="mt-0.5 text-muted-foreground">{node.sublabel}</p> : null}
      </div>
      {node.skillRef ? <p className="text-muted-foreground">Skill <span className="font-mono text-foreground">{node.skillRef}</span></p> : null}
      {node.actionType ? <p className="text-muted-foreground">Action <span className="font-mono text-foreground">{node.actionType}</span></p> : null}
      {node.collects.length ? (
        <p className="text-muted-foreground">Collects <span className="font-mono text-foreground">{node.collects.join(', ')}</span></p>
      ) : null}
      {node.approvalOptionCount ? <p className="text-muted-foreground">{node.approvalOptionCount} options</p> : null}
      {exits.length ? (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Exits · in order</p>
          <ul className="divide-y divide-border">
            {exits.map((edge) => (
              <li key={edge.id} className="flex items-baseline gap-2 py-1.5">
                <Badge variant="outline" className={`shrink-0 border-border bg-transparent text-[9px] font-normal ${edge.provenance === 'judgment' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                  {edge.guardKind ? branchDecisionLabel(edge.guardKind) : 'Entry'}
                </Badge>
                <span className="text-muted-foreground">
                  {edge.sentence ? `${edge.sentence} → ` : ''}
                  <span className="font-mono text-foreground">{edge.target.replace(/^(step|ending|unresolved):/, '')}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function MapBody({ draft }: { draft: RoutineDefinitionDraft }) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showConditions, setShowConditions] = useState(false)

  const result = useMemo(() => routineToBlockDoc(draft), [draft])
  const graph = useMemo(() => (result.ok ? routineBlockDocToFlowGraph(result.doc) : null), [result])

  if (!graph) {
    return (
      <div className="p-5">
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          This routine cannot be drawn yet. Resolve the notes on the document and it will appear.
        </div>
      </div>
    )
  }

  const { total, rules } = graph.decisionCounts
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <RoutineCanvasGraph
            graph={graph}
            showConditions={showConditions}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        </div>
        <div className="w-72 shrink-0 overflow-y-auto border-l border-border p-4">
          <Inspector graph={graph} nodeId={selectedNodeId} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width="20" height="8" aria-hidden><line x1="1" y1="4" x2="19" y2="4" stroke="currentColor" strokeWidth="1.5" /></svg>
          Rule
        </span>
        <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <svg width="20" height="8" aria-hidden><line x1="1" y1="4" x2="19" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="5 3" /></svg>
          AI decides
        </span>
        {total > 0 ? (
          <span><span className="font-semibold text-foreground">{rules} of {total}</span> branch decisions are rules</span>
        ) : null}
        {graph.uncollectedSlotKeys.length ? (
          <span className="text-amber-600 dark:text-amber-400">
            never collected: <span className="font-mono">{graph.uncollectedSlotKeys.join(', ')}</span>
          </span>
        ) : null}
        <span className="ml-auto">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={showConditions}
            onClick={() => setShowConditions((current) => !current)}
          >
            Show conditions
          </Button>
        </span>
      </div>
    </>
  )
}

export function RoutineMapButton({ draft }: { draft: RoutineDefinitionDraft }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Waypoints className="mr-1 h-4 w-4" />
        Map
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="h-[78vh] gap-0 p-0">
          <SheetHeader className="border-b border-border p-5 pr-12">
            <SheetTitle className="flex items-center gap-2 text-base font-medium">
              <Waypoints className="h-4 w-4 text-muted-foreground" />
              Map
            </SheetTitle>
            <SheetDescription>
              Every step and ending, and the branches between them. A dashed line is a branch the model decides.
            </SheetDescription>
          </SheetHeader>
          {/* The graph is only worth projecting while someone is looking at it. */}
          {open ? <MapBody draft={draft} /> : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
