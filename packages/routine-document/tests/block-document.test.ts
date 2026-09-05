import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@radioso/routine-definition', async () => import('../../routine-definition/src/index.ts'))

import { routineDefinitionDraftInputSchema, type RoutineDefinitionDraftAuthoringInput } from '@radioso/routine-definition'
import {
  draftFromBlockDoc,
  routineToBlockDoc,
} from '../src/index.js'

type CompleteAuthoringDraft = RoutineDefinitionDraftAuthoringInput & {
  slots: NonNullable<RoutineDefinitionDraftAuthoringInput['slots']>
  steps: NonNullable<RoutineDefinitionDraftAuthoringInput['steps']>
  transitions: NonNullable<RoutineDefinitionDraftAuthoringInput['transitions']>
  terminals: NonNullable<RoutineDefinitionDraftAuthoringInput['terminals']>
}

const draft = (overrides: Record<string, unknown> = {}): CompleteAuthoringDraft => ({
  name: 'Escalate account',
  activation: { triggerDescription: 'An account needs help', gateRef: 'support_gate', priority: 4, reentryMode: 'always' },
  slots: [{ stableSlotId: 'account_id', key: 'account_id', type: 'text', required: false, description: 'Customer account', mutable: true, ordinal: 9 }],
  steps: [{
    stableStepId: 'collect', kind: 'tool', instruction: 'Find {{slot.account_id}} for review.', toolRef: 'lookup_account', actionType: null, ordinal: 7,
    metadata: {
      inputBindings: { account: { kind: 'variableRef', ref: 'account_id' }, retries: { kind: 'literal', value: 2 }, locale: { kind: 'contextVariableRef', contextVariable: 'locale' } },
      outputAssignments: { status: 'account_status' }, mode: 'untyped', preserveMe: { nested: true },
    },
  }, {
    stableStepId: 'notify', kind: 'action', instruction: 'Notify the owner.', toolRef: null, actionType: 'notify_owner', ordinal: 8, metadata: {},
  }],
  transitions: [{ fromStep: 'collect', toRef: 'finished', guardKind: 'field', guardText: 'The status is ready', outcomeStatus: null, counterLimit: null, fieldRef: 'account_status', fieldOp: 'equals', fieldValue: 'ready', fieldValues: null, fieldUnit: null, ordinal: 7 }, { fromStep: 'notify', toRef: 'finished', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 8 }],
  terminals: [{ stableStepId: 'finished', kind: 'complete', instruction: 'All done.', ordinal: 5 }, { stableStepId: 'human', kind: 'handoff', instruction: 'A person will take over.', ordinal: 6 }],
  completionExport: { enabled: true, triggerKinds: ['complete', 'handoff'], destinationRef: 'crm' },
  ...overrides,
})

const roundTrip = (input: ReturnType<typeof draft>) => {
  const projected = routineToBlockDoc(input)
  expect(projected.ok).toBe(true)
  if (!projected.ok) throw new Error(projected.diagnostics[0]?.code)
  const restored = routineDefinitionDraftInputSchema.parse(draftFromBlockDoc(projected.doc))
  return { projected, restored }
}

const withDocumentOrdinals = (input: ReturnType<typeof draft>) => ({
  ...input,
  slots: [...input.slots].sort((left, right) => left.ordinal - right.ordinal).map((slot, ordinal) => ({ ...slot, ordinal })),
  steps: [...input.steps].sort((left, right) => left.ordinal - right.ordinal).map((step, ordinal) => ({ ...step, ordinal })),
  transitions: [...input.transitions].sort((left, right) => left.ordinal - right.ordinal).map((transition, ordinal) => ({ ...transition, ordinal })),
  terminals: [...input.terminals].sort((left, right) => left.ordinal - right.ordinal).map((terminal, ordinal) => ({ ...terminal, ordinal })),
})

describe('routine block document', () => {
  it('projects an empty draft to an empty document and round-trips empty arrays', () => {
    const input: RoutineDefinitionDraftAuthoringInput = {
      name: 'New routine',
      activation: { triggerDescription: 'Start here', gateRef: null, priority: 0 },
      slots: [],
    }

    const projected = routineToBlockDoc(input)

    expect(projected).toEqual({
      ok: true,
      doc: {
        name: 'New routine',
        activation: { triggerDescription: 'Start here', gateRef: null, priority: 0, reentryMode: 'once_per_conversation' },
        information: [],
        steps: [],
        unreferencedEndings: [],
      },
    })
    if (!projected.ok) return
    expect(draftFromBlockDoc(projected.doc)).toMatchObject({ slots: [], steps: [], transitions: [], terminals: [] })
  })

  it('preserves slots and activation when an authoring draft has no steps', () => {
    const input: RoutineDefinitionDraftAuthoringInput = {
      name: 'New routine',
      activation: { triggerDescription: 'Start here', gateRef: 'support_gate', priority: 3, reentryMode: 'always' },
      slots: [{ stableSlotId: 'account_id', key: 'account_id', type: 'text', required: true, description: 'Customer account', mutable: false, ordinal: 4 }],
    }

    const projected = routineToBlockDoc(input)

    expect(projected).toMatchObject({
      ok: true,
      doc: {
        activation: input.activation,
        information: [{ stableSlotId: 'account_id', key: 'account_id', type: 'text', required: true, description: 'Customer account', mutable: false }],
        steps: [],
        unreferencedEndings: [],
      },
    })
    if (!projected.ok) return
    expect(draftFromBlockDoc(projected.doc)).toMatchObject({
      activation: input.activation,
      slots: [{ stableSlotId: 'account_id', key: 'account_id', type: 'text', required: true, description: 'Customer account', mutable: false, ordinal: 0 }],
      steps: [],
      transitions: [],
      terminals: [],
    })
  })

  it('projects and round-trips the new-routine seed with empty authoring text', () => {
    const input = {
      name: 'New routine',
      activation: { triggerDescription: '', gateRef: null, priority: 0, reentryMode: 'once_per_conversation' },
      slots: [],
      steps: [{ stableStepId: 'start', kind: 'chat' as const, instruction: '', toolRef: null, actionType: null, captureKey: null, options: [], ordinal: 0, metadata: {} }],
      transitions: [],
      terminals: [],
    }

    const projected = routineToBlockDoc(input)

    expect(projected).toMatchObject({ ok: true, doc: { activation: input.activation, steps: [{ instruction: [{ kind: 'text', text: '' }] }] } })
    if (!projected.ok) return
    expect(draftFromBlockDoc(projected.doc)).toEqual(input)
  })

  it('projects and round-trips a terminal before its instruction is typed', () => {
    const input = draft({
      terminals: [{ stableStepId: 'finished', kind: 'complete', instruction: '', ordinal: 10 }],
    })

    const projected = routineToBlockDoc(input)

    expect(projected.ok).toBe(true)
    if (!projected.ok) return
    expect(projected.doc.steps[0]?.branches[0]?.target).toMatchObject({
      kind: 'ending',
      terminalId: 'finished',
      ending: { instruction: '' },
    })
    expect(draftFromBlockDoc(projected.doc)).toEqual(withDocumentOrdinals(input))
  })

  it('projects a tool step before its tool is selected', () => {
    const input = {
      name: 'New routine',
      activation: { triggerDescription: 'Start here', gateRef: null, priority: 0, reentryMode: 'once_per_conversation' },
      slots: [],
      steps: [{ stableStepId: 'select-tool', kind: 'tool' as const, instruction: 'Choose a tool.', toolRef: null, actionType: null, captureKey: null, options: [], ordinal: 0, metadata: {} }],
      transitions: [],
      terminals: [],
    }

    const projected = routineToBlockDoc(input)

    expect(projected).toMatchObject({ ok: true, doc: { steps: [{ stableStepId: 'select-tool', toolRef: null }] } })
  })

  it('preserves activation, information, bindings, action references, and completion export', () => {
    const input = draft()
    const { projected, restored } = roundTrip(input)

    expect(projected.doc.activation).toEqual(input.activation)
    expect(projected.doc.information).toEqual([{
      stableSlotId: 'account_id', key: 'account_id', type: 'text', required: false, description: 'Customer account', mutable: true,
    }])
    expect(projected.doc.steps[0]?.instruction).toEqual([
      { kind: 'text', text: 'Find ' },
      { kind: 'slotReference', key: 'account_id', source: '{{slot.account_id}}' },
      { kind: 'text', text: ' for review.' },
    ])
    expect(projected.doc.steps[0]?.inputBindings).toEqual(input.steps[0]?.metadata?.inputBindings)
    expect(projected.doc.steps[0]?.additionalMetadata).toEqual({ preserveMe: { nested: true } })
    expect(projected.doc.completionExport).toEqual(input.completionExport)
    expect(restored).toEqual(withDocumentOrdinals(input))
  })

  it.each(['chat', 'tool', 'action', 'approval'] as const)('round-trips %s steps and approval choices', (kind) => {
    const step = kind === 'approval'
      ? { stableStepId: 'decide', kind, instruction: 'Choose.', toolRef: null, actionType: null, captureKey: 'decision', options: [{ id: 'yes', label: 'Yes', description: 'Proceed' }, { id: 'no', label: 'No', description: null }], ordinal: 0, metadata: {} }
      : { stableStepId: 'decide', kind, instruction: 'Continue.', toolRef: kind === 'tool' ? 'tool_ref' : null, actionType: kind === 'action' ? 'action_ref' : null, ordinal: 0, metadata: {} }
    const input = draft({ steps: [step], transitions: [{ fromStep: 'decide', toRef: 'finished', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }] })
    expect(roundTrip(input).restored).toEqual(withDocumentOrdinals(input))
  })

  it.each([
    { guardKind: 'llm', guardText: 'Use judgment', outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, provenance: 'judgment' },
    { guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, provenance: 'exact' },
    { guardKind: 'slot_filled', guardText: '{{slot.account_id}}', outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, provenance: 'exact' },
    { guardKind: 'outcome', guardText: null, outcomeStatus: 'failed', counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, provenance: 'exact' },
    { guardKind: 'counter', guardText: null, outcomeStatus: null, counterLimit: 3, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, provenance: 'exact' },
    { guardKind: 'field', guardText: 'custom author text', outcomeStatus: null, counterLimit: null, fieldRef: 'account_status', fieldOp: 'in', fieldValue: null, fieldValues: ['ready', 'pending'], fieldUnit: null, provenance: 'exact' },
  ] as const)('round-trips %s guards with typed provenance', (guard) => {
    const { provenance, guardKind: _guardKind, ...transition } = guard
    const input = draft({ transitions: [{ fromStep: 'collect', toRef: 'finished', guardKind: guard.guardKind, ordinal: 0, ...transition }] })
    const { projected, restored } = roundTrip(input)
    expect(projected.doc.steps[0]?.branches[0]?.guard).toMatchObject({ ...transition, kind: guard.guardKind, provenance })
    if (guard.guardKind === 'slot_filled') {
      expect(projected.doc.steps[0]?.branches[0]?.guard).toMatchObject({ slotKeys: ['account_id'] })
    }
    expect(restored).toEqual(withDocumentOrdinals(input))
  })

  it('normalizes slot-filled guards from their parsed slot keys', () => {
    const input = draft({
      transitions: [{ fromStep: 'collect', toRef: 'finished', guardKind: 'slot_filled', guardText: '{{ slot.account_id }} {{slot.account_id}} {{ slot.contact }}', outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }],
    })
    const { projected, restored } = roundTrip(input)

    expect(projected.doc.steps[0]?.branches[0]?.guard).toMatchObject({ slotKeys: ['account_id', 'contact'] })
    expect(restored.transitions[0]?.guardText).toBe('{{slot.account_id}} {{slot.contact}}')
  })

  it('embeds a shared ending on every referencing branch and retains an unreferenced ending', () => {
    const input = draft()
    const projected = routineToBlockDoc(input)
    expect(projected).toMatchObject({ ok: true })
    if (!projected.ok) return
    // Every branch carries the full definition so removing or retargeting one branch cannot
    // take the ending away from another; the inverse mapping deduplicates by stable id.
    expect(projected.doc.steps[0]?.branches[0]?.target).toMatchObject({ kind: 'ending', terminalId: 'finished', ending: { kind: 'complete' } })
    expect(projected.doc.steps[1]?.branches[0]?.target).toMatchObject({ kind: 'ending', terminalId: 'finished', ending: { kind: 'complete' } })
    expect(projected.doc.unreferencedEndings).toMatchObject([{ stableStepId: 'human', kind: 'handoff', instruction: 'A person will take over.' }])
    expect(routineDefinitionDraftInputSchema.parse(draftFromBlockDoc(projected.doc))).toEqual(withDocumentOrdinals(input))
  })

  it('keeps a shared ending alive when the branch that used to carry it is removed', () => {
    const input = draft()
    const projected = routineToBlockDoc(input)
    expect(projected).toMatchObject({ ok: true })
    if (!projected.ok) return
    // Drop the first referencing branch entirely, as the Document tab's remove control does.
    const edited = {
      ...projected.doc,
      steps: projected.doc.steps.map((step, index) => index === 0 ? { ...step, branches: [] } : step),
    }
    const emitted = routineDefinitionDraftInputSchema.parse(draftFromBlockDoc(edited))
    expect(emitted.terminals.map((terminal) => terminal.stableStepId)).toContain('finished')
    expect(routineToBlockDoc(emitted)).toMatchObject({ ok: true })
  })

  it('never drops an unresolved transition target', () => {
    const input = draft({ transitions: [{ fromStep: 'collect', toRef: 'missing', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }] })
    const projected = routineToBlockDoc(input)
    if (!projected.ok) throw new Error('expected a document')

    // The edge is carried as unresolved rather than discarded, so nothing an author wrote
    // disappears by opening the routine.
    expect(projected.doc.steps.find((step) => step.stableStepId === 'collect')?.branches)
      .toEqual([expect.objectContaining({ target: { kind: 'unresolved', toRef: 'missing' } })])
  })

  it('keeps a step and a terminal that collide, leaving the shared name unresolved', () => {
    const input = draft({ terminals: [{ stableStepId: 'collect', kind: 'complete', instruction: 'All done.', ordinal: 0 }] })
    const projected = routineToBlockDoc(input)
    if (!projected.ok) throw new Error('expected a document')

    expect(projected.doc.steps.some((step) => step.stableStepId === 'collect')).toBe(true)
    expect(projected.doc.steps.flatMap((step) => step.branches).every((branch) => branch.target.kind !== 'ending' || branch.target.terminalId !== 'collect')).toBe(true)
  })

  it('returns schema issue paths and messages for an invalid authoring draft', () => {
    const { name: _name, ...input } = draft()

    expect(routineToBlockDoc(input as unknown as RoutineDefinitionDraftAuthoringInput)).toMatchObject({
      ok: false,
      diagnostics: [{
        code: 'schema_validation',
        message: 'Routine definition input is invalid.',
        issues: [{ path: ['name'] }],
      }],
    })
  })

  it('round-trips generated valid routine shapes', () => {
    fc.assert(fc.property(
      fc.constantFrom('chat', 'tool', 'action'),
      fc.constantFrom('llm', 'default', 'slot_filled', 'outcome', 'counter', 'field'),
      fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'), { minLength: 1, maxLength: 8 }).map((characters) => characters.join('')),
      (kind, guardKind, key) => {
        const step = { stableStepId: 'start', kind, instruction: `Use {{slot.${key}}}.`, toolRef: kind === 'tool' ? 'tool' : null, actionType: kind === 'action' ? 'action' : null, ordinal: 0, metadata: {} }
        const guard = guardKind === 'llm' ? { guardText: 'judge', outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null }
          : guardKind === 'slot_filled' ? { guardText: `{{slot.${key}}}`, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null }
            : guardKind === 'outcome' ? { guardText: null, outcomeStatus: 'failed', counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null }
              : guardKind === 'counter' ? { guardText: null, outcomeStatus: null, counterLimit: 2, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null }
                : guardKind === 'field' ? { guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: key, fieldOp: 'equals', fieldValue: 'ok', fieldValues: null, fieldUnit: null }
                  : { guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null }
        const input = draft({ slots: [{ stableSlotId: key, key, type: 'text', required: true, description: null, ordinal: 0 }], steps: [step], transitions: [{ fromStep: 'start', toRef: 'finished', guardKind, ordinal: 0, ...guard }] })
        expect(roundTrip(input).restored).toEqual(withDocumentOrdinals(input))
      },
    ), { numRuns: 50, seed: 100_714 })
  })
})

describe('a routine with an edge that points nowhere', () => {
  // A draft saves without semantic validation, so a step removed through the API or an
  // older row can leave a transition naming an id that no longer exists. The document has
  // to stay readable for the person who has to fix it.
  const danglingDraft = () => draft({
    transitions: [{
      fromStep: 'collect', toRef: 'deleted_step', guardKind: 'default', guardText: null, outcomeStatus: null,
      counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 7,
    }],
  })

  it('still projects the routine instead of refusing it', () => {
    const projected = routineToBlockDoc(danglingDraft())

    expect(projected.ok).toBe(true)
  })

  it('marks the edge unresolved and keeps the id it named', () => {
    const projected = routineToBlockDoc(danglingDraft())
    if (!projected.ok) throw new Error('expected a document')

    const branch = projected.doc.steps.find((step) => step.stableStepId === 'collect')?.branches[0]
    expect(branch?.target).toEqual({ kind: 'unresolved', toRef: 'deleted_step' })
  })

  it('writes the unresolved edge back unchanged, so reading never repairs the data', () => {
    const projected = routineToBlockDoc(danglingDraft())
    if (!projected.ok) throw new Error('expected a document')

    const saved = draftFromBlockDoc(projected.doc)

    expect(saved.transitions.find((transition) => transition.fromStep === 'collect')?.toRef).toBe('deleted_step')
  })

  it('renders both steps when an id is used twice, so the author can rename one', () => {
    const projected = routineToBlockDoc(draft({
      steps: [
        { stableStepId: 'collect', kind: 'chat', instruction: 'First.', toolRef: null, actionType: null, ordinal: 0, metadata: {} },
        { stableStepId: 'collect', kind: 'chat', instruction: 'Second.', toolRef: null, actionType: null, ordinal: 1, metadata: {} },
      ],
      transitions: [{ fromStep: 'collect', toRef: 'collect', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }],
    }))
    if (!projected.ok) throw new Error('expected a document')

    expect(projected.doc.steps).toHaveLength(2)
    // The branch genuinely cannot say which of the two it means, so it resolves to neither
    // and the reader shows it as pointing nowhere.
    expect(projected.doc.steps[0]?.branches[0]?.target).toEqual({ kind: 'unresolved', toRef: 'collect' })
  })
})
