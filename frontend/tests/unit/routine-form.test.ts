import { describe, expect, it } from 'vitest'

import type { RoutineDefinition, RoutineDefinitionDraft, RoutineValidationDiagnostic } from '@/lib/api'
import {
  buildCompletionExportPayloadPreview,
  createEmptyRoutineForm,
  createTransitionForm,
  diagnosticTargetFor,
  diagnosticsForTarget,
  formToRoutineDraft,
  renderedDiagnosticTargets,
  routineLevelDiagnostics,
  routineToForm,
  type DiagnosticTarget,
  type RoutineFormState,
  renderedDraftTargets,
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
    fieldRef: null,
    fieldOp: null,
    fieldValue: null,
    fieldValues: null,
    fieldUnit: null,
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
      fieldRef: null,
      fieldOp: null,
      fieldValue: null,
      fieldValues: null,
      fieldUnit: null,
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
          fieldRef: null,
          fieldOp: null,
          fieldValue: null,
          fieldValues: null,
          fieldUnit: null,
          ordinal: 0,
        },
        {
          fromStep: 'send',
          toRef: 'complete',
          guardKind: 'default',
          guardText: null,
          outcomeStatus: null,
          counterLimit: null,
          fieldRef: null,
          fieldOp: null,
          fieldValue: null,
          fieldValues: null,
          fieldUnit: null,
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

  it('preserves field guard parameters through the opaque form projection', () => {
    const fieldGuardDraft: RoutineDefinitionDraft = {
      name: 'Route qualified lead',
      activation: {
        triggerDescription: 'A visitor requests a quote',
        priority: 5,
        reentryMode: 'always',
      },
      slots: [],
      steps: [{
        stableStepId: 'qualify',
        kind: 'chat',
        instruction: 'Qualify the visitor.',
        toolRef: null,
        ordinal: 0,
        metadata: {},
      }],
      transitions: [{
        fromStep: 'qualify',
        toRef: 'complete',
        guardKind: 'field',
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        fieldRef: 'lead.score',
        fieldOp: 'within',
        fieldValue: 14,
        fieldValues: ['hot', 'warm'],
        fieldUnit: 'days',
        ordinal: 0,
      }],
      terminals: [{
        stableStepId: 'complete',
        kind: 'complete',
        instruction: null,
        ordinal: 0,
      }],
    }
    const fieldGuardRoutine: RoutineDefinition = {
      ...fieldGuardDraft,
      id: 'routine-field-guard',
      lineageId: 'lineage-field-guard',
      agentId: 'agent-1',
      status: 'draft',
      version: 1,
      createdAt: '2026-04-26T12:00:00.000Z',
      updatedAt: '2026-04-26T12:00:00.000Z',
    }

    expect(formToRoutineDraft(routineToForm(fieldGuardRoutine)).transitions).toEqual(fieldGuardDraft.transitions)
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
          fieldRef: null,
          fieldOp: null,
          fieldValue: null,
          fieldValues: null,
          fieldUnit: null,
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

// FR-030: every diagnostic the validator can emit must resolve to a target the UI anchors.
//
// The producer is backend `modules/routines/validator.ts` + `modules/routines/service.ts`;
// these are the location *forms* it can emit. Adding a form there means adding it here,
// and the coverage assertion below fails until an exemplar for it resolves — which is what
// keeps a new location form from shipping unanchored.
const LOCATION_FORMS = [
  'node:<nodeId>',
  'step:<nodeId>',
  'step:<nodeId>.inputBindings.<inputKey>',
  'step:<nodeId>.outputAssignments.<outputKey>',
  'transition:<fromStepId>-><toRef>',
  'slot:<slotKey>',
  'routine:<routineName>',
  'completionExport.destinationRef',
] as const

// `severity` and any other field the wire contract grows are irrelevant to anchoring, so a
// diagnostic is built from its location alone rather than spelled out field by field.
const diagnosticAt = (location: string): RoutineValidationDiagnostic =>
  ({ code: 'unreachable_step', location, message: location } as RoutineValidationDiagnostic)

// Node ids admit `.` and `-`, so dotted locations are resolved longest-match-first against
// the ids that actually exist — exactly what the backend parser does.
const knownNodeIds = new Set(['ask.email', 'send-quote', 'send-quote-', 'a->b', 'complete'])

export const PRODUCIBLE_DIAGNOSTIC_LOCATIONS: {
  form: (typeof LOCATION_FORMS)[number]
  location: string
  expected: DiagnosticTarget
}[] = [
  // node: — id collision, reported against a node id containing a dot.
  { form: 'node:<nodeId>', location: 'node:ask.email', expected: { scope: 'step', id: 'ask.email' } },
  // step: — plain, dotted, and hyphenated node ids.
  { form: 'step:<nodeId>', location: 'step:send-quote', expected: { scope: 'step', id: 'send-quote' } },
  { form: 'step:<nodeId>', location: 'step:ask.email', expected: { scope: 'step', id: 'ask.email' } },
  { form: 'step:<nodeId>', location: 'step:complete', expected: { scope: 'step', id: 'complete' } },
  // step: field paths — resolve to the step that declares the field.
  {
    form: 'step:<nodeId>.inputBindings.<inputKey>',
    location: 'step:ask.email.inputBindings.recipient',
    expected: { scope: 'step', id: 'ask.email' },
  },
  {
    form: 'step:<nodeId>.inputBindings.<inputKey>',
    location: 'step:send-quote.inputBindings.subject',
    expected: { scope: 'step', id: 'send-quote' },
  },
  {
    form: 'step:<nodeId>.outputAssignments.<outputKey>',
    location: 'step:ask.email.outputAssignments.message_id',
    expected: { scope: 'step', id: 'ask.email' },
  },
  // transition: — the edge identity is the whole `from->to` pair, including the adversarial
  // cases (`->` inside a step id, a step id ending in `-`) that break a naive split.
  {
    form: 'transition:<fromStepId>-><toRef>',
    location: 'transition:send-quote->complete',
    expected: { scope: 'transition', id: 'send-quote->complete' },
  },
  {
    form: 'transition:<fromStepId>-><toRef>',
    location: 'transition:a->b->complete',
    expected: { scope: 'transition', id: 'a->b->complete' },
  },
  {
    form: 'transition:<fromStepId>-><toRef>',
    location: 'transition:send-quote-->complete',
    expected: { scope: 'transition', id: 'send-quote-->complete' },
  },
  { form: 'slot:<slotKey>', location: 'slot:email', expected: { scope: 'slot', id: 'email' } },
  // routine: carries a NAME, which may contain spaces and punctuation.
  {
    form: 'routine:<routineName>',
    location: 'routine:Collect intake: v2',
    expected: { scope: 'routine', id: 'Collect intake: v2' },
  },
  {
    form: 'completionExport.destinationRef',
    location: 'completionExport.destinationRef',
    expected: { scope: 'completionExport', id: 'destinationRef' },
  },
]

// A form covering every artifact the editor renders, with authored values that slugify
// (a spaced slot key, a spaced step id) so anchors are proven in draft space, not raw.
const anchoredForm = (): RoutineFormState => ({
  name: 'Collect intake',
  activation: { triggerDescription: 'Visitor asks for a quote', priority: '0', reentryMode: 'always' },
  slots: [
    { stableSlotId: 'slot_email', key: 'email', type: 'email', required: true, description: '', mutable: false },
    { stableSlotId: 'slot_name', key: 'customer name', type: 'text', required: false, description: '', mutable: false },
  ],
  steps: [
    {
      stableStepId: 'ask email',
      kind: 'chat',
      instruction: 'Ask for the email.',
      toolRef: '',
      actionType: '',
      captureKey: '',
      options: [],
      metadata: {},
      transitions: [createTransitionForm('ask email', 'review')],
    },
    {
      stableStepId: 'review',
      kind: 'approval',
      instruction: 'Approve the quote.',
      toolRef: '',
      actionType: '',
      captureKey: 'decision',
      options: [
        { id: 'approve', label: 'Approve', description: '', target: 'complete' },
        { id: 'decline', label: 'Decline', description: '', target: 'handoff' },
        { id: 'defer', label: 'Defer', description: '', target: '' },
      ],
      metadata: {},
      transitions: [],
    },
  ],
  terminals: [
    { stableStepId: 'complete', kind: 'complete', instruction: '' },
    { stableStepId: 'handoff', kind: 'handoff', instruction: '' },
  ],
  completionExport: { enabled: true, triggerKinds: ['complete'], destinationRef: 'destination-1' },
})

describe('routine diagnostic mapping', () => {
  it('resolves every producible location form to a distinct, non-empty target', () => {
    for (const { location, expected } of PRODUCIBLE_DIAGNOSTIC_LOCATIONS) {
      const target = diagnosticTargetFor(diagnosticAt(location), knownNodeIds)
      expect(target, location).toEqual(expected)
      expect(target.id.length, location).toBeGreaterThan(0)
      // The unparsed fallback is `{ scope: 'routine', id: <the whole location> }`; a form
      // that lands there has been recognised by nothing.
      expect(target.scope === 'routine' && target.id === location, location).toBe(false)
    }
  })

  it('covers every location form the producer can emit', () => {
    expect(new Set(PRODUCIBLE_DIAGNOSTIC_LOCATIONS.map((entry) => entry.form))).toEqual(new Set(LOCATION_FORMS))
  })

  it('resolves dotted step field paths without the declared ids', () => {
    // The catch-all caller has no form to read ids from, so field paths are stripped
    // structurally. A dotted node id still survives when no field segment follows it.
    expect(diagnosticTargetFor(diagnosticAt('step:ask.email.inputBindings.recipient')))
      .toEqual({ scope: 'step', id: 'ask.email' })
    expect(diagnosticTargetFor(diagnosticAt('step:ask.email.outputAssignments.message_id')))
      .toEqual({ scope: 'step', id: 'ask.email' })
    expect(diagnosticTargetFor(diagnosticAt('step:ask.email'))).toEqual({ scope: 'step', id: 'ask.email' })
  })

  it('resolves an unrecognised location to the routine so it stays visible', () => {
    expect(diagnosticTargetFor(diagnosticAt('terminal:complete')))
      .toEqual({ scope: 'routine', id: 'terminal:complete' })
    expect(diagnosticTargetFor(diagnosticAt('transition:no-arrow')))
      .toEqual({ scope: 'routine', id: 'transition:no-arrow' })
  })

  it('filters diagnostics for an inline target', () => {
    const diagnostics = [
      diagnosticAt('slot:email'),
      diagnosticAt('step:ask_email.inputBindings.recipient'),
      diagnosticAt('transition:ask_email->complete'),
    ]
    expect(diagnosticsForTarget(diagnostics, { scope: 'slot', id: 'email' })).toEqual([diagnostics[0]])
    // A field diagnostic is filtered under the step that declares it.
    expect(diagnosticsForTarget(diagnostics, { scope: 'step', id: 'ask_email' }, new Set(['ask_email'])))
      .toEqual([diagnostics[1]])
    expect(diagnosticsForTarget(diagnostics, { scope: 'step', id: 'complete' })).toEqual([])
  })
})

describe('routine diagnostic anchoring', () => {
  it('anchors every artifact the saved draft declares', () => {
    const form = anchoredForm()
    const draft = formToRoutineDraft(form)
    const targets = renderedDiagnosticTargets(form)

    for (const slot of draft.slots) expect(targets).toContainEqual({ scope: 'slot', id: slot.key })
    for (const step of draft.steps) expect(targets).toContainEqual({ scope: 'step', id: step.stableStepId })
    for (const terminal of draft.terminals) expect(targets).toContainEqual({ scope: 'step', id: terminal.stableStepId })
    for (const transition of draft.transitions) {
      expect(targets).toContainEqual({ scope: 'transition', id: `${transition.fromStep}->${transition.toRef}` })
    }
    expect(targets).toContainEqual({ scope: 'completionExport', id: 'destinationRef' })
  })

  it('anchors a diagnostic against the slugified artifact, not the authored text', () => {
    const targets = renderedDiagnosticTargets(anchoredForm())
    expect(targets).toContainEqual({ scope: 'slot', id: 'customer_name' })
    expect(targets).toContainEqual({ scope: 'step', id: 'ask_email' })
    expect(targets).toContainEqual({ scope: 'transition', id: 'ask_email->review' })
  })

  it('keeps anchored diagnostics out of the routine-level list', () => {
    const form = anchoredForm()
    const targets = renderedDiagnosticTargets(form)
    const diagnostics = [
      diagnosticAt('slot:customer_name'),
      diagnosticAt('step:ask_email'),
      diagnosticAt('step:ask_email.inputBindings.recipient'),
      diagnosticAt('node:complete'),
      diagnosticAt('transition:ask_email->review'),
      diagnosticAt('transition:review->handoff'),
      diagnosticAt('completionExport.destinationRef'),
      diagnosticAt('routine:Collect intake'),
    ]

    expect(routineLevelDiagnostics(diagnostics, targets)).toEqual([diagnosticAt('routine:Collect intake')])
  })

  it('falls back to the routine level for a diagnostic no artifact renders', () => {
    const form = anchoredForm()
    const targets = renderedDiagnosticTargets(form)
    const diagnostics = [
      diagnosticAt('step:ghost_step'),
      diagnosticAt('transition:ask_email->ghost_step'),
      diagnosticAt('slot:ghost_slot'),
      diagnosticAt('terminal:complete'),
    ]

    expect(routineLevelDiagnostics(diagnostics, targets)).toEqual(diagnostics)
  })

  it('shows every diagnostic at routine level when the form editor is not rendered', () => {
    // Prose mode renders no per-artifact anchors at all.
    const diagnostics = PRODUCIBLE_DIAGNOSTIC_LOCATIONS.map((entry) => diagnosticAt(entry.location))
    expect(routineLevelDiagnostics(diagnostics, [])).toEqual(diagnostics)
  })

  it('leaves the completion-export anchor unrendered while the export is disabled', () => {
    const form = anchoredForm()
    form.completionExport.enabled = false
    const targets = renderedDiagnosticTargets(form)
    const diagnostic = diagnosticAt('completionExport.destinationRef')

    expect(targets).not.toContainEqual({ scope: 'completionExport', id: 'destinationRef' })
    expect(routineLevelDiagnostics([diagnostic], targets)).toEqual([diagnostic])
  })
})

describe('renderedDraftTargets', () => {
  it('claims every draft artifact the Document tab renders', () => {
    const targets = renderedDraftTargets({
      name: 'X',
      activation: { triggerDescription: 't', priority: 0 },
      slots: [{ stableSlotId: 'email', key: 'email', type: 'email', required: true, description: null, ordinal: 0 }],
      steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: 'x', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: 'step_1', toRef: 'end_1', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }],
      terminals: [{ stableStepId: 'end_1', kind: 'complete', instruction: null, ordinal: 0 }],
    })
    expect(targets).toEqual(expect.arrayContaining([
      { scope: 'slot', id: 'email' },
      { scope: 'step', id: 'step_1' },
      { scope: 'step', id: 'end_1' },
      { scope: 'transition', id: 'step_1->end_1' },
    ]))
  })
})
