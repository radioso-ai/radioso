import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

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
} as CompleteAuthoringDraft)

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

  it('carries a shared ending inline once and retains an unreferenced ending', () => {
    const input = draft()
    const projected = routineToBlockDoc(input)
    expect(projected).toMatchObject({ ok: true })
    if (!projected.ok) return
    expect(projected.doc.steps[0]?.branches[0]?.target).toMatchObject({ kind: 'ending', terminalId: 'finished', ending: { kind: 'complete' } })
    expect(projected.doc.steps[1]?.branches[0]?.target).toEqual({ kind: 'ending', terminalId: 'finished' })
    expect(projected.doc.unreferencedEndings).toMatchObject([{ stableStepId: 'human', kind: 'handoff', instruction: 'A person will take over.' }])
    expect(routineDefinitionDraftInputSchema.parse(draftFromBlockDoc(projected.doc))).toEqual(withDocumentOrdinals(input))
  })

  it('returns diagnostics instead of dropping an unresolved transition target', () => {
    const input = draft({ transitions: [{ fromStep: 'collect', toRef: 'missing', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }] })
    expect(routineToBlockDoc(input)).toEqual({ ok: false, diagnostics: [{ code: 'unknown_transition_target', message: 'Transition from "collect" targets unknown id "missing".' }] })
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
      fc.constantFrom('chat', 'tool', 'action') as fc.Arbitrary<'chat' | 'tool' | 'action'>,
      fc.constantFrom('llm', 'default', 'slot_filled', 'outcome', 'counter', 'field') as fc.Arbitrary<'llm' | 'default' | 'slot_filled' | 'outcome' | 'counter' | 'field'>,
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
