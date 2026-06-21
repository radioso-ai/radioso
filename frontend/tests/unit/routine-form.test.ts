import { describe, expect, it } from 'vitest'

import type { RoutineDefinition } from '@/lib/api'
import {
  buildCompletionExportPayloadPreview,
  createEmptyRoutineForm,
  createTransitionForm,
  diagnosticTargetFor,
  diagnosticsForTarget,
  formToRoutineDraft,
  routineToForm,
} from '@/lib/routine-form'

const routine = {
  id: 'routine-1',
  lineageId: 'lineage-1',
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
    reentryMode: 'always',
  },
  slots: [{
    stableSlotId: 'slot_email',
    key: 'email',
    type: 'email',
    required: true,
    description: 'Visitor email',
    mutable: true,
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
        reentryMode: 'always',
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
      mutable: true,
    }]
    form.steps[0] = {
      ...form.steps[0]!,
      instruction: 'Ask for {{slot.customer_email}}.',
      transitions: [createTransitionForm('step_1', 'complete')],
    }

    expect(formToRoutineDraft(form)).toMatchObject({
      name: 'Demo routine',
      activation: { triggerDescription: 'Visitor wants help', priority: 0, reentryMode: 'once_per_conversation' },
      slots: [{
        stableSlotId: 'Customer_Email',
        key: 'customer_email',
        description: 'Email address',
        mutable: true,
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

  it('round-trips an approval gate with per-option branch targets', () => {
    const approvalRoutine: RoutineDefinition = {
      ...routine,
      slots: [],
      steps: [
        {
          stableStepId: 'review',
          kind: 'approval',
          instruction: 'Approve or deny the refund.',
          toolRef: null,
          captureKey: 'refund_decision',
          options: [
            { id: 'approve', label: 'Approve', description: 'Issue the refund' },
            { id: 'deny', label: 'Deny' },
          ],
          ordinal: 0,
          metadata: {},
        },
        {
          stableStepId: 'issue',
          kind: 'chat',
          instruction: 'Issue the refund.',
          toolRef: null,
          ordinal: 1,
          metadata: {},
        },
      ],
      transitions: [
        {
          fromStep: 'review',
          toRef: 'issue',
          guardKind: 'field',
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          fieldRef: 'refund_decision.id',
          fieldOp: 'equals',
          fieldValue: 'approve',
          fieldValues: null,
          fieldUnit: null,
          ordinal: 0,
        },
        {
          fromStep: 'review',
          toRef: 'complete',
          guardKind: 'field',
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          fieldRef: 'refund_decision.id',
          fieldOp: 'equals',
          fieldValue: 'deny',
          fieldValues: null,
          fieldUnit: null,
          ordinal: 1,
        },
        {
          fromStep: 'issue',
          toRef: 'complete',
          guardKind: 'default',
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 2,
        },
      ],
    } as unknown as RoutineDefinition

    const form = routineToForm(approvalRoutine)

    // The synthesized field guards are recovered as per-option targets, not generic edges.
    expect(form.steps[0]).toMatchObject({
      kind: 'approval',
      captureKey: 'refund_decision',
      transitions: [],
      options: [
        { id: 'approve', label: 'Approve', description: 'Issue the refund', target: 'issue' },
        { id: 'deny', label: 'Deny', description: '', target: 'complete' },
      ],
    })

    const draft = formToRoutineDraft(form)
    expect(draft.steps).toEqual(approvalRoutine.steps)
    expect(draft.transitions).toEqual(approvalRoutine.transitions)
  })

  it('omits disabled completion export from new drafts', () => {
    const form = createEmptyRoutineForm()

    expect(form.completionExport).toEqual({
      enabled: false,
      triggerKinds: ['complete'],
      destinationRef: '',
    })
    expect(formToRoutineDraft(form)).not.toHaveProperty('completionExport')
  })

  it('round-trips enabled completion export settings and builds a payload preview', () => {
    const destinationRef = '33333333-3333-4333-8333-333333333333'
    const form = routineToForm({
      ...routine,
      completionExport: {
        enabled: true,
        triggerKinds: ['complete', 'handoff'],
        destinationRef,
      },
    })

    expect(form.completionExport).toEqual({
      enabled: true,
      triggerKinds: ['complete', 'handoff'],
      destinationRef,
    })
    expect(formToRoutineDraft(form)).toMatchObject({
      completionExport: {
        enabled: true,
        triggerKinds: ['complete', 'handoff'],
        destinationRef,
      },
    })
    expect(buildCompletionExportPayloadPreview(form)).toEqual({
      destinationRef,
      source: {
        routineId: '<routine-id>',
        stepId: '<terminal-step-id>',
        terminalKind: 'complete',
        status: 'completed',
      },
      data: {
        email: '<email>',
      },
    })
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
