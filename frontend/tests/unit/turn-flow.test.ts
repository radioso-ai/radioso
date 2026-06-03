import { describe, expect, it } from 'vitest'

import type { TurnTraceEnvelope } from '@/lib/api'
import { envelopeToFlowGraph } from '@/lib/turn-flow'

const activityTrace = {
  traceId: 'trace-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  stages: [
    { stageId: 'interpret', kind: 'query_interpretation', label: 'Interpret', status: 'applied' },
    { stageId: 'semantic', kind: 'semantic_original', label: 'Semantic', status: 'applied' },
    { stageId: 'answer', kind: 'answer_outcome', label: 'Answer', status: 'applied' },
  ],
  links: [
    { fromStageId: 'interpret', toStageId: 'semantic', kind: 'sequence' },
    { fromStageId: 'semantic', toStageId: 'answer', kind: 'sequence' },
  ],
}

const envelope = (): TurnTraceEnvelope => ({
  version: 1,
  spine: {
    traceId: 'conversation-turn-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    stages: [
      { id: 'gather', kind: 'gather', status: 'applied', outputs: { historyCount: 2 } },
      { id: 'directives', kind: 'directive_match', status: 'applied', outputs: { matchCount: 1 } },
      {
        id: 'selection',
        kind: 'skill_selection',
        status: 'applied',
        outputs: { selectedSkills: ['retrieval.answer'], reason: 'evidence_required' },
      },
      {
        id: 'dispatch:retrieval.answer',
        kind: 'skill_dispatch',
        status: 'applied',
        outputs: { skillName: 'retrieval.answer', outcomeStatus: 'completed' },
        subTrace: { namespace: 'retrieval', version: 1, payload: activityTrace },
      },
      { id: 'compose', kind: 'compose', status: 'applied' },
    ],
  },
})

const edge = (graph: ReturnType<typeof envelopeToFlowGraph>, source: string, target: string) =>
  graph.edges.find((e) => e.source === source && e.target === target)

describe('envelopeToFlowGraph', () => {
  it('fans inputs into the engine', () => {
    const graph = envelopeToFlowGraph(envelope())
    const inputs = graph.nodes.filter((n) => n.nodeKind === 'input').map((n) => n.id)
    expect(inputs).toEqual(['input:message', 'input:history', 'input:directives'])
    for (const id of inputs) {
      expect(edge(graph, id, 'engine')?.kind).toBe('fan-in')
    }
    expect(graph.nodes.find((n) => n.id === 'input:history')?.sublabel).toBe('2 prior')
  })

  it('routes engine → skill → capability path → outcome', () => {
    const graph = envelopeToFlowGraph(envelope())
    expect(edge(graph, 'engine', 'skill')?.kind).toBe('sequence')
    // Skill stitches into the retrieval path's entry stage.
    expect(edge(graph, 'skill', 'stage:interpret')).toBeDefined()
    // Retrieval links are preserved.
    expect(edge(graph, 'stage:interpret', 'stage:semantic')?.kind).toBe('sequence')
    // The path's terminal stage flows into the outcome (not the skill node).
    expect(edge(graph, 'stage:answer', 'outcome')).toBeDefined()
    expect(edge(graph, 'skill', 'outcome')).toBeUndefined()
  })

  it('tags the skill and its path nodes with the capability namespace', () => {
    const graph = envelopeToFlowGraph(envelope())
    const retrievalNodes = graph.nodes.filter((n) => n.capabilityNamespace === 'retrieval')
    expect(retrievalNodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['skill', 'stage:interpret', 'stage:semantic', 'stage:answer']),
    )
  })

  it('carries detail resolution: spine stages vs leaf stages', () => {
    const graph = envelopeToFlowGraph(envelope())
    expect(graph.nodes.find((n) => n.id === 'engine')?.detail).toEqual({ kind: 'spine', spineStageId: 'selection' })
    expect(graph.nodes.find((n) => n.id === 'stage:semantic')?.detail).toEqual({ kind: 'leaf', leafStageId: 'semantic' })
  })

  it('connects skill straight to outcome when there is no capability leaf', () => {
    const base = envelope()
    const dispatch = base.spine.stages.find((s) => s.kind === 'skill_dispatch')!
    delete (dispatch as { subTrace?: unknown }).subTrace
    const graph = envelopeToFlowGraph(base)
    expect(graph.nodes.some((n) => n.nodeKind === 'stage')).toBe(false)
    expect(edge(graph, 'skill', 'outcome')).toBeDefined()
  })

  it('renders an unknown capability as a single raw path node', () => {
    const base = envelope()
    const dispatch = base.spine.stages.find((s) => s.kind === 'skill_dispatch')!
    dispatch.subTrace = { namespace: 'routine', version: 1, payload: { step: 'ask_email' } }
    const graph = envelopeToFlowGraph(base)
    expect(edge(graph, 'skill', 'leaf:routine')).toBeDefined()
    expect(edge(graph, 'leaf:routine', 'outcome')).toBeDefined()
  })
})
