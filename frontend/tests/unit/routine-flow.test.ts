import { describe, expect, it } from 'vitest'

import { routineBlockDocToFlowGraph, ROUTINE_FLOW_ACTIVATION_ID } from '@/lib/routine-flow'
import { routineToBlockDoc, type RoutineBlockDoc } from '@/lib/routine-prose'
import type { RoutineStepKind } from '@radioso/routine-definition'

const step = (
  stableStepId: string,
  ordinal: number,
  instruction: string,
  kind: RoutineStepKind = 'chat',
  extra: Record<string, unknown> = {},
) => ({ stableStepId, kind, instruction, toolRef: null, actionType: null, ordinal, metadata: {}, ...extra })

const doc = (): RoutineBlockDoc => {
  const result = routineToBlockDoc({
    name: 'Order return',
    activation: { triggerDescription: 'The visitor wants to return something', priority: 60 },
    slots: [
      { stableSlotId: 'order_number', key: 'order_number', type: 'text', required: true, ordinal: 0 },
      { stableSlotId: 'email', key: 'email', type: 'email', required: true, ordinal: 1 },
    ],
    steps: [
      step('ask_order', 0, 'Order number? {{slot.order_number}}'),
      step('lookup', 1, 'Look it up.', 'tool', { toolRef: '@orders.lookup' }),
      step('confirm', 2, 'Confirm the return.', 'approval'),
      step('sign_off', 3, 'Thanks, {{slot.order_number}}.'),
    ],
    transitions: [
      { fromStep: 'ask_order', toRef: 'lookup', guardKind: 'slot_filled', guardText: 'order_number', ordinal: 0 },
      { fromStep: 'ask_order', toRef: 'ask_order', guardKind: 'counter', counterLimit: 2, ordinal: 1 },
      { fromStep: 'ask_order', toRef: 'escalate', guardKind: 'default', ordinal: 2 },
      { fromStep: 'lookup', toRef: 'confirm', guardKind: 'llm', guardText: 'the order looks returnable', ordinal: 0 },
      { fromStep: 'confirm', toRef: 'sign_off', guardKind: 'default', ordinal: 0 },
      { fromStep: 'sign_off', toRef: 'done', guardKind: 'default', ordinal: 0 },
    ],
    terminals: [
      { stableStepId: 'done', kind: 'complete', instruction: 'All set.', ordinal: 0 },
      { stableStepId: 'escalate', kind: 'handoff', instruction: 'Could not identify the order.', ordinal: 1 },
    ],
  })
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join(', '))
  return result.doc
}

const graph = () => routineBlockDocToFlowGraph(doc())

describe('routineBlockDocToFlowGraph', () => {
  it('emits an activation node that enters the first step', () => {
    const { nodes, edges } = graph()
    expect(nodes.find((node) => node.id === ROUTINE_FLOW_ACTIVATION_ID)?.nodeKind).toBe('activation')
    const entry = edges.find((edge) => edge.source === ROUTINE_FLOW_ACTIVATION_ID)
    expect(entry?.target).toBe('step:ask_order')
    expect(entry?.isDecision).toBe(false)
  })

  it('namespaces node ids so a step and an ending may share a name', () => {
    const { nodes } = graph()
    expect(nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      'step:ask_order', 'step:lookup', 'ending:done', 'ending:escalate',
    ]))
  })

  it('marks only an llm guard as judgment, and every other guard as exact', () => {
    const decisions = graph().edges.filter((edge) => edge.isDecision)
    expect(decisions.filter((edge) => edge.provenance === 'judgment').map((edge) => edge.guardKind)).toEqual(['llm'])
    expect(decisions.filter((edge) => edge.provenance === 'exact').map((edge) => edge.guardKind).sort())
      .toEqual(['counter', 'slot_filled'])
  })

  it('treats a default guard as the plain onward path, not a decision', () => {
    const onward = graph().edges.filter((edge) => edge.guardKind === 'default')
    expect(onward).toHaveLength(3)
    expect(onward.every((edge) => !edge.isDecision)).toBe(true)
  })

  it('flags the edges that escalate to a person', () => {
    const escalating = graph().edges.filter((edge) => edge.escalates)
    expect(escalating.map((edge) => edge.target)).toEqual(['ending:escalate'])
  })

  it('flags a back edge to the same step', () => {
    const loops = graph().edges.filter((edge) => edge.selfLoop)
    expect(loops.map((edge) => edge.guardKind)).toEqual(['counter'])
  })

  it('attributes a slot to the step that collects it, not to a later use', () => {
    const nodes = graph().nodes
    expect(nodes.find((node) => node.id === 'step:ask_order')?.collects).toEqual(['order_number'])
    expect(nodes.find((node) => node.id === 'step:sign_off')?.collects).toEqual([])
  })

  it('reports slots no step collects', () => {
    expect(graph().uncollectedSlotKeys).toEqual(['email'])
  })

  it('counts branch decisions and how many are rules', () => {
    expect(graph().decisionCounts).toEqual({ total: 3, rules: 2 })
  })

  it('renders one ending node per terminal even when several branches target it', () => {
    const endings = graph().nodes.filter((node) => node.nodeKind === 'ending')
    expect(endings).toHaveLength(2)
    expect(endings.find((node) => node.id === 'ending:escalate')?.terminalKind).toBe('handoff')
  })

  it('draws an approval step\'s decision edges, one per option', () => {
    // The editor synthesises one `field` edge per option, guarded on `decision.id`.
    const result = routineToBlockDoc({
      name: 'Refund approval',
      activation: { triggerDescription: 'A refund needs a person', priority: 0 },
      slots: [],
      steps: [
        step('confirm', 0, 'A person decides.', 'approval', {
          options: [{ id: 'approve', label: 'Approve' }, { id: 'decline', label: 'Decline' }],
        }),
        step('refund', 1, 'Issue the refund.', 'action', { actionType: 'refunds.create' }),
      ],
      transitions: [
        { fromStep: 'confirm', toRef: 'refund', guardKind: 'field', fieldRef: 'decision.id', fieldOp: 'equals', fieldValue: 'approve', ordinal: 0 },
        { fromStep: 'confirm', toRef: 'declined', guardKind: 'field', fieldRef: 'decision.id', fieldOp: 'equals', fieldValue: 'decline', ordinal: 1 },
        { fromStep: 'refund', toRef: 'done', guardKind: 'outcome', outcomeStatus: 'ok', ordinal: 0 },
      ],
      terminals: [
        { stableStepId: 'done', kind: 'complete', instruction: 'Refunded.', ordinal: 0 },
        { stableStepId: 'declined', kind: 'complete', instruction: 'Not refunded.', ordinal: 1 },
      ],
    })
    if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join(', '))
    const { nodes, edges } = routineBlockDocToFlowGraph(result.doc)

    const fromApproval = edges.filter((edge) => edge.source === 'step:confirm')
    expect(fromApproval.map((edge) => edge.target)).toEqual(['step:refund', 'ending:declined'])
    expect(fromApproval.every((edge) => edge.isDecision && edge.provenance === 'exact')).toBe(true)
    expect(fromApproval.every((edge) => edge.sentence.includes('decision.id'))).toBe(true)
    expect(nodes.find((node) => node.id === 'step:confirm')?.approvalOptionCount).toBe(2)
  })

  it('keeps a transition whose target no longer exists visible as unresolved', () => {
    const source = doc()
    source.steps[0].branches[0].target = { kind: 'unresolved', toRef: 'deleted_step' }
    const { nodes, edges } = routineBlockDocToFlowGraph(source)
    expect(nodes.find((node) => node.nodeKind === 'unresolved')?.label).toBe('deleted_step')
    expect(edges.some((edge) => edge.unresolved)).toBe(true)
  })
})
