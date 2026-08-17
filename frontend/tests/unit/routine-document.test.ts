import { describe, expect, it } from 'vitest'

import { branchIsImplicitFallThrough, documentDiagnosticText, documentTextToSegments, formatBindingLine, formatBranchTargetLabel, guardToSentence, sanitizeDraftContentForSave } from '@/lib/routine-document'
import type { RoutineBlockBranch } from '@/lib/routine-prose'

describe('routine document helpers', () => {
  const slots = new Map([['email', 'Customer email'], ['attempts', 'Attempts'], ['order_total', 'Order total'], ['placed_at', 'Placed at'], ['is_member', 'Member']])
  type GuardSentenceInput = Parameters<typeof guardToSentence>[0]
  const guardFixture = (overrides: Partial<GuardSentenceInput>): GuardSentenceInput => ({
    kind: 'default',
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    fieldRef: null,
    fieldOp: null,
    fieldValue: null,
    fieldValues: null,
    fieldUnit: null,
    ...overrides,
  })

  it('renders each guard kind with its authored values', () => {
    expect(guardToSentence(guardFixture({ kind: 'llm', guardText: 'the request needs escalation' }), slots)).toBe('the request needs escalation')
    expect(guardToSentence(guardFixture({ kind: 'default' }), slots)).toBe('otherwise')
    expect(guardToSentence(guardFixture({ kind: 'slot_filled', guardText: '{{slot.email}} {{slot.attempts}}', slotKeys: ['email', 'attempts'] }), slots)).toBe('when Customer email and Attempts are provided')
    expect(guardToSentence(guardFixture({ kind: 'outcome', outcomeStatus: 'approved' }), slots)).toBe('when the skill reports approved')
    expect(guardToSentence(guardFixture({ kind: 'counter', counterLimit: 3 }), slots)).toBe('after 3 repeats')
  })

  it.each([
    ['equals', 'gold', null, null, 'Order total is gold'],
    ['not_equals', 'cancelled', null, null, 'Order total is not cancelled'],
    ['in', null, ['gold', 'platinum'], null, 'Order total is one of gold, platinum'],
    ['is_present', null, null, null, 'Order total is present'],
    ['is_absent', null, null, null, 'Order total is absent'],
    ['is_true', null, null, null, 'Member is true'],
    ['is_false', null, null, null, 'Member is false'],
    ['gt', 100, null, null, 'Order total is greater than 100'],
    ['gte', 100, null, null, 'Order total is at least 100'],
    ['lt', 50, null, null, 'Order total is less than 50'],
    ['lte', 50, null, null, 'Order total is at most 50'],
    ['older_than', 3, null, 'months', 'Placed at is older than 3 months'],
    ['within', 14, null, 'days', 'Placed at is within the last 14 days'],
  ] as const)('renders a %s field guard with its real value', (fieldOp, fieldValue, fieldValues, fieldUnit, expected) => {
    const fieldRef = fieldOp === 'older_than' || fieldOp === 'within' ? 'placed_at' : fieldOp === 'is_true' || fieldOp === 'is_false' ? 'is_member' : 'order_total'
    expect(guardToSentence(guardFixture({ kind: 'field', fieldRef, fieldOp, fieldValue, fieldValues: fieldValues ? [...fieldValues] : null, fieldUnit }), slots)).toBe(expected)
  })

  it('renders an unset field guard as an editable placeholder', () => {
    expect(guardToSentence(guardFixture({ kind: 'field' }), slots)).toBe('choose a rule…')
  })

  it('segments guard and ending slot references for inline chips', () => {
    expect(documentTextToSegments('Escalate when {{slot.demo_request}} needs review.')).toEqual([
      { kind: 'text', text: 'Escalate when ' },
      { kind: 'slotReference', key: 'demo_request', source: '{{slot.demo_request}}' },
      { kind: 'text', text: ' needs review.' },
    ])
    expect(documentTextToSegments('We saved {{slot.demo_request}}.')).toEqual([
      { kind: 'text', text: 'We saved ' },
      { kind: 'slotReference', key: 'demo_request', source: '{{slot.demo_request}}' },
      { kind: 'text', text: '.' },
    ])
  })

  it('keeps ending target labels compact', () => {
    expect(formatBranchTargetLabel({
      kind: 'complete',
      stableStepId: 'complete_1',
      instruction: 'This completion message is deliberately long enough to be shortened.',
    })).toBe('Finish: This completion message is deliberately…')
    expect(formatBranchTargetLabel({ kind: 'handoff', stableStepId: 'handoff_1', instruction: null })).toBe('Hand off (no message yet)')
  })

  it('assembles inputs and outputs into the uses-to-sets line', () => {
    expect(formatBindingLine(
      {
        email: { kind: 'variableRef', ref: 'email' },
        source: { kind: 'contextVariableRef', contextVariable: 'conversation_id' },
        retry: { kind: 'literal', value: true },
      },
      { customer_id: 'customerId' },
    )).toBe('uses email = email, source = context.conversation_id, retry = true → sets customer_id = customerId')
  })

  it('omits an empty uses-to-sets line', () => {
    expect(formatBindingLine({}, {})).toBeNull()
  })

  describe('implicit fall-through detection', () => {
    const guard = (kind: RoutineBlockBranch['guard']['kind']) => guardFixture({ kind }) as RoutineBlockBranch['guard']
    const branch = (guardKind: RoutineBlockBranch['guard']['kind'], target: RoutineBlockBranch['target']): RoutineBlockBranch =>
      ({ guard: guard(guardKind), target })

    it('treats a default edge into the next step as implied by the numbering', () => {
      expect(branchIsImplicitFallThrough(branch('default', { kind: 'step', stableStepId: 'step_2' }), 'step_2')).toBe(true)
    })

    it('keeps a default edge that ends the routine', () => {
      expect(branchIsImplicitFallThrough(branch('default', { kind: 'ending', terminalId: 'complete_1' }), 'step_2')).toBe(false)
    })

    it('keeps a jump to a step further along', () => {
      expect(branchIsImplicitFallThrough(branch('default', { kind: 'step', stableStepId: 'step_5' }), 'step_2')).toBe(false)
    })

    it('keeps a conditional edge even when it points at the next step', () => {
      expect(branchIsImplicitFallThrough(branch('field', { kind: 'step', stableStepId: 'step_2' }), 'step_2')).toBe(false)
      expect(branchIsImplicitFallThrough(branch('llm', { kind: 'step', stableStepId: 'step_2' }), 'step_2')).toBe(false)
    })

    it('keeps every edge on the last step, which has no next step', () => {
      expect(branchIsImplicitFallThrough(branch('default', { kind: 'step', stableStepId: 'step_2' }), null)).toBe(false)
    })
  })
})

describe('sanitizeDraftContentForSave', () => {
  const transition = {
    fromStep: 's1', toRef: 'end1', guardKind: 'field' as const, guardText: '', outcomeStatus: '',
    counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: '', fieldValues: [], fieldUnit: null, ordinal: 0,
  }
  const draft = {
    name: 'X',
    activation: { triggerDescription: 't', priority: 0 },
    slots: [{ stableSlotId: 'a', key: 'a', type: 'text' as const, required: true, description: '', ordinal: 0 }],
    steps: [{ stableStepId: 's1', kind: 'chat' as const, instruction: 'x', toolRef: '', actionType: '', captureKey: '', ordinal: 0, metadata: {}, options: [{ id: 'ok', label: 'OK', description: '' }] }],
    transitions: [transition],
    terminals: [{ stableStepId: 'end1', kind: 'complete' as const, instruction: '', ordinal: 0 }],
  }

  it('turns still-empty optional text back into absent values', () => {
    const saved = sanitizeDraftContentForSave(draft as never)
    expect(saved.terminals[0]!.instruction).toBeNull()
    expect(saved.transitions[0]).toMatchObject({ guardText: null, outcomeStatus: null, fieldValue: null, fieldValues: null })
    expect(saved.slots[0]!.description).toBeNull()
    expect(saved.steps[0]).toMatchObject({ toolRef: null, actionType: null, captureKey: null })
    expect(saved.steps[0]!.options![0]!.description).toBeNull()
  })

  it('keeps written content untouched', () => {
    const saved = sanitizeDraftContentForSave({
      ...draft,
      terminals: [{ ...draft.terminals[0]!, instruction: 'Done.' }],
      transitions: [{ ...transition, guardText: 'judge this', fieldValue: 50, fieldValues: ['a'] }],
    } as never)
    expect(saved.terminals[0]!.instruction).toBe('Done.')
    expect(saved.transitions[0]).toMatchObject({ guardText: 'judge this', fieldValue: 50, fieldValues: ['a'] })
  })
})

describe('documentDiagnosticText', () => {
  it('maps typed codes to operator copy', () => {
    expect(documentDiagnosticText({
      code: 'structured_guard_missing_parameter',
      location: 'transition:step_3->complete_1',
      message: 'structured guard missing parameter: field guard from "step_3" must declare a field reference and operator.',
    })).toBe('This rule needs a variable and a comparison.')
  })

  it('falls back to the validator message for unmapped codes', () => {
    expect(documentDiagnosticText({
      code: 'missing_terminal',
      location: 'routine:x',
      message: 'routine has no terminal step',
    })).toBe('routine has no terminal step')
  })
})
