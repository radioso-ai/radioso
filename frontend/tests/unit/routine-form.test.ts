import { describe, expect, it } from 'vitest'

import type { RoutineDefinition } from '@/lib/api'
import {
  createEmptyRoutineForm,
  createTransitionForm,
  diagnosticTargetFor,
  diagnosticsForTarget,
  formToRoutineDraft,
  routineToForm,
} from '@/lib/routine-form'

const routine = {
  id: 'routine-1',
  agentId: 'agent-1',
  name: 'Collect intake',
  status: 'draft',
  version: 1,
  createdAt: '2026-04-26T12:00:00.000Z',
  updatedAt: '2026-04-26T12:00:00.000Z',
  activation: {
    triggerDescription: 'Visitor asks for pricing',
    gateRef: null,
    priority: 10,
  },
  slots: [{
    stableSlotId: 'slot_email',
    key: 'email',
    type: 'email',
    required: true,
    description: 'Visitor email',
    ordinal: 0,
  }],
  steps: [{
    stableStepId: 'ask_email',
    kind: 'chat',
    instruction: 'Ask for {{slot.email}}.',
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: 'ask_email',
    toRef: 'complete',
    guardKind: 'default',
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: 'complete',
    kind: 'complete',
    instruction: null,
    ordinal: 0,
  }],
} satisfies RoutineDefinition

describe('routine form transforms', () => {
  it('round-trips a routine definition through the form model', () => {
    const form = routineToForm(routine)

    expect(form.steps[0]?.transitions).toEqual([{
      fromStep: 'ask_email',
      toRef: 'complete',
      guardKind: 'default',
      guardText: '',
      outcomeStatus: '',
      counterLimit: '',
    }])
    expect(formToRoutineDraft(form)).toEqual({
      name: routine.name,
      activation: {
        triggerDescription: routine.activation.triggerDescription,
        priority: 10,
      },
      slots: routine.slots,
      steps: routine.steps,
      transitions: routine.transitions,
      terminals: routine.terminals,
    })
  })

  it('builds a valid structured draft from a new form', () => {
    const form = createEmptyRoutineForm()
    form.name = '  Demo routine  '
    form.activation.triggerDescription = '  Visitor wants help  '
    form.slots = [{
      stableSlotId: 'Customer Email',
      key: 'customer_email',
      type: 'email',
      required: true,
      description: '  Email address  ',
    }]
    form.steps[0] = {
      ...form.steps[0]!,
      instruction: 'Ask for {{slot.customer_email}}.',
      transitions: [createTransitionForm('step_1', 'complete')],
    }

    expect(formToRoutineDraft(form)).toMatchObject({
      name: 'Demo routine',
      activation: { triggerDescription: 'Visitor wants help', priority: 0 },
      slots: [{
        stableSlotId: 'Customer_Email',
        key: 'customer_email',
        description: 'Email address',
      }],
      transitions: [{ fromStep: 'step_1', toRef: 'complete', guardKind: 'default' }],
    })
  })

  it('round-trips an action step with its action type and transition', () => {
    const actionRoutine: RoutineDefinition = {
      ...routine,
      steps: [
        ...routine.steps,
        {
          stableStepId: 'send',
          kind: 'action',
          instruction: 'Emit the contact request.',
          toolRef: null,
          actionType: 'contact.send',
          ordinal: 1,
          metadata: {},
        },
      ],
      transitions: [
        {
          fromStep: 'ask_email',
          toRef: 'send',
          guardKind: 'default',
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 0,
        },
        {
          fromStep: 'send',
          toRef: 'complete',
          guardKind: 'default',
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 1,
        },
      ],
    }

    const form = routineToForm(actionRoutine)

    expect(form.steps[1]).toMatchObject({
      stableStepId: 'send',
      kind: 'action',
      actionType: 'contact.send',
      transitions: [{
        fromStep: 'send',
        toRef: 'complete',
        guardKind: 'default',
      }],
    })
    expect(formToRoutineDraft(form).steps[1]).toMatchObject({
      stableStepId: 'send',
      kind: 'action',
      actionType: 'contact.send',
    })
    expect(formToRoutineDraft(form).transitions).toEqual(actionRoutine.transitions)
  })

  it('normalizes legacy fork steps and unconditioned guards from older payloads', () => {
    const legacyRoutine = {
      ...routine,
      steps: [{
        ...routine.steps[0]!,
        kind: 'fork',
      }],
      transitions: [
        {
          ...routine.transitions[0]!,
          guardKind: 'always',
        },
        {
          ...routine.transitions[0]!,
          guardKind: 'fallback',
          ordinal: 1,
        },
      ],
    } as unknown as RoutineDefinition

    const form = routineToForm(legacyRoutine)

    expect(form.steps[0]).toMatchObject({
      kind: 'chat',
      transitions: [
        expect.objectContaining({ guardKind: 'default' }),
        expect.objectContaining({ guardKind: 'default' }),
      ],
    })
    expect(formToRoutineDraft(form).steps[0]?.kind).toBe('chat')
    expect(formToRoutineDraft(form).transitions.map((transition) => transition.guardKind)).toEqual([
      'default',
      'default',
    ])
  })

  it('preserves step metadata so alternate authoring projections do not lose labels', () => {
    const metadataRoutine: RoutineDefinition = {
      ...routine,
      steps: [{
        ...routine.steps[0]!,
        metadata: { outlineLabel: 'Ask for email' },
      }],
    }

    const form = routineToForm(metadataRoutine)

    expect(form.steps[0]?.metadata).toEqual({ outlineLabel: 'Ask for email' })
    expect(formToRoutineDraft(form).steps[0]?.metadata).toEqual({ outlineLabel: 'Ask for email' })
  })
})

describe('routine diagnostic mapping', () => {
  const diagnostics = [
    { code: 'declared_unused_slot' as const, location: 'slot:email', message: 'Unused slot' },
    { code: 'missing_terminal' as const, location: 'routine:Collect intake', message: 'Missing terminal' },
    { code: 'dangling_step_reference' as const, location: 'transition:ask_email->complete', message: 'Bad target' },
  ]

  it('maps backend diagnostic locations to form targets', () => {
    expect(diagnosticTargetFor(diagnostics[0]!)).toEqual({ scope: 'slot', id: 'email' })
    expect(diagnosticTargetFor(diagnostics[1]!)).toEqual({ scope: 'routine', id: 'Collect intake' })
    expect(diagnosticTargetFor(diagnostics[2]!)).toEqual({ scope: 'transition', id: 'ask_email->complete' })
  })

  it('filters diagnostics for an inline target', () => {
    expect(diagnosticsForTarget(diagnostics, { scope: 'slot', id: 'email' })).toEqual([diagnostics[0]])
    expect(diagnosticsForTarget(diagnostics, { scope: 'step', id: 'ask_email' })).toEqual([])
  })
})
