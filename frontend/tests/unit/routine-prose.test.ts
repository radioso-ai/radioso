import { describe, expect, it } from 'vitest'

import {
  branchDecisionLabel,
  createEmptyRoutineProseDraft,
  draftFromChipDoc,
  formatConditionLabel,
  OUTCOME_GUARD_REF,
  SLOT_FILLED_GUARD_REF,
  readProseCompletionExport,
  readProseTerminals,
  routineToChipDoc,
  slugifyVariableKey,
  type ChipDocVariable,
  type ProseParagraph,
  type RoutineInputBinding,
  type RoutineDocBlock,
} from '@/lib/routine-prose'

// Mirror how the chip editor serializes its document back out (ChipNode.getTextContent +
// OnDocChangePlugin), so a round-trip test can prove the inverse serializer is faithful.
function paragraphsToBlocks(paragraphs: ProseParagraph[]): RoutineDocBlock[] {
  return paragraphs.map((paragraph) => ({
    ...(paragraph.headingLevel ? { headingLevel: paragraph.headingLevel } : {}),
    text: paragraph.segments
      .map((segment) => {
        if (segment.kind === 'text') return segment.text
        if (segment.chipKind === 'variable') return `{{slot.${segment.refId}}}`
        return ''
      })
      .join(''),
    chips: paragraph.segments.flatMap((segment) =>
      segment.kind === 'chip'
        ? [{
            kind: segment.chipKind,
            refId: segment.refId,
            op: segment.op ?? null,
            value: segment.value ?? null,
            values: segment.values ?? null,
            unit: segment.unit ?? null,
            counterLimit: segment.counterLimit ?? null,
            inputBindings: segment.inputBindings,
            outputAssignments: segment.outputAssignments,
            mode: segment.mode,
            captureKey: segment.captureKey ?? null,
            options: segment.options,
          }]
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

function openEditSaveBinding(binding: RoutineInputBinding): RoutineInputBinding | undefined {
  const opened = routineToChipDoc(draftFromChipDoc({
    name: 'Lookup',
    trigger: 'needs account help',
    variables: [{ id: 'email', name: 'email', type: 'email' }],
    blocks: [{
      text: 'Look up the account for {{slot.email}}.',
      chips: [{
        kind: 'skill',
        refId: 'crm.lookup_account',
        inputBindings: { email: binding },
        outputAssignments: { account_id: 'account_id' },
        mode: 'typed',
      }],
    }],
  }))
  expect(opened).not.toBeNull()

  const editedParagraphs = opened!.paragraphs.map((paragraph, index) =>
    index === 0
      ? { ...paragraph, segments: [...paragraph.segments, { kind: 'text' as const, text: ' Then confirm the match.' }] }
      : paragraph,
  )
  const saved = draftFromChipDoc({
    name: 'Lookup',
    trigger: 'needs account help',
    blocks: paragraphsToBlocks(editedParagraphs),
    variables: opened!.variables,
  })
  return saved.steps.find((step) => step.kind === 'tool')?.metadata.inputBindings?.email
}

describe('routine prose helpers', () => {
  it('creates a blank prose source that the prose editor can represent', () => {
    const draft = createEmptyRoutineProseDraft({
      name: 'Prospect intake',
      triggerDescription: 'When someone asks about pricing',
      priority: 5,
    })

    expect(routineToChipDoc(draft)).toEqual({ variables: [], paragraphs: [] })
    expect(draft).toMatchObject({
      name: 'Prospect intake',
      activation: { triggerDescription: 'When someone asks about pricing', priority: 5 },
      steps: [],
      transitions: [],
      terminals: [{ stableStepId: 'done', instruction: null }],
    })
  })

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

  it('preserves literal skill input bindings through open, edit, and save', () => {
    expect(openEditSaveBinding({ kind: 'literal', value: 'gold' })).toEqual({ kind: 'literal', value: 'gold' })
  })

  it('preserves variableRef skill input bindings through open, edit, and save', () => {
    expect(openEditSaveBinding({ kind: 'variableRef', ref: 'email' })).toEqual({ kind: 'variableRef', ref: 'email' })
  })

  it('preserves contextVariableRef skill input bindings through open, edit, and save', () => {
    expect(openEditSaveBinding({ kind: 'contextVariableRef', contextVariable: 'page_locale' })).toEqual({
      kind: 'contextVariableRef',
      contextVariable: 'page_locale',
    })
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

  // A decided-by-AI guard reverse-renders as a bare AI⇄code selector chip (op-less, no phrase
  // payload) followed by the phrase as ordinary text — so the phrase stays fully editable
  // (issue: "the AI phrase freezes into a chip after validate/publish") while the selector keeps
  // it togglable back to decided-in-code (issue: "once decided by AI, can't go back").
  it('reverse-renders an llm guard as a bare selector chip + fluid text', () => {
    const draft = draftFromChipDoc({
      name: 'Refund',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Review the case.', chips: [] },
        // Legacy authored shape (phrase carried on the chip's value) still compiles to an llm guard.
        { text: '', chips: [{ kind: 'condition', refId: '', op: null, value: 'the customer seems upset' }, { kind: 'handoff', refId: 'handoff' }] },
      ],
      variables: [],
    })
    expect(draft.transitions).toContainEqual(
      expect.objectContaining({ toRef: 'handoff', guardKind: 'llm', guardText: 'the customer seems upset' }),
    )
    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const segments = doc!.paragraphs.flatMap((paragraph) => paragraph.segments)
    // The selector chip is a bare marker: op-less, empty ref, no phrase baked in.
    expect(segments).toContainEqual(expect.objectContaining({ kind: 'chip', chipKind: 'condition', refId: '', label: '' }))
    // The phrase is fluid text, not baked into the chip's value.
    expect(segments).toContainEqual({ kind: 'text', text: 'the customer seems upset' })
    expect(segments).not.toContainEqual(expect.objectContaining({ kind: 'chip', value: 'the customer seems upset' }))
  })

  // The whole point of the split: editing the branch line's prose changes the guard the AI
  // judges. An llm guard loaded as selector-plus-text must recompile from the edited text.
  it('flows an edit of the AI guard prose back into the llm guard', () => {
    const draft = draftFromChipDoc({
      name: 'Refund',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Review the case.', chips: [] },
        // The fluid-text shape the editor now produces: bare selector chip + phrase as prose.
        { text: 'the customer seems upset', chips: [{ kind: 'condition', refId: '', op: null }, { kind: 'handoff', refId: 'handoff' }] },
      ],
      variables: [],
    })
    expect(draft.transitions).toContainEqual(
      expect.objectContaining({ toRef: 'handoff', guardKind: 'llm', guardText: 'the customer seems upset' }),
    )
    const doc = routineToChipDoc(draft)!
    // Edit the fluid text segment, as the author would type in the editor.
    const paragraphs = doc.paragraphs.map((paragraph) => ({
      ...paragraph,
      segments: paragraph.segments.map((segment) =>
        segment.kind === 'text' && segment.text === 'the customer seems upset'
          ? { kind: 'text' as const, text: 'the customer is at risk of churning' }
          : segment),
    }))
    const edited = draftFromChipDoc({ name: 'Refund', trigger: 'wants a refund', blocks: paragraphsToBlocks(paragraphs), variables: doc.variables })
    expect(edited.transitions).toContainEqual(
      expect.objectContaining({ toRef: 'handoff', guardKind: 'llm', guardText: 'the customer is at risk of churning' }),
    )
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

  it('synthesizes a heading for an untitled jump target so a Form-shaped routine opens in prose', () => {
    // A routine that jumps to a step which has a clean id but no author label — the shape a
    // Form-authored routine has (Form does not set outline labels).
    const titled = draftFromChipDoc({
      name: 'Support',
      trigger: 'needs help',
      blocks: [
        { text: 'Triage', chips: [], headingLevel: 1 },
        { text: 'If it is a billing question,', chips: [{ kind: 'step', refId: 'resolve_billing' }] },
        { text: 'Resolve billing', chips: [], headingLevel: 1 },
      ],
      variables: [],
    })
    const formish = { ...titled, steps: titled.steps.map((step) => ({ ...step, metadata: {} })) }

    const doc = routineToChipDoc(formish)
    expect(doc).not.toBeNull()
    // The jump target gets a synthesized heading derived from its id.
    expect(doc!.paragraphs.some((paragraph) =>
      paragraph.headingLevel === 1 && paragraph.segments.some((segment) => segment.kind === 'text' && segment.text === 'Resolve Billing'))).toBe(true)
    // The jump round-trips to the same target id (the synthesized title slugifies back to it).
    const redraft = draftFromChipDoc({ name: 'Support', trigger: 'needs help', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    expect(redraft.transitions.some((transition) => transition.toRef === 'resolve_billing' && transition.guardKind === 'llm')).toBe(true)
  })

  it('still falls back to Form when an untitled jump target id is not a clean slug', () => {
    const titled = draftFromChipDoc({
      name: 'Support',
      trigger: 'needs help',
      blocks: [
        { text: 'Triage', chips: [], headingLevel: 1 },
        { text: 'If it is a billing question,', chips: [{ kind: 'step', refId: 'resolve_billing' }] },
        { text: 'Resolve billing', chips: [], headingLevel: 1 },
      ],
      variables: [],
    })
    // Give the jump target an id that no title slugifies back to (mixed case), and drop labels.
    const exotic = {
      ...titled,
      steps: titled.steps.map((step) =>
        step.stableStepId === 'resolve_billing'
          ? { ...step, stableStepId: 'ResolveBilling', metadata: {} }
          : { ...step, metadata: {} }),
      transitions: titled.transitions.map((transition) =>
        transition.toRef === 'resolve_billing' ? { ...transition, toRef: 'ResolveBilling' } : transition),
    }
    expect(routineToChipDoc(exotic)).toBeNull()
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

  it('round-trips a titled step with a body and a variable chip', () => {
    const { draft, redraft } = roundTrip(
      'Onboard',
      'new customer',
      [
        { text: 'Collect email', chips: [], headingLevel: 1 },
        { text: 'Ask for their {{slot.email}}.', chips: [{ kind: 'variable', refId: 'email' }] },
      ],
      [{ id: 'email', name: 'email', type: 'email' }],
    )
    expect(draft.steps[0]).toMatchObject({ stableStepId: 'collect_email', metadata: { outlineLabel: 'Collect email' } })
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
  })

  it('round-trips a forward jump that skips a step', () => {
    const { draft, redraft } = roundTrip(
      'Support',
      'needs help',
      [
        { text: 'Triage', chips: [], headingLevel: 1 },
        { text: 'If urgent,', chips: [{ kind: 'step', refId: 'escalate' }] },
        { text: 'Investigate', chips: [], headingLevel: 1 },
        { text: 'Escalate', chips: [], headingLevel: 1 },
      ],
      [],
    )
    expect(draft.transitions).toContainEqual(expect.objectContaining({ fromStep: 'triage', toRef: 'escalate', guardKind: 'llm' }))
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
  })

  it('round-trips a backward jump bounded by a counter (a loop)', () => {
    const { draft, redraft } = roundTrip(
      'Verify',
      'verify identity',
      [
        { text: 'Ask for code', chips: [], headingLevel: 1 },
        { text: 'Check code', chips: [], headingLevel: 1 },
        { text: '', chips: [{ kind: 'step', refId: 'ask_for_code', counterLimit: 3 }] },
      ],
      [],
    )
    expect(draft.transitions).toContainEqual(
      expect.objectContaining({ fromStep: 'check_code', toRef: 'ask_for_code', guardKind: 'counter', counterLimit: 3 }),
    )
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
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

  it('compiles an action chip to an action step and round-trips it', () => {
    const draft = draftFromChipDoc({
      name: 'Escalate',
      trigger: 'wants a human',
      blocks: [
        { text: 'Email the team the request ', chips: [{ kind: 'action', refId: 'contact.send' }] },
        { text: 'Let them know a teammate will follow up.', chips: [] },
      ],
      variables: [],
    })
    // An action chip names an outbox action; it compiles to an action step.
    expect(draft.steps[0]).toMatchObject({ kind: 'action', actionType: 'contact.send', instruction: 'Email the team the request' })
    // The action step has a follow-up edge (the validator requires one).
    expect(draft.transitions.some((transition) => transition.fromStep === draft.steps[0]!.stableStepId)).toBe(true)

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const redraft = draftFromChipDoc({ name: 'Escalate', trigger: 'wants a human', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
  })

  it('falls back to Form for an action step with no action type', () => {
    const base = draftFromChipDoc({
      name: 'Escalate',
      trigger: 'wants a human',
      blocks: [{ text: 'Email the team ', chips: [{ kind: 'action', refId: 'contact.send' }] }],
      variables: [],
    })
    expect(routineToChipDoc(base)).not.toBeNull()
    const stripped = { ...base, steps: base.steps.map((step) => step.kind === 'action' ? { ...step, actionType: null } : step) }
    expect(routineToChipDoc(stripped)).toBeNull()
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

    // An action (outbox) step with no action type can't render as an action chip.
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, kind: 'action', actionType: null }] })).toBeNull()
    // A tool step must name the skill it dispatches.
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, kind: 'tool', toolRef: null }] })).toBeNull()
    // A counter guard has no prose chip.
    expect(routineToChipDoc({ ...base, transitions: [{ ...base.transitions[0]!, guardKind: 'counter', counterLimit: 2 }] })).toBeNull()
    // An activation gate would be silently dropped on a prose round-trip.
    expect(routineToChipDoc({ ...base, activation: { ...base.activation, gateRef: 'gate_1' } })).toBeNull()
    // More than one complete terminal isn't a prose shape (branches target distinct endings).
    expect(routineToChipDoc({ ...base, terminals: [...base.terminals, { stableStepId: 'done2', kind: 'complete', instruction: 'x', ordinal: 1 }] })).toBeNull()
    // More than one handoff terminal isn't a prose shape either.
    expect(routineToChipDoc({ ...base, terminals: [
      ...base.terminals,
      { stableStepId: 'handoff1', kind: 'handoff', instruction: 'a', ordinal: 1 },
      { stableStepId: 'handoff2', kind: 'handoff', instruction: 'b', ordinal: 2 },
    ] })).toBeNull()
    // A new prose draft emits a null completion instruction so routines do not say "All set."
    // as an extra final step.
    expect(base.terminals[0]?.instruction).toBeNull()

    // Authored step metadata the chips can't carry would be dropped on a round-trip.
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, metadata: { custom: 'x' } }] })).toBeNull()
    // Skill-binding metadata only round-trips on a tool step, not a chat step.
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, metadata: { inputBindings: {} } }] })).toBeNull()
    // An outline label that slugifies back to the step id is preserved (no fallback)...
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, stableStepId: 'step_1', metadata: { outlineLabel: 'Step 1' } }] })).not.toBeNull()
    // ...but one that would rename the step (slugifies to a different id) falls back.
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, stableStepId: 'step_1', metadata: { outlineLabel: 'Totally different name' } }] })).toBeNull()
    // An empty outline label (present but blank) would be dropped on a round-trip, so fall back.
    expect(routineToChipDoc({ ...base, steps: [{ ...base.steps[0]!, stableStepId: 'step_1', metadata: { outlineLabel: '' } }] })).toBeNull()
    // A handoff terminal no transition targets would be dropped on a round-trip.
    expect(routineToChipDoc({ ...base, terminals: [...base.terminals, { stableStepId: 'handoff', kind: 'handoff', instruction: 'x', ordinal: 1 }] })).toBeNull()
  })

  it('falls back to Form for an llm branch whose phrase (guardText) is empty', () => {
    const llmBranch = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [
        { text: 'Check the request.', chips: [] },
        { text: 'If it is urgent,', chips: [{ kind: 'handoff', refId: 'handoff' }] },
      ],
      variables: [],
    })
    expect(routineToChipDoc(llmBranch)).not.toBeNull()
    // A null guardText compiles to condition "llm"; rendering it as a bare branch would
    // round-trip to "" — a different compiled condition — so fall back instead.
    const nulled = {
      ...llmBranch,
      transitions: llmBranch.transitions.map((transition) =>
        transition.guardKind === 'llm' ? { ...transition, guardText: null } : transition),
    }
    expect(routineToChipDoc(nulled)).toBeNull()
  })

  it('reads an outcome guard whose status lives in guardText (compiler reads outcomeStatus ?? guardText)', () => {
    const draft = draftFromChipDoc({
      name: 'Refund',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Issue the refund ', chips: [{ kind: 'skill', refId: 'issue_refund' }] },
        { text: '', chips: [
          { kind: 'condition', refId: OUTCOME_GUARD_REF, value: 'failed' },
          { kind: 'handoff', refId: 'handoff' },
        ] },
      ],
      variables: [],
    })
    // Move the status from outcomeStatus into guardText, as a Form/legacy routine may store it.
    const legacy = {
      ...draft,
      transitions: draft.transitions.map((transition) =>
        transition.guardKind === 'outcome' ? { ...transition, outcomeStatus: null, guardText: 'failed' } : transition),
    }
    const doc = routineToChipDoc(legacy)
    expect(doc).not.toBeNull()
    const outcomeChip = doc!.paragraphs.flatMap((p) => p.segments)
      .find((s) => s.kind === 'chip' && s.chipKind === 'condition' && s.refId === OUTCOME_GUARD_REF)
    expect(outcomeChip).toMatchObject({ value: 'failed' })
  })

  it('renders a fully-unwired approval gate (choices declared, no branches routed yet)', () => {
    const draft = draftFromChipDoc({
      name: 'Refund approval',
      trigger: 'wants a large refund',
      blocks: [{
        text: 'Get a manager decision.',
        chips: [{
          kind: 'approval',
          refId: 'refund_decision',
          captureKey: 'refund_decision',
          options: [
            { id: 'approve', label: 'Approve', target: '' },
            { id: 'deny', label: 'Deny', target: '' },
          ],
        }],
      }],
      variables: [],
    })
    // No option is routed yet → no decision edges leave the approval step.
    expect(draft.transitions.some((transition) => transition.fromStep === draft.steps[0]!.stableStepId)).toBe(false)
    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const decision = doc!.paragraphs.flatMap((p) => p.segments).find((s) => s.kind === 'chip' && s.chipKind === 'decision')
    expect(decision).toMatchObject({ options: [{ id: 'approve' }, { id: 'deny' }] })
  })

  it('falls back to Form for a counter jump whose limit lives only in guardText', () => {
    const looped = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [
        { text: 'Ask for code', chips: [], headingLevel: 1 },
        { text: 'Check the code', chips: [], headingLevel: 1 },
        { text: 'If the code is wrong,', chips: [{ kind: 'step', refId: 'ask_for_code', counterLimit: 3 }] },
      ],
      variables: [],
    })
    expect(routineToChipDoc(looped)).not.toBeNull()
    const guardTextOnly = {
      ...looped,
      transitions: looped.transitions.map((transition) =>
        transition.guardKind === 'counter' ? { ...transition, counterLimit: null, guardText: '3' } : transition),
    }
    expect(routineToChipDoc(guardTextOnly)).toBeNull()
  })

  it('falls back to Form for a field guard missing its ref or operator', () => {
    const field = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [
        { text: 'Look up the {{slot.status}}.', chips: [{ kind: 'variable', refId: 'status' }] },
        { text: '', chips: [
          { kind: 'condition', refId: 'status', op: 'equals', value: 'final' },
          { kind: 'end', refId: 'done' },
        ] },
      ],
      variables: [{ id: 'status', name: 'status', type: 'text' }],
    })
    expect(routineToChipDoc(field)).not.toBeNull()
    const broken = {
      ...field,
      transitions: field.transitions.map((transition) =>
        transition.guardKind === 'field' ? { ...transition, fieldRef: undefined, fieldOp: undefined } : transition),
    }
    expect(routineToChipDoc(broken)).toBeNull()
  })

  it('compiles and round-trips an outcome guard branch from a tool step', () => {
    const draft = draftFromChipDoc({
      name: 'Refund',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Issue the refund ', chips: [{ kind: 'skill', refId: 'issue_refund' }] },
        { text: '', chips: [
          { kind: 'condition', refId: OUTCOME_GUARD_REF, value: 'failed' },
          { kind: 'handoff', refId: 'handoff' },
        ] },
      ],
      variables: [],
    })
    const toolStep = draft.steps.find((step) => step.kind === 'tool')!
    const outcomeEdge = draft.transitions.find((transition) => transition.guardKind === 'outcome')
    expect(outcomeEdge).toMatchObject({ fromStep: toolStep.stableStepId, guardKind: 'outcome', outcomeStatus: 'failed' })
    // The outcome sentinel is not collected as a slot.
    expect(draft.slots).toEqual([])

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const redraft = draftFromChipDoc({ name: 'Refund', trigger: 'wants a refund', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    expect(redraft.transitions.find((transition) => transition.guardKind === 'outcome')).toMatchObject({ guardKind: 'outcome', outcomeStatus: 'failed' })
  })

  it('falls back to Form for an outcome guard that carries no status', () => {
    const base = draftFromChipDoc({
      name: 'Refund',
      trigger: 'wants a refund',
      blocks: [
        { text: 'Issue the refund ', chips: [{ kind: 'skill', refId: 'issue_refund' }] },
        { text: '', chips: [
          { kind: 'condition', refId: OUTCOME_GUARD_REF, value: 'failed' },
          { kind: 'handoff', refId: 'handoff' },
        ] },
      ],
      variables: [],
    })
    expect(routineToChipDoc(base)).not.toBeNull()
    const stripped = {
      ...base,
      transitions: base.transitions.map((transition) =>
        transition.guardKind === 'outcome' ? { ...transition, outcomeStatus: null } : transition),
    }
    expect(routineToChipDoc(stripped)).toBeNull()
  })

  it('authors a slot_filled branch from a "when provided" sentinel chip', () => {
    const draft = draftFromChipDoc({
      name: 'Verify',
      trigger: 'needs verification',
      blocks: [
        { text: 'Ask for their {{slot.email}}.', chips: [{ kind: 'variable', refId: 'email' }] },
        { text: '', chips: [
          { kind: 'condition', refId: SLOT_FILLED_GUARD_REF, values: ['email'] },
          { kind: 'handoff', refId: 'handoff' },
        ] },
        { text: 'Continue.', chips: [] },
      ],
      variables: [{ id: 'email', name: 'email', type: 'email' }],
    })
    const edge = draft.transitions.find((transition) => transition.guardKind === 'slot_filled')
    expect(edge).toMatchObject({ toRef: 'handoff', guardKind: 'slot_filled' })
    // The referenced slots are carried as {{slot.x}} tokens so the compiler can extract them.
    expect(edge!.guardText).toContain('{{slot.email}}')
    // The sentinel is not itself collected as a slot.
    expect(draft.slots.map((slot) => slot.key)).toEqual(['email'])
  })

  it('renders and round-trips a slot_filled branch to a titled jump target', () => {
    const draft = draftFromChipDoc({
      name: 'Verify',
      trigger: 'needs verification',
      blocks: [
        { text: 'Ask for their {{slot.email}} and {{slot.order_id}}.', chips: [
          { kind: 'variable', refId: 'email' },
          { kind: 'variable', refId: 'order_id' },
        ] },
        { text: '', chips: [
          { kind: 'condition', refId: SLOT_FILLED_GUARD_REF, values: ['email', 'order_id'] },
          { kind: 'handoff', refId: 'handoff' },
        ] },
        { text: 'Continue.', chips: [] },
      ],
      variables: [
        { id: 'email', name: 'email', type: 'email' },
        { id: 'order_id', name: 'order id', type: 'text' },
      ],
    })
    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const chip = doc!.paragraphs.flatMap((paragraph) => paragraph.segments)
      .find((segment) => segment.kind === 'chip' && segment.refId === SLOT_FILLED_GUARD_REF)
    expect(chip).toMatchObject({ chipKind: 'condition', values: ['email', 'order_id'] })
    const redraft = draftFromChipDoc({ name: 'Verify', trigger: 'needs verification', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    const edge = redraft.transitions.find((transition) => transition.guardKind === 'slot_filled')
    expect(edge).toMatchObject({ guardKind: 'slot_filled' })
    expect(edge!.guardText).toContain('{{slot.email}}')
    expect(edge!.guardText).toContain('{{slot.order_id}}')
  })

  it('falls back to Form for a slot_filled guard that references no slots', () => {
    const base = draftFromChipDoc({
      name: 'Verify',
      trigger: 'needs verification',
      blocks: [
        { text: 'Ask for their {{slot.email}}.', chips: [{ kind: 'variable', refId: 'email' }] },
        { text: '', chips: [
          { kind: 'condition', refId: SLOT_FILLED_GUARD_REF, values: ['email'] },
          { kind: 'handoff', refId: 'handoff' },
        ] },
        { text: 'Continue.', chips: [] },
      ],
      variables: [{ id: 'email', name: 'email', type: 'email' }],
    })
    expect(routineToChipDoc(base)).not.toBeNull()
    // A slot_filled guard whose guardText names no slots can't render as a "when provided" chip.
    const stripped = {
      ...base,
      transitions: base.transitions.map((transition) =>
        transition.guardKind === 'slot_filled' ? { ...transition, guardText: 'when ready' } : transition),
    }
    expect(routineToChipDoc(stripped)).toBeNull()
  })

  it('declares a slot that is only referenced by a slot-filled guard chip', () => {
    // The slot-filled chip is the sole Prose reference to `email` — no step text, no other
    // condition mentions it. Its slot keys must still be collected so the guardText token
    // ({{slot.email}}) points at a declared slot (else the backend flags referenced_undeclared_slot).
    const draft = draftFromChipDoc({
      name: 'Verify',
      trigger: 'needs verification',
      blocks: [
        { text: 'Run the check.', chips: [] },
        { text: '', chips: [
          { kind: 'condition', refId: SLOT_FILLED_GUARD_REF, values: ['email'] },
          { kind: 'handoff', refId: 'handoff' },
        ] },
        { text: 'Continue.', chips: [] },
      ],
      variables: [{ id: 'email', name: 'email', type: 'email' }],
    })
    expect(draft.slots.map((slot) => slot.key)).toContain('email')
    // The sentinel is never itself treated as a slot.
    expect(draft.slots.map((slot) => slot.key)).not.toContain(SLOT_FILLED_GUARD_REF)
    expect(draft.transitions.find((transition) => transition.guardKind === 'slot_filled')!.guardText).toContain('{{slot.email}}')
  })

  it('reads and round-trips a custom completion message and terminal id', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [{ text: 'Do a thing.', chips: [] }],
      variables: [],
      terminals: { complete: { id: 'complete_1', instruction: 'Thanks, all done!' } },
    })
    expect(draft.terminals).toEqual([
      { stableStepId: 'complete_1', kind: 'complete', instruction: 'Thanks, all done!', ordinal: 0 },
    ])
    // The single-step chain completes into the configured terminal id.
    expect(draft.transitions.at(-1)).toMatchObject({ toRef: 'complete_1', guardKind: 'default' })

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const config = readProseTerminals(draft)
    expect(config.complete).toEqual({ id: 'complete_1', instruction: 'Thanks, all done!' })

    const redraft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: paragraphsToBlocks(doc!.paragraphs),
      variables: doc!.variables,
      terminals: config,
    })
    expect(redraft.terminals).toEqual(draft.terminals)
  })

  it('round-trips a second, named completion whose message rides on the end chip', () => {
    const draft = draftFromChipDoc({
      name: 'Refund',
      trigger: 'wants a refund',
      variables: [],
      blocks: [
        { text: 'Check refund eligibility.', chips: [] },
        { text: 'If the order is not eligible,', chips: [{ kind: 'end', refId: 'ineligible', value: 'Sorry, this order is not eligible.' }] },
        { text: 'Process the refund and finish.', chips: [] },
      ],
    })
    // Two complete terminals: the default fall-through (done) plus the named ending.
    const completes = draft.terminals.filter((terminal) => terminal.kind === 'complete')
    expect(completes.map((terminal) => terminal.stableStepId).sort()).toEqual(['done', 'ineligible'])
    const ineligible = completes.find((terminal) => terminal.stableStepId === 'ineligible')
    expect(ineligible?.instruction).toBe('Sorry, this order is not eligible.')
    // The eligibility branch ends at the named terminal, not the default one.
    expect(draft.transitions.some((transition) => transition.toRef === 'ineligible')).toBe(true)

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const endChip = doc!.paragraphs.flatMap((paragraph) => paragraph.segments)
      .find((segment) => segment.kind === 'chip' && segment.chipKind === 'end' && segment.refId === 'ineligible')
    expect(endChip).toMatchObject({ refId: 'ineligible', value: 'Sorry, this order is not eligible.' })

    const redraft = draftFromChipDoc({ name: 'Refund', trigger: 'wants a refund', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    const redraftIneligible = redraft.terminals.find((terminal) => terminal.stableStepId === 'ineligible')
    expect(redraftIneligible).toMatchObject({ kind: 'complete', instruction: 'Sorry, this order is not eligible.' })
    expect(redraft.terminals.filter((terminal) => terminal.kind === 'complete')).toHaveLength(2)
  })

  it('reads and round-trips a custom handoff message and terminal id', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [
        { text: 'Check the order.', chips: [] },
        { text: '', chips: [{ kind: 'handoff', refId: 'handoff' }] },
      ],
      variables: [],
      terminals: { handoff: { id: 'escalate', instruction: 'Let me get a teammate.' } },
    })
    const handoff = draft.terminals.find((terminal) => terminal.kind === 'handoff')
    expect(handoff).toEqual({ stableStepId: 'escalate', kind: 'handoff', instruction: 'Let me get a teammate.', ordinal: 1 })
    // The handoff branch targets the configured terminal id.
    expect(draft.transitions.some((transition) => transition.toRef === 'escalate')).toBe(true)

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const config = readProseTerminals(draft)
    expect(config.handoff).toEqual({ id: 'escalate', instruction: 'Let me get a teammate.' })

    const redraft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: paragraphsToBlocks(doc!.paragraphs),
      variables: doc!.variables,
      terminals: config,
    })
    expect(redraft.terminals.find((terminal) => terminal.kind === 'handoff')).toEqual(handoff)
  })

  it('reads and round-trips completion export config', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [{ text: 'Do a thing.', chips: [] }],
      variables: [],
      completionExport: { enabled: true, triggerKinds: ['complete'], destinationRef: 'dest_1' },
    })
    expect(draft.completionExport).toEqual({ enabled: true, triggerKinds: ['complete'], destinationRef: 'dest_1' })
    // A routine with completion export now opens in prose instead of falling back to Form.
    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    expect(readProseCompletionExport(draft)).toEqual({ enabled: true, triggerKinds: ['complete'], destinationRef: 'dest_1' })

    const redraft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: paragraphsToBlocks(doc!.paragraphs),
      variables: doc!.variables,
      completionExport: readProseCompletionExport(draft),
    })
    expect(redraft.completionExport).toEqual(draft.completionExport)
  })

  it('defaults enabled completion export to the complete trigger when all triggers are toggled off', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [{ text: 'Do a thing.', chips: [] }],
      variables: [],
      completionExport: { enabled: true, triggerKinds: [], destinationRef: 'dest_1' },
    })

    expect(draft.completionExport).toEqual({ enabled: true, triggerKinds: ['complete'], destinationRef: 'dest_1' })
  })

  it('omits completion export when it is disabled or absent', () => {
    const none = draftFromChipDoc({ name: 'x', trigger: 'y', blocks: [{ text: 'Do a thing.', chips: [] }], variables: [] })
    expect(none.completionExport).toBeUndefined()
    expect(readProseCompletionExport(none)).toBeNull()
  })

  it('defaults to a done terminal with null instruction when no terminal config is given', () => {
    const draft = draftFromChipDoc({ name: 'x', trigger: 'y', blocks: [{ text: 'Do a thing.', chips: [] }], variables: [] })
    expect(draft.terminals).toEqual([{ stableStepId: 'done', kind: 'complete', instruction: null, ordinal: 0 }])
  })

  it('round-trips an optional (non-required) slot through prose', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [{ text: 'Ask for {{slot.email}}.', chips: [{ kind: 'variable', refId: 'email' }] }],
      variables: [{ id: 'email', name: 'email', type: 'email', required: false }],
    })
    expect(draft.slots[0]!.required).toBe(false)
    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    expect(doc!.variables[0]).toMatchObject({ id: 'email', required: false })
    const redraft = draftFromChipDoc({ name: 'x', trigger: 'y', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    expect(redraft.slots[0]!.required).toBe(false)
  })

  it('round-trips a mutable slot through prose', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [{ text: 'Ask for {{slot.email}}.', chips: [{ kind: 'variable', refId: 'email' }] }],
      variables: [{ id: 'email', name: 'email', type: 'email', mutable: true }],
    })
    expect(draft.slots[0]!.mutable).toBe(true)
    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    expect(doc!.variables[0]).toMatchObject({ id: 'email', mutable: true })
    const redraft = draftFromChipDoc({ name: 'x', trigger: 'y', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    expect(redraft.slots[0]!.mutable).toBe(true)
  })

  it('defaults a slot to required and non-mutable, omitting the flags from the chip variable', () => {
    const draft = draftFromChipDoc({
      name: 'x',
      trigger: 'y',
      blocks: [{ text: 'Ask for {{slot.email}}.', chips: [{ kind: 'variable', refId: 'email' }] }],
      variables: [{ id: 'email', name: 'email', type: 'email' }],
    })
    expect(draft.slots[0]!.required).toBe(true)
    expect(draft.slots[0]!.mutable).toBeUndefined()
    const doc = routineToChipDoc(draft)
    expect(doc!.variables[0]).toEqual({ id: 'email', name: 'email', type: 'email' })
  })

  it('compiles an approval chip into an approval step with one field guard per option', () => {
    const draft = draftFromChipDoc({
      name: 'Refund approval',
      trigger: 'wants a large refund',
      blocks: [
        { text: 'Summarize the refund request.', chips: [] },
        {
          text: 'Get a manager decision.',
          chips: [{
            kind: 'approval',
            refId: 'refund_decision',
            captureKey: 'refund_decision',
            options: [
              { id: 'approve', label: 'Approve', target: 'done' },
              { id: 'deny', label: 'Deny', target: 'handoff' },
            ],
          }],
        },
      ],
      variables: [],
    })

    const approvalStep = draft.steps.find((step) => step.kind === 'approval')
    expect(approvalStep).toMatchObject({
      kind: 'approval',
      captureKey: 'refund_decision',
      instruction: 'Get a manager decision.',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    })
    const edges = draft.transitions.filter((transition) => transition.fromStep === approvalStep!.stableStepId)
    expect(edges).toEqual([
      expect.objectContaining({ toRef: 'done', guardKind: 'field', fieldRef: 'refund_decision.id', fieldOp: 'equals', fieldValue: 'approve' }),
      expect.objectContaining({ toRef: 'handoff', guardKind: 'field', fieldRef: 'refund_decision.id', fieldOp: 'equals', fieldValue: 'deny' }),
    ])
    // An approval step routes only through its options — never a default edge.
    expect(edges.some((edge) => edge.guardKind === 'default')).toBe(false)
    expect(draft.terminals.map((terminal) => terminal.kind).sort()).toEqual(['complete', 'handoff'])
  })

  it('titles an approval gate with a preceding heading and round-trips it', () => {
    const draft = draftFromChipDoc({
      name: 'Refund approval',
      trigger: 'wants a large refund',
      blocks: [
        { headingLevel: 1, text: 'Manager approval', chips: [] },
        {
          text: 'Get a manager decision.',
          chips: [{
            kind: 'approval',
            refId: 'refund_decision',
            captureKey: 'refund_decision',
            options: [
              { id: 'approve', label: 'Approve', target: 'done' },
              { id: 'deny', label: 'Deny', target: 'handoff' },
            ],
          }],
        },
      ],
      variables: [],
    })
    // The heading names the gate itself — one approval step, not a chat step plus a gate.
    expect(draft.steps.filter((step) => step.kind === 'chat')).toHaveLength(0)
    const approval = draft.steps.find((step) => step.kind === 'approval')
    expect(approval).toMatchObject({ stableStepId: 'manager_approval', kind: 'approval', captureKey: 'refund_decision', instruction: 'Get a manager decision.' })
    expect((approval!.metadata as Record<string, unknown>).outlineLabel).toBe('Manager approval')

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    // The gate renders under its h1 heading.
    expect(doc!.paragraphs.some((paragraph) => paragraph.headingLevel === 1
      && paragraph.segments.some((segment) => segment.kind === 'text' && segment.text === 'Manager approval'))).toBe(true)
    const redraft = draftFromChipDoc({ name: 'Refund approval', trigger: 'wants a large refund', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    const redraftApproval = redraft.steps.find((step) => step.kind === 'approval')
    expect(redraftApproval).toMatchObject({ stableStepId: 'manager_approval', captureKey: 'refund_decision' })
    expect((redraftApproval!.metadata as Record<string, unknown>).outlineLabel).toBe('Manager approval')
    expect(redraft.steps.filter((step) => step.kind === 'approval')).toHaveLength(1)
  })

  it('lets a branch jump to a titled approval gate by name', () => {
    const draft = draftFromChipDoc({
      name: 'Support',
      trigger: 'needs help',
      blocks: [
        { text: 'Greet the customer.', chips: [] },
        { text: 'If they want a refund,', chips: [{ kind: 'step', refId: 'manager_approval' }] },
        { headingLevel: 1, text: 'Manager approval', chips: [] },
        {
          text: 'Get a manager decision.',
          chips: [{
            kind: 'approval',
            refId: 'refund_decision',
            captureKey: 'refund_decision',
            options: [
              { id: 'approve', label: 'Approve', target: 'done' },
              { id: 'deny', label: 'Deny', target: 'handoff' },
            ],
          }],
        },
      ],
      variables: [],
    })
    const jump = draft.transitions.find((transition) => transition.toRef === 'manager_approval' && transition.guardKind === 'llm')
    expect(jump).toBeDefined()
    // routineToChipDoc must render (not bail) and keep the jump targeting the titled gate.
    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const redraft = draftFromChipDoc({ name: 'Support', trigger: 'needs help', blocks: paragraphsToBlocks(doc!.paragraphs), variables: doc!.variables })
    expect(redraft.transitions.some((transition) => transition.toRef === 'manager_approval' && transition.guardKind === 'llm')).toBe(true)
    expect(redraft.steps.find((step) => step.stableStepId === 'manager_approval')?.kind).toBe('approval')
  })

  // RFC: author an approval as a `@decision` declaration (choices + labels) plus ordinary
  // inline branch lines, instead of one block chip. It must compile to the SAME approval-step
  // graph the block chip produces — proving the inline model is just the existing graph spelled
  // out, with the branches now editable as prose.
  it('compiles an inline decision (declaration + branch lines) to the same approval graph as a block chip', () => {
    const draft = draftFromChipDoc({
      name: 'Refund approval',
      trigger: 'wants a large refund',
      blocks: [
        { text: 'Summarize the refund request.', chips: [] },
        {
          text: 'Get a manager decision.',
          chips: [{
            kind: 'decision',
            refId: 'refund_decision',
            captureKey: 'refund_decision',
            options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
          }],
        },
        { text: '', chips: [{ kind: 'condition', refId: 'refund_decision', op: 'equals', value: 'approve' }, { kind: 'end', refId: 'done' }] },
        { text: '', chips: [{ kind: 'condition', refId: 'refund_decision', op: 'equals', value: 'deny' }, { kind: 'handoff', refId: 'handoff' }] },
      ],
      variables: [],
    })

    const approvalStep = draft.steps.find((step) => step.kind === 'approval')
    expect(approvalStep).toMatchObject({
      kind: 'approval',
      captureKey: 'refund_decision',
      instruction: 'Get a manager decision.',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    })
    const edges = draft.transitions.filter((transition) => transition.fromStep === approvalStep!.stableStepId)
    expect(edges).toEqual([
      expect.objectContaining({ toRef: 'done', guardKind: 'field', fieldRef: 'refund_decision.id', fieldOp: 'equals', fieldValue: 'approve' }),
      expect.objectContaining({ toRef: 'handoff', guardKind: 'field', fieldRef: 'refund_decision.id', fieldOp: 'equals', fieldValue: 'deny' }),
    ])
    // No default/llm edge out of the gate — every path is a decision branch.
    expect(edges.every((edge) => edge.guardKind === 'field')).toBe(true)
    expect(draft.terminals.map((terminal) => terminal.kind).sort()).toEqual(['complete', 'handoff'])
  })

  it('reverse-renders an approval step as an inline decision declaration + branch lines', () => {
    const draft = draftFromChipDoc({
      name: 'Refund approval',
      trigger: 'wants a large refund',
      blocks: [
        {
          text: 'Get a manager decision.',
          chips: [{
            kind: 'approval',
            refId: 'refund_decision',
            captureKey: 'refund_decision',
            options: [
              { id: 'approve', label: 'Approve', target: 'done' },
              { id: 'deny', label: 'Deny', target: 'handoff' },
            ],
          }],
        },
      ],
      variables: [],
    })

    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const segments = doc!.paragraphs.flatMap((p) => p.segments).filter((s) => s.kind === 'chip')
    // One declaration chip carrying the choices, no targets on it…
    expect(segments).toContainEqual(expect.objectContaining({
      chipKind: 'decision',
      captureKey: 'refund_decision',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    }))
    // …and one branch line per choice (condition on the decision → its target).
    expect(segments).toContainEqual(expect.objectContaining({ chipKind: 'condition', refId: 'refund_decision', value: 'approve' }))
    expect(segments).toContainEqual(expect.objectContaining({ chipKind: 'end' }))
    expect(segments).toContainEqual(expect.objectContaining({ chipKind: 'condition', refId: 'refund_decision', value: 'deny' }))
    expect(segments).toContainEqual(expect.objectContaining({ chipKind: 'handoff' }))
    // The block-chip 'approval' rendering is gone — it's all inline now.
    expect(segments.some((s) => s.kind === 'chip' && s.chipKind === 'approval')).toBe(false)
  })

  it('round-trips an approval gate (no force-fallback to Form)', () => {
    const { draft, redraft } = roundTrip(
      'Refund approval',
      'wants a large refund',
      [
        { text: 'Summarize the refund request.', chips: [] },
        {
          text: 'Get a manager decision.',
          chips: [{
            kind: 'approval',
            refId: 'refund_decision',
            captureKey: 'refund_decision',
            options: [
              { id: 'approve', label: 'Approve', target: 'done' },
              { id: 'deny', label: 'Deny', target: 'handoff' },
            ],
          }],
        },
      ],
      [],
    )
    expect(draft.steps.some((step) => step.kind === 'approval')).toBe(true)
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
    expect(redraft.terminals).toEqual(draft.terminals)
  })

  it('round-trips an approval option that branches to a titled step', () => {
    const { draft, redraft } = roundTrip(
      'Escalation',
      'needs a decision',
      [
        {
          text: 'Review the case.',
          chips: [{
            kind: 'approval',
            refId: 'decision',
            captureKey: 'decision',
            options: [
              { id: 'proceed', label: 'Proceed', target: 'fulfill' },
              { id: 'reject', label: 'Reject', target: 'done' },
            ],
          }],
        },
        { text: 'Fulfill', chips: [], headingLevel: 1 },
        { text: 'Complete the order.', chips: [] },
      ],
      [],
    )
    const approvalStep = draft.steps.find((step) => step.kind === 'approval')!
    expect(draft.transitions).toContainEqual(
      expect.objectContaining({ fromStep: approvalStep.stableStepId, toRef: 'fulfill', guardKind: 'field', fieldValue: 'proceed' }),
    )
    expect(redraft.steps).toEqual(draft.steps)
    expect(redraft.transitions).toEqual(draft.transitions)
  })

  it('renders an approval option that has no branch line yet (author can add it inline)', () => {
    const draft = draftFromChipDoc({
      name: 'Refund approval',
      trigger: 'wants a large refund',
      blocks: [{
        text: 'Get a manager decision.',
        chips: [{
          kind: 'approval',
          refId: 'refund_decision',
          captureKey: 'refund_decision',
          options: [
            { id: 'approve', label: 'Approve', target: 'done' },
            { id: 'deny', label: 'Deny', target: '' },
          ],
        }],
      }],
      variables: [],
    })
    // The inline model can show this where the block chip couldn't: it declares both choices,
    // but only renders a branch line for the routed one — so the author sees `deny` is missing
    // a branch and fixes it in place (the validator flags it as unreachable) instead of being
    // bounced to the Form editor.
    const doc = routineToChipDoc(draft)
    expect(doc).not.toBeNull()
    const decision = doc!.paragraphs.flatMap((p) => p.segments).find((s) => s.kind === 'chip' && s.chipKind === 'decision')
    expect(decision).toMatchObject({ options: [{ id: 'approve' }, { id: 'deny' }] })
    const branchValues = doc!.paragraphs
      .flatMap((p) => p.segments)
      .filter((s) => s.kind === 'chip' && s.chipKind === 'condition')
      .map((s) => (s as { value?: unknown }).value)
    expect(branchValues).toEqual(['approve'])
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
