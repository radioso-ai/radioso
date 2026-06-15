import { describe, expect, it } from 'vitest'

import {
  branchDecisionLabel,
  draftFromChipDoc,
  formatConditionLabel,
  routineToChipDoc,
  slugifyVariableKey,
  type ChipDocVariable,
  type ProseParagraph,
  type RoutineDocBlock,
} from '@/lib/routine-prose'

// Mirror how the chip editor serializes its document back out (ChipNode.getTextContent +
// OnDocChangePlugin), so a round-trip test can prove the inverse serializer is faithful.
function paragraphsToBlocks(paragraphs: ProseParagraph[]): RoutineDocBlock[] {
  return paragraphs.map((paragraph) => ({
    text: paragraph
      .map((segment) => {
        if (segment.kind === 'text') return segment.text
        if (segment.chipKind === 'variable') return `{{slot.${segment.refId}}}`
        return ''
      })
      .join(''),
    chips: paragraph.flatMap((segment) =>
      segment.kind === 'chip'
        ? [{ kind: segment.chipKind, refId: segment.refId, op: segment.op ?? null, value: segment.value ?? null, values: segment.values ?? null, unit: segment.unit ?? null }]
        : [],
    ),
  }))
}

function roundTrip(name: string, trigger: string, blocks: RoutineDocBlock[], variables: ChipDocVariable[]) {
  const draft = draftFromChipDoc({ name, trigger, blocks, variables })
  const doc = routineToChipDoc(draft)
  expect(doc).not.toBeNull()
  const redraft = draftFromChipDoc({ name, trigger, blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
  return { draft, redraft }
}

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

describe('titled steps and jumps', () => {
  it('compiles an h1 heading into a titled step: slug id, author label, title as instruction', () => {
    const draft = draftFromChipDoc({
      name: 'Onboard',
      trigger: 'new customer',
      blocks: [{ text: 'Collect email', chips: [], headingLevel: 1 }],
      variables: [],
    })
    expect(draft.steps[0]).toMatchObject({
      stableStepId: 'collect_email',
      kind: 'chat',
      instruction: 'Collect email',
      metadata: { outlineLabel: 'Collect email' },
    })
  })

  it('uses the body prose under a heading as the step instruction (title is the label)', () => {
    const draft = draftFromChipDoc({
      name: 'Onboard',
      trigger: 'new customer',
      blocks: [
        { text: 'Collect email', chips: [], headingLevel: 1 },
        { text: 'Ask the customer for their email address.', chips: [] },
      ],
      variables: [],
    })
    expect(draft.steps).toHaveLength(1)
    expect(draft.steps[0]).toMatchObject({
      stableStepId: 'collect_email',
      instruction: 'Ask the customer for their email address.',
      metadata: { outlineLabel: 'Collect email' },
    })
  })

  it('compiles a forward step jump into an AI-decided (llm) edge to the target step', () => {
    const draft = draftFromChipDoc({
      name: 'Support',
      trigger: 'needs help',
      blocks: [
        { text: 'Triage', chips: [], headingLevel: 1 },
        { text: 'If it is a billing question,', chips: [{ kind: 'step', refId: 'resolve_billing' }] },
        { text: 'Resolve billing', chips: [], headingLevel: 1 },
      ],
      variables: [],
    })
    const jump = draft.transitions.find((transition) => transition.toRef === 'resolve_billing' && transition.fromStep === 'triage')
    expect(jump).toMatchObject({ guardKind: 'llm', guardText: 'If it is a billing question,' })
    // The target step exists with the matching stable id.
    expect(draft.steps.map((step) => step.stableStepId)).toContain('resolve_billing')
  })

  it('compiles a backward step jump with a max count into a counter-guarded loop edge', () => {
    const draft = draftFromChipDoc({
      name: 'Verify',
      trigger: 'verify identity',
      blocks: [
        { text: 'Ask for code', chips: [], headingLevel: 1 },
        { text: 'Check the code', chips: [], headingLevel: 1 },
        { text: 'If the code is wrong,', chips: [{ kind: 'step', refId: 'ask_for_code', counterLimit: 3 }] },
      ],
      variables: [],
    })
    const loop = draft.transitions.find((transition) => transition.toRef === 'ask_for_code' && transition.fromStep === 'check_the_code')
    expect(loop).toMatchObject({ guardKind: 'counter', counterLimit: 3 })
  })

  it('keeps untitled blocks on the original positional-id behavior (no regression)', () => {
    const draft = draftFromChipDoc({
      name: 'Plain',
      trigger: 'x',
      blocks: [
        { text: 'Do the first thing.', chips: [] },
        { text: 'Do the second thing.', chips: [] },
      ],
      variables: [],
    })
    expect(draft.steps.map((step) => step.stableStepId)).toEqual(['step_1', 'step_2'])
    expect(draft.steps.every((step) => Object.keys(step.metadata).length === 0)).toBe(true)
  })
})

describe('routineToChipDoc (inverse serializer)', () => {
  it('round-trips a linear routine with an inline variable chip', () => {
    const { draft, redraft } = roundTrip(
      'Refund',
      'wants a refund',
      [
        { text: 'Ask for {{slot.order_id}} and the reason.', chips: [{ kind: 'variable', refId: 'order_id' }] },
        { text: 'Confirm and finish.', chips: [] },
      ],
      [{ id: 'order_id', name: 'order id', type: 'text' }],
    )
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
    expect(redraft.slots).toEqual(draft.slots)
    expect(redraft.terminals).toEqual(draft.terminals)
  })

  it('round-trips a forking routine with an AI-decided (llm) handoff branch', () => {
    const { draft, redraft } = roundTrip(
      'Refund with handoff',
      'wants a refund',
      [
        { text: 'Ask for the order id.', chips: [] },
        { text: 'If they refuse to verify,', chips: [{ kind: 'handoff', refId: 'human' }] },
        { text: 'Confirm and finish.', chips: [] },
      ],
      [],
    )
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
    expect(redraft.terminals).toEqual(draft.terminals)
  })

  it('round-trips a decided-in-code (field) branch with a relative-date check', () => {
    const { draft, redraft } = roundTrip(
      'Refund window',
      'wants a refund',
      [
        { text: 'Look up the order date.', chips: [] },
        {
          text: '',
          chips: [
            { kind: 'condition', refId: 'order_date', op: 'older_than', value: 6, values: null, unit: 'months' },
            { kind: 'handoff', refId: 'human' },
          ],
        },
        { text: 'Issue the refund.', chips: [] },
      ],
      [{ id: 'order_date', name: 'order date', type: 'date' }],
    )
    expect(redraft.transitions).toEqual(draft.transitions)
    expect(redraft.slots).toEqual(draft.slots)
    expect(redraft.terminals).toEqual(draft.terminals)
  })

  it('compiles a skill chip to a tool step and round-trips it', () => {
    const draft = draftFromChipDoc({
      name: 'Booking',
      trigger: 'wants to book',
      blocks: [
        { text: 'Check availability ', chips: [{ kind: 'skill', refId: 'calcom_availability' }] },
        { text: 'Confirm the time.', chips: [] },
      ],
      variables: [],
    })
    // A skill chip names a skill defined elsewhere; it compiles to a tool step.
    expect(draft.steps[0]).toMatchObject({ kind: 'tool', toolRef: 'calcom_availability', instruction: 'Check availability' })

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const redraft = draftFromChipDoc({ name: 'Booking', trigger: 'wants to book', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
  })

  it('compiles an end chip to a branch that completes the routine, and round-trips it', () => {
    const draft = draftFromChipDoc({
      name: 'Refund',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Look up the order status.', chips: [] },
        {
          text: '',
          chips: [
            { kind: 'condition', refId: 'status', op: 'equals', value: 'refunded', values: null },
            { kind: 'end', refId: 'done' },
          ],
        },
        { text: 'Otherwise issue the refund.', chips: [] },
      ],
      variables: [{ id: 'status', name: 'status', type: 'text' }],
    })
    // The end branch is a field-guarded transition to the complete terminal.
    const endBranch = draft.transitions.find((transition) => transition.toRef === 'done' && transition.guardKind === 'field')
    expect(endBranch).toMatchObject({ fieldRef: 'status', fieldOp: 'equals', fieldValue: 'refunded' })
    expect(draft.terminals.map((terminal) => terminal.kind)).toEqual(['complete'])

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const redraft = draftFromChipDoc({ name: 'Refund', trigger: 'wants a refund', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    expect(redraft.transitions).toEqual(draft.transitions)
    expect(redraft.terminals).toEqual(draft.terminals)
  })

  it('rebuilds variables from the routine slots, typed', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [{ text: 'Check {{slot.order_date}}.', chips: [{ kind: 'variable', refId: 'order_date' }] }],
      variables: [{ id: 'order_date', name: 'order date', type: 'date' }],
    })
    const doc = routineToChipDoc(draft)
    expect(doc?.variables).toEqual([{ id: 'order_date', name: 'order date', type: 'date' }])
  })

  it('returns null for routines the prose editor cannot represent (form fallback)', () => {
    const base = draftFromChipDoc({ name: 'x', trigger: 'y', blocks: [{ text: 'Do a thing.', chips: [] }], variables: [] })

    // An action (outbox) step has no prose chip.
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, kind: 'action', actionType: 'contact.send' }] })).toBeNull()
    // A tool step must name the skill it dispatches.
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, kind: 'tool', toolRef: null }] })).toBeNull()
    // A counter guard has no prose chip.
    expect(routineToChipDoc({ ...base, transitions: [{ ...base.transitions[0]!, guardKind: 'counter', counterLimit: 2 }] })).toBeNull()
    // An activation gate would be silently dropped on a prose round-trip.
    expect(routineToChipDoc({ ...base, activation: { ...base.activation, gateRef: 'gate_1' } })).toBeNull()
    // Completion export would be silently dropped on a prose round-trip.
    expect(routineToChipDoc({ ...base, completionExport: { enabled: true, triggerKinds: ['complete'], destinationRef: 'dest_1' } })).toBeNull()
    // More than one complete terminal isn't a prose shape.
    expect(routineToChipDoc({ ...base, terminals: [...base.terminals, { stableStepId: 'done2', kind: 'complete', instruction: 'x', ordinal: 1 }] })).toBeNull()
    // A custom completion message can't be shown in prose — would be silently overwritten.
    expect(routineToChipDoc({ ...base, terminals: [{ ...base.terminals[0]!, instruction: 'Thanks, all done!' }] })).toBeNull()
    // A non-default terminal id would be renamed on a prose round-trip.
    expect(routineToChipDoc({ ...base, terminals: [{ ...base.terminals[0]!, stableStepId: 'complete_1' }] })).toBeNull()
  })

  it('falls back to Form for a non-required slot (prose would flip it to required)', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [{ text: 'Ask for {{slot.email}}.', chips: [{ kind: 'variable', refId: 'email' }] }],
      variables: [{ id: 'email', name: 'email', type: 'email' }],
    })
    expect(routineToChipDoc(draft)).not.toBeNull()
    expect(routineToChipDoc({ ...draft, slots: draft.slots.map((slot) => ({ ...slot, required: false })) })).toBeNull()
  })

  it('synthesizes a non-empty instruction for a bare skill chip (no prose)', () => {
    const draft = draftFromChipDoc({
      name: 'Booking',
      trigger: 'book',
      blocks: [
        { text: 'Greet the customer.', chips: [] },
        { text: '', chips: [{ kind: 'skill', refId: 'book_meeting' }] },
      ],
      variables: [],
    })
    const toolStep = draft.steps.find((step) => step.kind === 'tool')
    expect(toolStep).toMatchObject({ kind: 'tool', toolRef: 'book_meeting', instruction: 'book_meeting' })
    // Every step has a non-empty instruction, so the backend (min(1)) accepts the draft.
    expect(draft.steps.every((step) => step.instruction.trim().length > 0)).toBe(true)
  })
})
