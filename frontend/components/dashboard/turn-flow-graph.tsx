'use client'

import { useCallback, useMemo } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useTheme } from '@/components/theme-provider'
import type { FlowStatus, TurnFlowGraph, TurnFlowNode } from '@/lib/turn-flow'
import { FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH, layoutTurnFlow } from '@/lib/turn-flow-layout'

const STATUS_DOT: Record<FlowStatus, string> = {
  applied: 'bg-emerald-500',
  skipped: 'bg-slate-400',
  fallback: 'bg-amber-500',
  rejected: 'bg-rose-500',
  unavailable: 'bg-zinc-400',
  failed: 'bg-red-500',
}

const KIND_ACCENT: Record<TurnFlowNode['nodeKind'], string> = {
  input: 'border-border/70 bg-muted/40',
  engine: 'border-primary/40 bg-primary/10',
  skill: 'border-sky-500/40 bg-sky-500/10',
  stage: 'border-border/70 bg-background',
  outcome: 'border-emerald-500/40 bg-emerald-500/10',
}

const LANE_PADDING = 18
const LANE_LABEL_SPACE = 22

// React Flow node data must be an index-signature record; intersecting keeps our
// fields strongly typed while satisfying that constraint.
type FlowNodeData = TurnFlowNode & { selectedId?: string; [key: string]: unknown }
type LaneData = { label: string; [key: string]: unknown }

function FlowCard({ data }: NodeProps<Node<FlowNodeData>>) {
  const selected = data.selectedId === data.id
  return (
    <div
      className={`flex h-full w-full flex-col justify-center rounded-lg border px-3 py-2 shadow-sm transition ${
        KIND_ACCENT[data.nodeKind]
      } ${selected ? 'ring-2 ring-primary' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <div className="flex items-center gap-1.5">
        {data.status ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[data.status]}`} /> : null}
        <span className="truncate text-xs font-medium text-foreground">{data.label}</span>
      </div>
      {data.sublabel ? (
        <span className="mt-0.5 truncate text-[11px] text-muted-foreground">{data.sublabel}</span>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  )
}

function LaneCard({ data }: NodeProps<Node<LaneData>>) {
  return (
    <div className="pointer-events-none relative h-full w-full rounded-xl border border-dashed border-sky-500/30 bg-sky-500/[0.04]">
      <span className="absolute left-3 top-1.5 text-[10px] font-medium uppercase tracking-wide text-sky-600/80">
        {data.label} path
      </span>
    </div>
  )
}

const nodeTypes = { flowCard: FlowCard, lane: LaneCard }

const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  'fan-in': { stroke: 'var(--muted-foreground, #94a3b8)', dash: '4 3' },
  sequence: { stroke: 'var(--border, #cbd5e1)' },
  branch: { stroke: 'var(--border, #cbd5e1)', dash: '5 4' },
  converge: { stroke: 'var(--border, #cbd5e1)' },
}

/**
 * Renders the turn flow as a left-to-right React Flow canvas: inputs fan into the
 * engine, the engine selects a skill, the skill's capability path streams to the
 * outcome. Capability paths sit inside a labelled lane rather than a nested box.
 * Pure presentation — selection state and the detail pane live in the host.
 */
export function TurnFlowGraph({
  graph,
  selectedNodeId,
  onSelectNode,
  showMiniMap = false,
}: {
  graph: TurnFlowGraph
  selectedNodeId?: string
  onSelectNode: (node: TurnFlowNode) => void
  showMiniMap?: boolean
}) {
  // Follow the app's resolved theme, not the OS — React Flow's "system" colorMode
  // would render a dark pane while the dashboard is in light mode (or vice versa).
  const { resolvedTheme } = useTheme()
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])

  const { nodes, edges } = useMemo(() => {
    const positions = layoutTurnFlow(graph)

    // Capability lane: a labelled background region spanning each namespace's
    // nodes, so the skill's path reads as a grouped flow, not a nested card.
    const laneNodes: Node[] = []
    const byNamespace = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>()
    for (const node of graph.nodes) {
      if (!node.capabilityNamespace || node.nodeKind === 'skill') continue
      const box = positions.get(node.id)
      if (!box) continue
      const bounds = byNamespace.get(node.capabilityNamespace) ?? {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
      }
      bounds.minX = Math.min(bounds.minX, box.x)
      bounds.minY = Math.min(bounds.minY, box.y)
      bounds.maxX = Math.max(bounds.maxX, box.x + box.width)
      bounds.maxY = Math.max(bounds.maxY, box.y + box.height)
      byNamespace.set(node.capabilityNamespace, bounds)
    }
    for (const [namespace, bounds] of byNamespace) {
      laneNodes.push({
        id: `lane:${namespace}`,
        type: 'lane',
        position: { x: bounds.minX - LANE_PADDING, y: bounds.minY - LANE_PADDING - LANE_LABEL_SPACE },
        data: { label: namespace },
        draggable: false,
        selectable: false,
        zIndex: 0,
        style: {
          width: bounds.maxX - bounds.minX + LANE_PADDING * 2,
          height: bounds.maxY - bounds.minY + LANE_PADDING * 2 + LANE_LABEL_SPACE,
        },
      })
    }

    const flowNodes: Node<FlowNodeData>[] = graph.nodes.map((node) => {
      const box = positions.get(node.id) ?? { x: 0, y: 0, width: FLOW_NODE_WIDTH, height: FLOW_NODE_HEIGHT }
      return {
        id: node.id,
        type: 'flowCard',
        position: { x: box.x, y: box.y },
        data: { ...node, selectedId: selectedNodeId },
        draggable: false,
        zIndex: 1,
        style: { width: box.width, height: box.height },
      }
    })

    const flowEdges: Edge[] = graph.edges.map((edge) => {
      const style = EDGE_STYLE[edge.kind] ?? EDGE_STYLE.sequence
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        animated: edge.kind === 'fan-in',
        style: { stroke: style.stroke, strokeWidth: 1.5, strokeDasharray: style.dash },
      }
    })

    return { nodes: [...laneNodes, ...flowNodes], edges: flowEdges }
  }, [graph, selectedNodeId])

  // Center the canvas on the first node (the topmost flow node by layout y) so the
  // user lands zoomed in on the start of the turn rather than the whole graph
  // shrunk to fit. They can scroll/pan downstream from there.
  const firstNodeId = useMemo(() => {
    const flowNodes = nodes.filter((node) => node.type === 'flowCard')
    if (!flowNodes.length) return undefined
    return flowNodes.reduce((earliest, current) =>
      current.position.y < earliest.position.y ? current : earliest,
    ).id
  }, [nodes])

  const handleInit = useCallback(
    (instance: ReactFlowInstance) => {
      if (!firstNodeId) {
        instance.fitView({ padding: 0.25 })
        return
      }
      const node = instance.getNode(firstNodeId)
      if (!node) {
        instance.fitView({ padding: 0.25 })
        return
      }
      const width = node.measured?.width ?? (node.width ?? FLOW_NODE_WIDTH)
      const height = node.measured?.height ?? (node.height ?? FLOW_NODE_HEIGHT)
      instance.setCenter(node.position.x + width / 2, node.position.y + height + 24, {
        zoom: 1.2,
        duration: 0,
      })
    },
    [firstNodeId],
  )

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
      onInit={handleInit}
      onNodeClick={(_event, node) => {
        const original = byId.get(node.id)
        if (original) onSelectNode(original)
      }}
    >
      <Background gap={18} size={1} className="!bg-transparent" />
      <Controls showInteractive={false} />
      {showMiniMap ? <MiniMap pannable zoomable className="!bg-muted/40" /> : null}
    </ReactFlow>
  )
}
