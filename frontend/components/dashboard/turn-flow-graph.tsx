'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { useTheme } from '@/components/theme-provider'
import { formatStageDuration } from '@/lib/activity-stage-presentation'
import {
  foldTurnFlowGroups,
  type FlowTone,
  type TurnFlowGraph as TurnFlowGraphModel,
  type TurnFlowNode,
} from '@/lib/turn-flow'
import { FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH, layoutTurnFlow } from '@/lib/turn-flow-layout'

const TONE_DOT: Partial<Record<FlowTone, string>> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
}

const TONE_NOTE: Partial<Record<FlowTone, string>> = {
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
}

const OUTCOME_ACCENT: Record<FlowTone, string> = {
  good: 'border-emerald-500/50 bg-emerald-500/10',
  warn: 'border-amber-500/50 bg-amber-500/10',
  bad: 'border-red-500/50 bg-red-500/10',
  neutral: 'border-border bg-muted/40',
  muted: 'border-border bg-muted/40',
}

const KIND_ACCENT: Record<Exclude<TurnFlowNode['nodeKind'], 'outcome'>, string> = {
  input: 'border-border/70 bg-muted/40',
  skill: 'border-sky-500/40 bg-sky-500/10',
  stage: 'border-border/70 bg-background',
}

// Left gutter that carries each phase's name and time.
const BAND_GUTTER = 136
const BAND_PADDING = 22

const FIT_VIEW = { padding: 0.12, minZoom: 0.7, maxZoom: 1 }
const NONE_EXPANDED: ReadonlySet<string> = new Set()

// React Flow node data must be an index-signature record; intersecting keeps our
// fields strongly typed while satisfying that constraint.
type FlowNodeData = TurnFlowNode & {
  selectedId?: string
  expanded?: boolean
  totalMs?: number
  onToggleSteps?: (skillId: string) => void
  [key: string]: unknown
}
type BandData = { label: string; durationMs?: number; shaded: boolean; [key: string]: unknown }
type CanvasNode = Node<FlowNodeData> | Node<BandData>

function FlowCard({ data }: NodeProps<Node<FlowNodeData>>) {
  const selected = data.selectedId === data.id
  const accent = data.nodeKind === 'outcome' ? OUTCOME_ACCENT[data.tone] : KIND_ACCENT[data.nodeKind]
  const dot = TONE_DOT[data.tone]
  const share = data.durationMs !== undefined && data.totalMs ? Math.min(1, data.durationMs / data.totalMs) : undefined
  return (
    <div
      className={`relative flex h-full w-full flex-col justify-center overflow-hidden rounded-lg border px-3 py-2 shadow-sm transition ${accent} ${
        data.tone === 'muted' ? 'opacity-60' : ''
      } ${selected ? 'ring-2 ring-primary' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <div className="flex items-center gap-1.5">
        {dot ? <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} /> : null}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{data.label}</span>
        {data.durationMs !== undefined ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatStageDuration(data.durationMs)}
          </span>
        ) : null}
      </div>
      {data.sublabel ? (
        <span className="mt-0.5 truncate text-[11px] text-muted-foreground" title={data.sublabel}>
          {data.sublabel}
        </span>
      ) : null}
      {data.note || data.stepCount ? (
        <div className="mt-0.5 flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[11px] ${TONE_NOTE[data.tone] ?? 'text-muted-foreground'}`}>
            {data.note}
          </span>
          {data.stepCount ? (
            <button
              type="button"
              className="nodrag nopan inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium text-sky-700 hover:bg-sky-500/10 dark:text-sky-400"
              aria-expanded={data.expanded}
              onClick={(event) => {
                event.stopPropagation()
                data.onToggleSteps?.(data.id)
              }}
            >
              {data.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {data.expanded ? 'Hide steps' : `${data.stepCount} step${data.stepCount === 1 ? '' : 's'}`}
            </button>
          ) : null}
        </div>
      ) : null}
      {share !== undefined ? (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 bg-sky-500/60"
          style={{ width: `${Math.max(share * 100, 2)}%` }}
        />
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  )
}

function PhaseBand({ data }: NodeProps<Node<BandData>>) {
  return (
    <div
      className={`pointer-events-none relative h-full w-full border-t border-dashed border-border/70 ${
        data.shaded ? 'bg-muted/30' : ''
      }`}
    >
      <div className="absolute left-4 top-3 flex flex-col">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{data.label}</span>
        {data.durationMs !== undefined ? (
          <span className="font-mono text-[11px] tabular-nums text-foreground/80">{formatStageDuration(data.durationMs)}</span>
        ) : null}
      </div>
    </div>
  )
}

const nodeTypes = { flowCard: FlowCard, phase: PhaseBand }

const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  input: { stroke: 'var(--muted-foreground, #94a3b8)', dash: '4 3' },
  sequence: { stroke: 'var(--border, #cbd5e1)' },
  branch: { stroke: 'var(--border, #cbd5e1)', dash: '5 4' },
  converge: { stroke: 'var(--border, #cbd5e1)' },
}

type Box = { x: number; y: number; width: number; height: number }

/**
 * Horizontal stripes, one per phase, spanning the whole graph. Adjacent stripes
 * meet halfway between their steps, so the progression reads top to bottom.
 * Inputs sit beside the step they feed and do not stretch a stripe.
 */
const phaseBands = (graph: TurnFlowGraphModel, positions: Map<string, Box>): Node<BandData>[] => {
  const boxes = [...positions.values()]
  if (boxes.length === 0) return []
  const minX = Math.min(...boxes.map((box) => box.x))
  const maxX = Math.max(...boxes.map((box) => box.x + box.width))

  const feeders = new Set(graph.edges.filter((edge) => edge.kind === 'input').map((edge) => edge.source))
  const extents = graph.phases.flatMap((phase) => {
    const members = graph.nodes.filter((node) => node.phase === phase.id && !feeders.has(node.id))
    const memberBoxes = members.flatMap((node) => {
      const box = positions.get(node.id)
      return box ? [box] : []
    })
    if (memberBoxes.length === 0) return []
    return [{
      phase,
      top: Math.min(...memberBoxes.map((box) => box.y)),
      bottom: Math.max(...memberBoxes.map((box) => box.y + box.height)),
    }]
  })

  return extents.map((extent, index) => {
    const previous = extents[index - 1]
    const next = extents[index + 1]
    const top = previous ? (previous.bottom + extent.top) / 2 : extent.top - BAND_PADDING
    const bottom = next ? (extent.bottom + next.top) / 2 : extent.bottom + BAND_PADDING
    return {
      id: `phase:${extent.phase.id}`,
      type: 'phase',
      position: { x: minX - BAND_GUTTER, y: top },
      data: { label: extent.phase.label, durationMs: extent.phase.durationMs, shaded: index % 2 === 0 },
      draggable: false,
      selectable: false,
      zIndex: 0,
      style: { width: maxX - minX + BAND_GUTTER + BAND_PADDING, height: bottom - top, pointerEvents: 'none' },
    }
  })
}

/**
 * Renders the turn as a top-to-bottom progression: phase stripes (understand →
 * the skill or routine that acted → answer) holding the steps in execution
 * order, closing on the verdict. A capability's own steps fold into its skill
 * node until expanded. Pure presentation — selection and the detail pane live
 * in the host.
 */
export function TurnFlowGraph({
  graph,
  selectedNodeId,
  onSelectNode,
}: {
  graph: TurnFlowGraphModel
  selectedNodeId?: string
  onSelectNode: (node: TurnFlowNode) => void
}) {
  // Follow the app's resolved theme, not the OS — React Flow's "system" colorMode
  // would render a dark pane while the dashboard is in light mode (or vice versa).
  const { resolvedTheme } = useTheme()
  // Fold state belongs to the graph it was opened on; a new graph opens folded.
  const [fold, setFold] = useState<{ graph: TurnFlowGraphModel; expanded: ReadonlySet<string> }>(() => ({
    graph,
    expanded: NONE_EXPANDED,
  }))
  const expanded = fold.graph === graph ? fold.expanded : NONE_EXPANDED
  const instanceRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null)

  const toggleSteps = useCallback((skillId: string) => {
    const expanding = !expanded.has(skillId)
    const next = new Set(expanded)
    if (expanding) next.add(skillId)
    else next.delete(skillId)
    setFold({ graph, expanded: next })
    // Folding away the selected step hands the selection to the skill that holds it.
    const selected = graph.nodes.find((node) => node.id === selectedNodeId)
    const skill = graph.nodes.find((node) => node.id === skillId)
    if (!expanding && selected?.groupId === skillId && skill) onSelectNode(skill)
  }, [expanded, graph, selectedNodeId, onSelectNode])

  const visible = useMemo(() => foldTurnFlowGroups(graph, expanded), [graph, expanded])
  const byId = useMemo(() => new Map(visible.nodes.map((node) => [node.id, node])), [visible.nodes])
  // Layout depends only on the shape; selecting a node must not re-run it.
  const positions = useMemo(() => layoutTurnFlow(visible), [visible])

  const nodes = useMemo(() => {
    const totalMs = visible.totals?.totalMs
    const flowNodes: Node<FlowNodeData>[] = visible.nodes.map((node) => {
      const box = positions.get(node.id) ?? { x: 0, y: 0, width: FLOW_NODE_WIDTH, height: FLOW_NODE_HEIGHT }
      return {
        id: node.id,
        type: 'flowCard',
        position: { x: box.x, y: box.y },
        data: { ...node, selectedId: selectedNodeId, expanded: expanded.has(node.id), totalMs, onToggleSteps: toggleSteps },
        draggable: false,
        zIndex: 1,
        style: { width: box.width, height: box.height },
      }
    })
    return [...phaseBands(visible, positions), ...flowNodes]
  }, [visible, positions, selectedNodeId, expanded, toggleSteps])

  const edges = useMemo<Edge[]>(
    () =>
      visible.edges.map((edge) => {
        const style = EDGE_STYLE[edge.kind] ?? EDGE_STYLE.sequence
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          style: { stroke: style.stroke, strokeWidth: 1.5, strokeDasharray: style.dash },
        }
      }),
    [visible.edges],
  )

  // Re-frame whenever steps fold or unfold, so the new shape is in view.
  const shape = useMemo(() => visible.nodes.map((node) => node.id).join('|'), [visible.nodes])
  useEffect(() => {
    const instance = instanceRef.current
    if (!instance) return
    const frame = requestAnimationFrame(() => {
      void instance.fitView({ ...FIT_VIEW, duration: 200 })
    })
    return () => cancelAnimationFrame(frame)
  }, [shape])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={resolvedTheme}
      minZoom={0.2}
      maxZoom={1.75}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      fitView
      fitViewOptions={FIT_VIEW}
      onInit={(instance) => {
        instanceRef.current = instance
      }}
      onNodeClick={(_event, node) => {
        const original = byId.get(node.id)
        if (original) onSelectNode(original)
      }}
    >
      <Background gap={18} size={1} className="!bg-transparent" />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
