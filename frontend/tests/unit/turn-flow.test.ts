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
      {
        id: 'message',
        kind: 'message',
        status: 'applied',
        outputs: { kind: 'user.chat', eventId: 'msg_user_1', contentLength: 18 },
      },
      { id: 'gather', kind: 'gather', status: 'applied', outputs: { historyCount: 2 } },
      {
        id: 'directives',
        kind: 'directive_match',
        status: 'applied',
        outputs: { matchCount: 1, candidateCount: 3 },
      },
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
    expect(graph.nodes.find((n) => n.id === 'input:message')?.detail).toEqual({
      kind: 'spine',
      spineStageId: 'message',
    })
    expect(graph.nodes.find((n) => n.id === 'stage:semantic')?.detail).toEqual({ kind: 'leaf', leafStageId: 'semantic' })
  })

  it('places the canonical model-call collection before the outcome', () => {
    const base = envelope()
    base.spine.stages.push({
      id: 'model_calls',
      kind: 'model_calls',
      status: 'applied',
      outputs: {
        modelCalls: [{
          id: 'model_call_1',
          stageId: 'compose',
          operation: 'grounded_answer',
          model: 'gpt-answer',
          durationMs: 120,
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
        }],
      },
      metrics: { llmCallCount: 1 },
    })

    const graph = envelopeToFlowGraph(base)
    const node = graph.nodes.find((candidate) => candidate.id === 'spine:model_calls')

    expect(node).toMatchObject({
      label: 'Model calls',
      sublabel: '1 call',
      detail: { kind: 'spine', spineStageId: 'model_calls' },
    })
    expect(edge(graph, 'stage:answer', 'spine:model_calls')).toBeDefined()
    expect(edge(graph, 'spine:model_calls', 'outcome')).toBeDefined()
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

  it('places clarification between the engine and skill path on pass-through turns', () => {
    const base = envelope()
    base.spine.stages.splice(4, 0, {
      id: 'clarification',
      kind: 'clarification',
      status: 'applied',
      outputs: {
        surface: 'retrieval_sense',
        decision: 'auto_picked',
        reason: 'clear_margin',
        candidates: [
          { id: 'hatha', label: 'Hatha yoga', confidence: 0.78 },
          { id: 'raja', label: 'Raja yoga', confidence: 0.51 },
        ],
      },
    })

    const graph = envelopeToFlowGraph(base)
    const node = graph.nodes.find((n) => n.id === 'spine:clarification')

    expect(node).toMatchObject({
      nodeKind: 'stage',
      label: 'Clarification',
      sublabel: 'auto picked',
      status: 'applied',
      detail: { kind: 'spine', spineStageId: 'clarification' },
    })
    expect(edge(graph, 'engine', 'spine:clarification')?.kind).toBe('sequence')
    expect(edge(graph, 'spine:clarification', 'skill')?.kind).toBe('sequence')
    expect(edge(graph, 'engine', 'skill')).toBeUndefined()
  })

  it('summarizes offered clarification as an applied pass-through node', () => {
    const base = envelope()
    base.spine.stages.splice(4, 0, {
      id: 'clarification',
      kind: 'clarification',
      status: 'skipped',
      outputs: {
        surface: 'retrieval_sense',
        decision: 'offered',
        chosenCandidateId: 'hatha',
        candidates: [
          { id: 'hatha', label: 'Hatha yoga', confidence: 0.6 },
          { id: 'raja', label: 'Raja yoga', confidence: 0.58 },
        ],
      },
    })

    const graph = envelopeToFlowGraph(base)

    expect(graph.nodes.find((n) => n.id === 'spine:clarification')).toMatchObject({
      sublabel: 'offered',
      status: 'applied',
    })
  })

  it('distinguishes label-fallback auto-picks in the clarification summary', () => {
    const base = envelope()
    base.spine.stages.splice(4, 0, {
      id: 'clarification',
      kind: 'clarification',
      status: 'applied',
      outputs: {
        surface: 'retrieval_sense',
        decision: 'auto_picked',
        reason: 'label_fallback',
        chosenCandidateId: 'hatha',
        candidates: [{ id: 'hatha', label: 'Hatha yoga', confidence: 0.6 }],
      },
    })

    const graph = envelopeToFlowGraph(base)

    expect(graph.nodes.find((n) => n.id === 'spine:clarification')?.sublabel).toBe(
      'auto picked: label fallback',
    )
  })

  it('fans the routine-turn directive_steering stage in as the Directives input', () => {
    // Routine turns co-compose directives at render time and trace them as a
    // `directive_steering` spine stage (not `directive_match`). The flow graph
    // must surface them as the same Directives input it shows on normal turns.
    const routineTurn: TurnTraceEnvelope = {
      version: 1,
      spine: {
        traceId: 'conversation-turn-3',
        startedAt: '2026-01-01T00:00:00.000Z',
        stages: [
          {
            id: 'message',
            kind: 'message',
            status: 'applied',
            outputs: { kind: 'user.chat', eventId: 'msg_user_3', contentLength: 9 },
          },
          { id: 'gather', kind: 'gather', status: 'applied', outputs: { historyCount: 0 } },
          {
            id: 'routine_resume',
            kind: 'routine_resume',
            status: 'applied',
            outputs: { routineId: 'contact', answerLength: 40 },
          },
          {
            id: 'directive_steering',
            kind: 'directive_steering',
            status: 'applied',
            outputs: {
              matchCount: 1,
              candidateCount: 2,
              directives: [{ id: 'directive_1', name: 'warmth' }],
            },
          },
        ],
      },
    }

    const graph = envelopeToFlowGraph(routineTurn)
    const directives = graph.nodes.find((n) => n.id === 'input:directives')

    expect(directives).toMatchObject({
      nodeKind: 'input',
      label: 'Directives',
      sublabel: '1 of 2 matched',
      detail: { kind: 'spine', spineStageId: 'directive_steering' },
    })
    expect(edge(graph, 'input:directives', 'engine')?.kind).toBe('fan-in')
  })

  it('places clarification before the outcome on claimed routine turns', () => {
    const claimed: TurnTraceEnvelope = {
      version: 1,
      spine: {
        traceId: 'conversation-turn-2',
        startedAt: '2026-01-01T00:00:00.000Z',
        stages: [
          {
            id: 'message',
            kind: 'message',
            status: 'applied',
            outputs: { kind: 'user.chat', eventId: 'msg_user_2', contentLength: 12 },
          },
          { id: 'gather', kind: 'gather', status: 'applied', outputs: { historyCount: 0 } },
          { id: 'directives', kind: 'directive_match', status: 'skipped', outputs: { matchCount: 0 } },
          {
            id: 'selection',
            kind: 'skill_selection',
            status: 'skipped',
            outputs: { reason: 'routine_claimed_turn' },
          },
          {
            id: 'clarification',
            kind: 'clarification',
            status: 'applied',
            outputs: {
              surface: 'routine_activation',
              decision: 'asked',
              reason: 'too_close',
              margin: 0.03,
              candidates: [
                { id: 'demo', label: 'Book a demo', confidence: 0.73 },
                { id: 'support', label: 'Book support', confidence: 0.7 },
              ],
            },
          },
          {
            id: 'routine_activate',
            kind: 'routine_activate',
            status: 'applied',
            outputs: { answerLength: 64 },
          },
        ],
      },
    }

    const graph = envelopeToFlowGraph(claimed)

    expect(graph.nodes.find((n) => n.id === 'spine:clarification')).toMatchObject({
      label: 'Clarification',
      detail: { kind: 'spine', spineStageId: 'clarification' },
    })
    expect(edge(graph, 'engine', 'spine:clarification')?.kind).toBe('sequence')
    expect(edge(graph, 'spine:clarification', 'outcome')?.kind).toBe('sequence')
    expect(edge(graph, 'engine', 'outcome')).toBeUndefined()
  })
})
