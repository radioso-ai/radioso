import dagre from 'dagre'

import type { TurnFlowGraph } from './turn-flow'

export const FLOW_NODE_WIDTH = 220
export const FLOW_NODE_HEIGHT = 64

export interface NodeBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Top-to-bottom dagre layout for the turn flow. Returns top-left positions keyed
 * by node id (dagre reports centers; React Flow wants the corner). Pure: the draw
 * layer stays free of geometry math.
 */
export const layoutTurnFlow = (graph: TurnFlowGraph): Map<string, NodeBox> => {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 36, marginx: 28, marginy: 28 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of graph.nodes) {
    g.setNode(node.id, { width: FLOW_NODE_WIDTH, height: FLOW_NODE_HEIGHT })
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const positions = new Map<string, NodeBox>()
  for (const node of graph.nodes) {
    const laid = g.node(node.id)
    if (!laid) continue
    positions.set(node.id, {
      x: laid.x - FLOW_NODE_WIDTH / 2,
      y: laid.y - FLOW_NODE_HEIGHT / 2,
      width: FLOW_NODE_WIDTH,
      height: FLOW_NODE_HEIGHT,
    })
  }
  return positions
}
