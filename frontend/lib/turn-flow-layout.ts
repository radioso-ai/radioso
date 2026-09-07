import dagre from 'dagre'

import type { TurnFlowGraph } from './turn-flow'

export const FLOW_NODE_WIDTH = 220
export const FLOW_NODE_HEIGHT = 64

interface NodeBox {
  x: number
  y: number
  width: number
  height: number
}

interface LayoutNode {
  id: string
  width: number
  height: number
}

interface LayoutEdge {
  source: string
  target: string
}

interface FlowLayoutOptions {
  rankdir: 'TB' | 'LR'
  nodesep: number
  ranksep: number
  margin?: number
}

/**
 * Dagre layout for a flow graph. Returns top-left positions keyed by node id (dagre
 * reports centres; React Flow wants the corner). Pure: the draw layer stays free of
 * geometry math.
 *
 * Node sizes come from the caller because the turn spine draws one uniform card while
 * a routine mixes step cards, endings, and an activation pill.
 */
export const layoutFlowGraph = (
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: FlowLayoutOptions,
): Map<string, NodeBox> => {
  const g = new dagre.graphlib.Graph()
  const margin = options.margin ?? 28
  g.setGraph({
    rankdir: options.rankdir,
    nodesep: options.nodesep,
    ranksep: options.ranksep,
    marginx: margin,
    marginy: margin,
  })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) {
    g.setNode(node.id, { width: node.width, height: node.height })
  }
  for (const edge of edges) {
    // A back edge to the same node carries no rank information and makes dagre place
    // the node at an invalid position; the draw layer loops it in place instead.
    if (edge.source === edge.target) continue
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const positions = new Map<string, NodeBox>()
  for (const node of nodes) {
    const laid = g.node(node.id)
    if (!laid) continue
    positions.set(node.id, {
      x: laid.x - node.width / 2,
      y: laid.y - node.height / 2,
      width: node.width,
      height: node.height,
    })
  }
  return positions
}

/** Top-to-bottom layout for the turn flow, over one uniform card size. */
export const layoutTurnFlow = (graph: TurnFlowGraph): Map<string, NodeBox> =>
  layoutFlowGraph(
    graph.nodes.map((node) => ({ id: node.id, width: FLOW_NODE_WIDTH, height: FLOW_NODE_HEIGHT })),
    graph.edges,
    { rankdir: 'TB', nodesep: 28, ranksep: 36 },
  )
