import { describe, expect, it } from 'vitest'

import type { ActivityTrace, ConversationTraceStage, TurnTraceEnvelope } from '@/lib/api'
import { envelopeToFlowGraph, foldTurnFlowGroups, leafTraceFor, type TurnFlowGraph } from '@/lib/turn-flow'

const at = (offsetMs: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + offsetMs).toISOString()

const retrievalTrace: ActivityTrace = {
  traceId: 'trace-1',
  startedAt: at(2_500),
  completedAt: at(5_400),
  stages: [
    {
      stageId: 'interpret',
      kind: 'query_interpretation',
      label: 'Query interpretation',
      status: 'applied',
      startedAt: at(2_500),
      durationMs: 2,
    },
    {
      stageId: 'semantic_1',
      kind: 'semantic_rewritten',
      label: 'Semantic retrieval: seats',
      status: 'applied',
      startedAt: at(2_600),
      durationMs: 2_100,
      settings: { subqueryLabel: 'seats' },
      metrics: { candidateCount: 15 },
    },
    {
      stageId: 'lexical_1',
      kind: 'lexical',
      label: 'Lexical retrieval: seats',
      status: 'applied',
      startedAt: at(2_600),
      durationMs: 55,
      settings: { subqueryLabel: 'seats' },
      metrics: { candidateCount: 0 },
    },
    {
      stageId: 'preparation',
      kind: 'candidate_preparation',
      label: 'Candidate preparation',
      status: 'applied',
      startedAt: at(5_300),
      durationMs: 1,
      metrics: { mergedCount: 14, scoredCount: 14 },
    },
    {
      stageId: 'selection',
      kind: 'context_selection',
      label: 'Context selection',
      status: 'skipped',
      startedAt: at(5_301),
      durationMs: 0,
      metrics: { finalContextCount: 9 },
    },
    // Mirrors the whole turn's latency for the message record; not a span.
    { stageId: 'answer', kind: 'answer_outcome', label: 'Answer outcome', status: 'applied', durationMs: 8_000 },
  ],
  links: [
    { fromStageId: 'interpret', toStageId: 'semantic_1', kind: 'branch' },
    { fromStageId: 'interpret', toStageId: 'lexical_1', kind: 'branch' },
    { fromStageId: 'semantic_1', toStageId: 'preparation', kind: 'converge' },
    { fromStageId: 'lexical_1', toStageId: 'preparation', kind: 'converge' },
    { fromStageId: 'preparation', toStageId: 'selection', kind: 'sequence' },
    { fromStageId: 'selection', toStageId: 'answer', kind: 'sequence' },
  ],
}

const retrievalTurn = (): TurnTraceEnvelope => ({
  version: 1,
  spine: {
    traceId: 'conversation-turn-1',
    startedAt: at(0),
    completedAt: at(8_000),
    links: [{ from: 'directives', to: 'compose', kind: 'adherence' }],
    stages: [
      {
        id: 'message',
        kind: 'message',
        status: 'applied',
        startedAt: at(0),
        completedAt: at(0),
        outputs: { kind: 'message', eventId: 'msg_user_1', contentLength: 18 },
      },
      { id: 'gather', kind: 'gather', status: 'applied', startedAt: at(0), completedAt: at(0), outputs: { historyCount: 2 } },
      {
        id: 'turn_interpretation',
        kind: 'turn_interpretation',
        status: 'applied',
        startedAt: at(0),
        completedAt: at(2_500),
        outputs: {
          route: 'retrieval',
          metadata: { rewriteProposal: { turnKind: 'fresh_subject', retrievalSubqueryCount: 2 } },
        },
      },
      { id: 'retrieval_fanout', kind: 'retrieval_fanout', status: 'applied', startedAt: at(2_500), completedAt: at(5_400) },
      {
        id: 'directives',
        kind: 'directive_match',
        status: 'applied',
        startedAt: at(2_500),
        completedAt: at(2_502),
        outputs: { matchCount: 10, candidateCount: 11 },
      },
      {
        id: 'selection',
        kind: 'skill_selection',
        status: 'applied',
        startedAt: at(5_400),
        completedAt: at(5_400),
        outputs: {
          selectedSkills: ['retrieval.answer'],
          reason: 'candidates:retrieval',
          candidates: [
            { name: 'clarification.answer', selected: false },
            { name: 'retrieval.answer', selected: true },
            { name: 'direct.answer', selected: false },
          ],
        },
      },
      {
        id: 'dispatch:retrieval.answer',
        kind: 'skill_dispatch',
        status: 'applied',
        startedAt: at(5_400),
        completedAt: at(5_400),
        outputs: { skillName: 'retrieval.answer', outcomeStatus: 'completed' },
        subTrace: { namespace: 'retrieval', version: 1, payload: retrievalTrace },
      },
      {
        id: 'answer_coverage_head',
        kind: 'answer_coverage_head',
        status: 'applied',
        startedAt: at(5_400),
        completedAt: at(6_100),
        outputs: { availability: 'assessed', coverage: 'unanswered', reason: 'insufficient_evidence', producer: 'answer_head' },
      },
      {
        id: 'compose',
        kind: 'compose',
        status: 'applied',
        startedAt: at(5_400),
        completedAt: at(8_000),
        outputs: {
          citationCount: 2,
          adherence: [
            { directive: 'Be concise', ruleId: 'd1', satisfied: true, note: 'brief' },
            { directive: 'Link sources', ruleId: 'd2', satisfied: true, note: 'linked' },
          ],
        },
      },
      {
        id: 'model_calls',
        kind: 'model_calls',
        status: 'applied',
        outputs: {
          modelCalls: [
            { id: 'model_call_1', stageId: 'pre_engine', operation: 'turn_planning', model: 'gpt-mini', durationMs: 2_500 },
            { id: 'model_call_2', stageId: 'shadow', operation: 'answer_coverage_shadow_assessment', model: 'gpt-mini', durationMs: 860 },
            { id: 'model_call_3', stageId: 'compose', operation: 'answer', model: 'gpt-mini', durationMs: 2_600 },
          ],
        },
        metrics: { llmCallCount: 2, latencyMs: 5_100 },
      },
    ],
  },
  summary: {
    totalLlmCalls: 2,
    serialLlmDepth: 2,
    totalModelTimeMs: 5_100,
    totalTurnWallClockMs: 8_000,
    droppedCallCount: 0,
    longestStage: { name: 'retrieval_fanout', durationMs: 2_900 },
  },
})

const routineTurn = (extra: ConversationTraceStage[] = []): TurnTraceEnvelope => ({
  version: 1,
  spine: {
    traceId: 'conversation-turn-2',
    startedAt: at(0),
    stages: [
      { id: 'message', kind: 'message', status: 'applied', outputs: { kind: 'message', eventId: 'msg_user_2', contentLength: 12 } },
      { id: 'gather', kind: 'gather', status: 'applied', outputs: { historyCount: 0 } },
      { id: 'selection', kind: 'skill_selection', status: 'skipped', outputs: { reason: 'routine_claimed_turn' } },
      ...extra,
      { id: 'routine:contact', kind: 'routine_activate', status: 'applied', outputs: { routineId: 'contact', completed: false } },
      {
        id: 'directive_steering',
        kind: 'directive_steering',
        status: 'applied',
        outputs: { matchCount: 1, candidateCount: 2, directives: [{ id: 'directive_1', name: 'warmth' }] },
      },
    ],
  },
})

const node = (graph: TurnFlowGraph, id: string) => graph.nodes.find((candidate) => candidate.id === id)
const edge = (graph: TurnFlowGraph, source: string, target: string) =>
  graph.edges.find((candidate) => candidate.source === source && candidate.target === target)

describe('envelopeToFlowGraph', () => {
  it('draws the turn in execution order, from message to verdict', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    expect(edge(graph, 'input:message', 'spine:turn_interpretation')?.kind).toBe('sequence')
    expect(edge(graph, 'spine:turn_interpretation', 'spine:selection')?.kind).toBe('sequence')
    expect(edge(graph, 'spine:selection', 'skill')?.kind).toBe('sequence')
    expect(edge(graph, 'stage:answer', 'spine:answer_coverage_head')?.kind).toBe('sequence')
    expect(edge(graph, 'spine:answer_coverage_head', 'spine:compose')?.kind).toBe('sequence')
    expect(edge(graph, 'spine:compose', 'outcome')?.kind).toBe('sequence')
  })

  it('folds bookkeeping stages into the nodes they belong to instead of drawing them', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    // The fan-out's work is the dispatch sub-trace; the model-call collection is a turn total.
    expect(node(graph, 'spine:retrieval_fanout')).toBeUndefined()
    expect(node(graph, 'spine:model_calls')).toBeUndefined()
    expect(graph.totals).toEqual({
      totalMs: 8_000,
      modelCallCount: 2,
      recordedModelCallCount: 3,
      modelTimeMs: 5_100,
      modelCallsStageId: 'model_calls',
    })
  })

  it('draws a stage kind it does not know rather than dropping it', () => {
    const base = retrievalTurn()
    base.spine.stages.splice(6, 0, {
      id: 'skill-input:handoff',
      kind: 'skill_input_resolution',
      status: 'failed',
      startedAt: at(5_400),
      completedAt: at(5_450),
    })

    const graph = envelopeToFlowGraph(base)

    expect(node(graph, 'spine:skill-input:handoff')).toMatchObject({
      nodeKind: 'stage',
      label: 'skill input resolution',
      tone: 'bad',
      durationMs: 50,
      detail: { kind: 'spine', spineStageId: 'skill-input:handoff' },
    })
    expect(edge(graph, 'spine:selection', 'spine:skill-input:handoff')).toBeDefined()
    expect(edge(graph, 'spine:skill-input:handoff', 'skill')).toBeDefined()
  })

  it('feeds history into interpretation and directives into the composed answer', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    expect(node(graph, 'input:history')).toMatchObject({ sublabel: '2 prior', phase: 'understand' })
    expect(edge(graph, 'input:history', 'spine:turn_interpretation')?.kind).toBe('input')
    expect(node(graph, 'input:directives')).toMatchObject({ sublabel: '10 of 11 matched', phase: 'answer' })
    expect(edge(graph, 'input:directives', 'spine:compose')?.kind).toBe('input')
  })

  it('groups the progression into understand, the skill that ran, and answer', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    expect(graph.phases).toEqual([
      { id: 'understand', label: 'Understand', durationMs: 2_500 },
      { id: 'act', label: 'Retrieval', durationMs: 2_900 },
      { id: 'answer', label: 'Answer', durationMs: 2_600 },
    ])
    expect(node(graph, 'spine:turn_interpretation')?.phase).toBe('understand')
    expect(node(graph, 'spine:selection')?.phase).toBe('understand')
    expect(node(graph, 'skill')?.phase).toBe('act')
    expect(node(graph, 'stage:semantic_1')?.phase).toBe('act')
    expect(node(graph, 'spine:answer_coverage_head')?.phase).toBe('answer')
    expect(node(graph, 'outcome')?.phase).toBeUndefined()
  })

  it('times each band by its own steps, so retrieval between them is counted once', () => {
    const base = retrievalTurn()
    // The skill choice is recorded after retrieval has run, with a real span of its own.
    const selection = base.spine.stages.find((stage) => stage.kind === 'skill_selection')!
    selection.startedAt = at(5_400)
    selection.completedAt = at(5_600)

    expect(envelopeToFlowGraph(base).phases[0]).toEqual({ id: 'understand', label: 'Understand', durationMs: 2_700 })
  })

  it('bands a turn whose only understanding step is the message', () => {
    const graph = envelopeToFlowGraph({
      version: 1,
      spine: {
        traceId: 'conversation-turn-4',
        startedAt: at(0),
        stages: [
          { id: 'message', kind: 'message', status: 'applied', outputs: { eventId: 'msg_user_4' } },
          { id: 'routine:contact', kind: 'routine_resume', status: 'applied', outputs: { completed: true } },
        ],
      },
    })

    expect(graph.phases.map((phase) => phase.id)).toEqual(['understand', 'act'])
    expect(node(graph, 'input:message')?.phase).toBe('understand')
  })

  it('falls back to the spine clock when the summary could not time the turn', () => {
    const base = retrievalTurn()
    base.summary = { ...base.summary, totalTurnWallClockMs: 0 }

    expect(envelopeToFlowGraph(base).totals?.totalMs).toBe(8_000)
  })

  it('never moves the progression backwards when a stage is appended late', () => {
    const base = retrievalTurn()
    base.spine.stages.push({ id: 'clarification', kind: 'clarification', status: 'applied', outputs: { decision: 'asked' } })

    expect(node(envelopeToFlowGraph(base), 'spine:clarification')?.phase).toBe('answer')
  })

  it('says what each step decided', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    expect(node(graph, 'spine:turn_interpretation')).toMatchObject({
      label: 'Interpret',
      sublabel: 'retrieval · fresh subject · 2 sub-questions',
      durationMs: 2_500,
    })
    expect(node(graph, 'spine:selection')).toMatchObject({
      label: 'Select skill',
      sublabel: 'retrieval.answer · 3 considered',
    })
    expect(node(graph, 'skill')).toMatchObject({
      label: 'Retrieval',
      sublabel: '15 semantic · 0 keyword → 9 used',
      durationMs: 2_900,
      detail: { kind: 'spine', spineStageId: 'dispatch:retrieval.answer' },
    })
    expect(node(graph, 'spine:answer_coverage_head')).toMatchObject({
      label: 'Coverage verdict',
      sublabel: 'Unanswered · insufficient evidence',
      tone: 'bad',
      durationMs: 700,
    })
    expect(node(graph, 'spine:compose')).toMatchObject({
      label: 'Compose',
      sublabel: '2/2 directives honored · 2 cited',
      tone: 'neutral',
      durationMs: 2_600,
    })
  })

  it('omits durations the trace did not measure', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    // Placeholder stages open and close on the same instant.
    expect(node(graph, 'input:message')?.durationMs).toBeUndefined()
    expect(node(graph, 'spine:selection')?.durationMs).toBeUndefined()
    // The answer-outcome stage has no start: its number is the turn's, not its own.
    expect(node(graph, 'stage:answer')?.durationMs).toBeUndefined()
    expect(node(graph, 'stage:semantic_1')?.durationMs).toBe(2_100)
  })

  it('names capability steps in the shared stage vocabulary and flags the ones that need a look', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    expect(node(graph, 'stage:semantic_1')).toMatchObject({
      label: 'Semantic search',
      sublabel: 'seats · 15 passages',
      tone: 'neutral',
      groupId: 'skill',
      detail: { kind: 'leaf', leafStageId: 'semantic_1', dispatchStageId: 'dispatch:retrieval.answer' },
    })
    // An empty keyword search is routine; the count is shown, not flagged.
    expect(node(graph, 'stage:lexical_1')).toMatchObject({ label: 'Keyword search', sublabel: 'seats · 0 passages', tone: 'neutral' })
    expect(node(graph, 'stage:selection')).toMatchObject({ label: 'Rank', tone: 'muted' })
    expect(node(graph, 'skill')).toMatchObject({ tone: 'neutral', stepCount: 6 })
    expect(node(graph, 'skill')?.note).toBeUndefined()
  })

  it('carries the worst step up to the folded skill node', () => {
    const base = retrievalTurn()
    const dispatch = base.spine.stages.find((stage) => stage.kind === 'skill_dispatch')!
    const trace = structuredClone(retrievalTrace)
    trace.stages[1].metrics = { candidateCount: 0 }
    dispatch.subTrace = { namespace: 'retrieval', version: 1, payload: trace }

    const graph = envelopeToFlowGraph(base)

    expect(node(graph, 'stage:semantic_1')).toMatchObject({ tone: 'warn', note: 'no results' })
    expect(node(graph, 'skill')).toMatchObject({ tone: 'warn', note: 'Semantic search: no results' })
  })

  it('makes the verdict the outcome, not directive adherence', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    expect(node(graph, 'outcome')).toMatchObject({
      nodeKind: 'outcome',
      sublabel: 'Request remains unanswered',
      tone: 'bad',
      detail: { kind: 'spine', spineStageId: 'compose' },
    })
  })

  it('marks an answered turn good and unmet directives as a warning on compose', () => {
    const base = retrievalTurn()
    const coverage = base.spine.stages.find((stage) => stage.kind === 'answer_coverage_head')!
    coverage.outputs = { availability: 'assessed', coverage: 'answered', reason: 'sufficient_evidence' }
    const compose = base.spine.stages.find((stage) => stage.kind === 'compose')!
    compose.outputs = {
      adherence: [
        { directive: 'Be concise', ruleId: 'd1', satisfied: true, note: 'brief' },
        { directive: 'Use headings', ruleId: 'd2', satisfied: false, note: 'not used' },
      ],
    }

    const graph = envelopeToFlowGraph(base)

    expect(node(graph, 'outcome')).toMatchObject({ sublabel: 'Request answered', tone: 'good' })
    expect(node(graph, 'spine:compose')).toMatchObject({ sublabel: '1/2 directives honored', tone: 'warn' })
  })

  it('shows the visitor message text when the host has it', () => {
    const graph = envelopeToFlowGraph(retrievalTurn(), {
      messages: [{ id: 'msg_user_1', content: 'Are there seats left?' }],
    })

    expect(node(graph, 'input:message')?.sublabel).toBe('Are there seats left?')
    expect(node(envelopeToFlowGraph(retrievalTurn()), 'input:message')?.sublabel).toBe('18 chars')
  })

  it('renders an unknown capability as a single raw step', () => {
    const base = retrievalTurn()
    const dispatch = base.spine.stages.find((stage) => stage.kind === 'skill_dispatch')!
    dispatch.subTrace = { namespace: 'routine', version: 1, payload: { step: 'ask_email' } }

    const graph = envelopeToFlowGraph(base)

    // With nothing inside to unfold, the step stays in view and the skill offers no toggle.
    expect(node(graph, 'leaf:routine')).toMatchObject({ label: 'routine' })
    expect(node(graph, 'leaf:routine')?.groupId).toBeUndefined()
    expect(node(graph, 'skill')?.stepCount).toBeUndefined()
    expect(edge(foldTurnFlowGroups(graph, new Set()), 'skill', 'leaf:routine')).toBeDefined()
    expect(edge(graph, 'leaf:routine', 'spine:answer_coverage_head')).toBeDefined()
  })

  it('connects the skill straight on when it has no capability path', () => {
    const base = retrievalTurn()
    const dispatch = base.spine.stages.find((stage) => stage.kind === 'skill_dispatch')!
    delete (dispatch as { subTrace?: unknown }).subTrace

    const graph = envelopeToFlowGraph(base)

    expect(node(graph, 'skill')).toMatchObject({ label: 'retrieval.answer', sublabel: 'completed' })
    expect(node(graph, 'skill')?.stepCount).toBeUndefined()
    expect(edge(graph, 'skill', 'spine:answer_coverage_head')).toBeDefined()
  })

  it('draws a routine turn as the routine that ran, steered by its directives', () => {
    const graph = envelopeToFlowGraph(routineTurn())

    expect(node(graph, 'spine:selection')).toMatchObject({ sublabel: 'routine claimed turn', tone: 'muted' })
    expect(node(graph, 'spine:routine:contact')).toMatchObject({
      label: 'Routine',
      sublabel: 'in progress',
      phase: 'act',
      detail: { kind: 'spine', spineStageId: 'routine:contact' },
    })
    expect(edge(graph, 'spine:selection', 'spine:routine:contact')).toBeDefined()
    expect(edge(graph, 'spine:routine:contact', 'outcome')).toBeDefined()
    expect(node(graph, 'input:directives')).toMatchObject({
      label: 'Directives',
      sublabel: '1 of 2 matched',
      detail: { kind: 'spine', spineStageId: 'directive_steering' },
    })
    expect(edge(graph, 'input:directives', 'spine:routine:contact')?.kind).toBe('input')
    expect(graph.phases.map((phase) => phase.label)).toEqual(['Understand', 'Routine'])
  })

  it('places clarification before the routine it chose', () => {
    const graph = envelopeToFlowGraph(routineTurn([
      {
        id: 'clarification',
        kind: 'clarification',
        status: 'applied',
        outputs: {
          surface: 'routine_activation',
          decision: 'asked',
          candidates: [
            { id: 'demo', label: 'Book a demo', confidence: 0.73 },
            { id: 'support', label: 'Book support', confidence: 0.7 },
          ],
        },
      },
    ]))

    expect(node(graph, 'spine:clarification')).toMatchObject({ label: 'Clarification', sublabel: 'asked', phase: 'understand' })
    expect(edge(graph, 'spine:selection', 'spine:clarification')).toBeDefined()
    expect(edge(graph, 'spine:clarification', 'spine:routine:contact')).toBeDefined()
    expect(node(graph, 'outcome')?.sublabel).toBe('Asked the visitor to choose')
  })

  it('keeps every node and edge id unique when stages repeat', () => {
    const base = retrievalTurn()
    const dispatch = base.spine.stages.find((stage) => stage.kind === 'skill_dispatch')!
    const trace = structuredClone(retrievalTrace)
    // Two links between the same pair of stages.
    trace.links.push({ fromStageId: 'preparation', toStageId: 'selection', kind: 'sequence' })
    base.spine.stages.push(
      { ...structuredClone(dispatch), id: 'dispatch:second', subTrace: { namespace: 'retrieval', version: 1, payload: trace } },
      { id: 'steer_1', kind: 'directive_steering', status: 'applied', outputs: { matchCount: 1 } },
      { id: 'steer_2', kind: 'directive_steering', status: 'applied', outputs: { matchCount: 2 } },
    )

    const graph = envelopeToFlowGraph(base)
    const nodeIds = graph.nodes.map((candidate) => candidate.id)
    const edgeIds = graph.edges.map((candidate) => candidate.id)

    expect(new Set(nodeIds).size).toBe(nodeIds.length)
    expect(new Set(edgeIds).size).toBe(edgeIds.length)
    expect(nodeIds).toEqual(expect.arrayContaining(['input:directives', 'input:directives:1', 'input:directives:2']))
    expect(node(graph, 'stage:1:semantic_1')).toMatchObject({
      groupId: 'skill:1',
      detail: { kind: 'leaf', leafStageId: 'semantic_1', dispatchStageId: 'dispatch:second' },
    })
  })

  it('summarizes clarification decisions', () => {
    const withClarification = (outputs: Record<string, unknown>, status: 'applied' | 'skipped' = 'applied') => {
      const base = retrievalTurn()
      base.spine.stages.splice(5, 0, { id: 'clarification', kind: 'clarification', status, outputs })
      return node(envelopeToFlowGraph(base), 'spine:clarification')
    }

    expect(withClarification({ decision: 'auto_picked', reason: 'clear_margin' })?.sublabel).toBe('auto picked')
    expect(withClarification({ decision: 'auto_picked', reason: 'label_fallback' })?.sublabel).toBe(
      'auto picked: label fallback',
    )
    // An offered clarification passes the turn through; it is not a skipped step.
    expect(withClarification({ decision: 'offered' }, 'skipped')).toMatchObject({ sublabel: 'offered', tone: 'neutral' })
  })
})

describe('leafTraceFor', () => {
  it('opens a step in the trace of the dispatch it came from', () => {
    const base = retrievalTurn()
    const second = structuredClone(retrievalTrace)
    second.traceId = 'trace-2'
    base.spine.stages.push({
      id: 'dispatch:second',
      kind: 'skill_dispatch',
      status: 'applied',
      subTrace: { namespace: 'retrieval', version: 1, payload: second },
    })
    const fallback = structuredClone(retrievalTrace)

    expect(leafTraceFor({ kind: 'leaf', leafStageId: 'context', dispatchStageId: 'dispatch:second' }, base.spine.stages, fallback)?.traceId).toBe('trace-2')
    expect(leafTraceFor({ kind: 'leaf', leafStageId: 'context' }, base.spine.stages, fallback)).toBe(fallback)
  })
})

describe('foldTurnFlowGroups', () => {
  it('folds a capability path into its skill node until it is expanded', () => {
    const graph = envelopeToFlowGraph(retrievalTurn())

    const folded = foldTurnFlowGroups(graph, new Set())
    expect(folded.nodes.some((candidate) => candidate.groupId === 'skill')).toBe(false)
    expect(edge(folded, 'skill', 'spine:answer_coverage_head')?.kind).toBe('sequence')
    expect(folded.edges.some((candidate) => candidate.target.startsWith('stage:'))).toBe(false)

    const expanded = foldTurnFlowGroups(graph, new Set(['skill']))
    expect(expanded).toEqual(graph)
  })
})
