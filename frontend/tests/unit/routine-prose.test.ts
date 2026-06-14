import { describe, expect, it } from 'vitest'

import { branchDecisionLabel, draftFromChipDoc, formatConditionLabel, slugifyVariableKey } from '@/lib/routine-prose'

describe('routine prose helpers', () => {
  it('labels how each branch is decided in plain language', () => {
    expect(branchDecisionLabel('llm')).toBe('Decided by AI')
    expect(branchDecisionLabel('default')).toBe('Otherwise')
    expect(branchDecisionLabel('field')).toBe('Decided in code')
  })

  it('keys a free-text variable name into a valid slot key', () => {
    expect(slugifyVariableKey('Order ID')).toBe('order_id')
    expect(slugifyVariableKey('  Reason  ')).toBe('reason')
    expect(slugifyVariableKey('!!!')).toBe('value')
  })

  it('renders a readable comparison label', () => {
    expect(formatConditionLabel('is_member', 'is_true', null, null)).toBe('is_member is true')
    expect(formatConditionLabel('tier', 'equals', 'gold', null)).toBe('tier is gold')
    expect(formatConditionLabel('status', 'in', null, ['final_sale', 'void'])).toBe('status is one of final_sale, void')
    expect(formatConditionLabel('budget', 'gt', 5000, null)).toBe('budget is greater than 5000')
    expect(formatConditionLabel('order_date', 'older_than', 6, null, 'months')).toBe('order_date is older than 6 months')
  })

  it('compiles an older_than condition into a field guard with a duration unit', () => {
    const draft = draftFromChipDoc({
      name: 'Refund window',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Look up the order date.', chips: [] },
        {
          text: '',
          chips: [
            { kind: 'condition', refId: 'order_date', op: 'older_than', value: 6, values: null, unit: 'months' },
            { kind: 'handoff', refId: 'human' },
          ],
        },
      ],
      variables: [{ id: 'order_date', name: 'order date', type: 'date' }],
    })
    const branch = draft.transitions.find((transition) => transition.toRef === 'handoff')
    expect(branch).toMatchObject({ guardKind: 'field', fieldRef: 'order_date', fieldOp: 'older_than', fieldValue: 6, fieldUnit: 'months' })
  })

  it('compiles non-branch blocks into chained chat steps ending on a terminal', () => {
    const draft = draftFromChipDoc({
      name: 'Process a refund',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Ask for {{slot.order_id}} and the reason.', chips: [{ kind: 'variable', refId: 'order_id' }] },
        { text: 'Confirm and finish.', chips: [] },
      ],
      variables: [
        { id: 'order_id', name: 'order id', type: 'text' },
        { id: 'unused', name: 'unused', type: 'text' },
      ],
    })

    expect(draft.steps.map((step) => step.stableStepId)).toEqual(['step_1', 'step_2'])
    expect(draft.transitions.map((transition) => transition.toRef)).toEqual(['step_2', 'done'])
    expect(draft.terminals.map((terminal) => terminal.kind)).toEqual(['complete'])
    expect(draft.slots.map((slot) => slot.key)).toEqual(['order_id'])
  })

  it('compiles a handoff block (no condition) into an AI-decided (llm) branch', () => {
    const draft = draftFromChipDoc({
      name: 'Refund with handoff',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Ask for the order id.', chips: [] },
        { text: 'If they refuse to verify,', chips: [{ kind: 'handoff', refId: 'human' }] },
        { text: 'Confirm and finish.', chips: [] },
      ],
      variables: [],
    })

    const fromStep1 = draft.transitions.filter((transition) => transition.fromStep === 'step_1')
    expect(fromStep1).toEqual([
      expect.objectContaining({ toRef: 'handoff', guardKind: 'llm', guardText: 'If they refuse to verify,' }),
      expect.objectContaining({ toRef: 'step_2', guardKind: 'default' }),
    ])
    expect(draft.terminals.map((terminal) => terminal.kind).sort()).toEqual(['complete', 'handoff'])
  })

  it('compiles a condition chip into a decided-in-code (field) branch', () => {
    const draft = draftFromChipDoc({
      name: 'Refund',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Look up the order status.', chips: [] },
        {
          text: '',
          chips: [
            { kind: 'condition', refId: 'order_status', op: 'in', value: null, values: ['final_sale', 'void'] },
            { kind: 'handoff', refId: 'human' },
          ],
        },
        { text: 'Issue the refund.', chips: [] },
      ],
      variables: [{ id: 'order_status', name: 'order status', type: 'text' }],
    })

    // The condition variable becomes a declared slot.
    expect(draft.slots.map((slot) => slot.key)).toEqual(['order_status'])
    // step_1 → handoff is a FIELD guard (decided in code), not llm.
    const branch = draft.transitions.find((transition) => transition.toRef === 'handoff')
    expect(branch).toMatchObject({
      guardKind: 'field',
      fieldRef: 'order_status',
      fieldOp: 'in',
      fieldValues: ['final_sale', 'void'],
    })
    // step_1 also continues by default to step_2 (the "issue the refund" step).
    expect(draft.transitions).toContainEqual(expect.objectContaining({ fromStep: 'step_1', toRef: 'step_2', guardKind: 'default' }))
    expect(draft.terminals.map((terminal) => terminal.kind).sort()).toEqual(['complete', 'handoff'])
  })

  it('falls back to placeholder name/trigger when blank', () => {
    const draft = draftFromChipDoc({ name: '  ', trigger: '', blocks: [{ text: 'Do a thing.', chips: [] }], variables: [] })
    expect(draft.name).toBe('Untitled routine')
    expect(draft.activation.triggerDescription).toBe('When this routine applies.')
  })
})
