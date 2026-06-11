import { describe, expect, it } from 'vitest'

import type { RoutineDefinitionDraft } from '@/lib/api'
import {
  diagnosticsForOutlineTarget,
  outlineToRoutineDraft,
  routineDraftToOutline,
  type RoutineOutlineActionOption,
  type RoutineOutlineState,
} from '@/lib/routine-outline'

const actionOptions: RoutineOutlineActionOption[] = [
  { ref: 'contact.send', label: 'Contact Send', kind: 'action' },
  { ref: 'order.lookup', label: 'Order Lookup', kind: 'tool', outcomeStatuses: ['found', 'not_found', 'error'] },
]

const outline: RoutineOutlineState = {
  name: 'Order support',
  activation: {
    triggerDescription: 'Visitor asks about an order.',
    priority: '15',
  },
  variables: [
    {
      stableSlotId: 'email',
      key: 'email',
      type: 'email',
      required: true,
      description: 'Visitor email',
    },
    {
      stableSlotId: 'order_id',
      key: 'order_id',
      type: 'text',
      required: true,
      description: 'Order number',
    },
  ],
  steps: [
    {
      stableStepId: 'collect_email',
      label: 'Collect email',
      instruction: 'Ask for @email.',
      branches: [
        {
          id: 'collect_email:0',
          condition: '',
          targetRef: 'lookup_order',
          outcomeStatus: '',
          counterLimit: '',
        },
      ],
    },
    {
      stableStepId: 'lookup_order',
      label: 'Lookup order',
      instruction: 'Run @Order Lookup for @email and @order_id.',
      branches: [
        {
          id: 'lookup_order:0',
          condition: '',
          targetRef: 'confirm',
          outcomeStatus: 'found',
          counterLimit: '',
        },
        {
          id: 'lookup_order:1',
          condition: 'The order lookup cannot find a matching order',
          targetRef: 'collect_email',
          outcomeStatus: '',
          counterLimit: '2',
        },
        {
          id: 'lookup_order:2',
          condition: '',
          targetRef: 'human_help',
          outcomeStatus: '',
          counterLimit: '',
        },
      ],
    },
    {
      stableStepId: 'confirm',
      label: 'Confirm',
      instruction: 'Tell them the order is ready.',
      branches: [
        {
          id: 'confirm:0',
          condition: '',
          targetRef: 'done',
          outcomeStatus: '',
          counterLimit: '',
        },
      ],
    },
  ],
  ends: [
    {
      stableStepId: 'done',
      label: 'done',
      message: 'Confirm the request is complete.',
      handoff: false,
    },
    {
      stableStepId: 'human_help',
      label: 'human_help',
      message: 'Hand the visitor to a person.',
      handoff: true,
    },
  ],
}

const legacyDraft = {
  name: 'Legacy routine',
  activation: {
    triggerDescription: 'Visitor asks for help.',
    priority: 5,
  },
  slots: [],
  steps: [
    {
      stableStepId: 'old_step',
      kind: 'fork',
      instruction: 'Ask what they need.',
      toolRef: null,
      ordinal: 0,
      metadata: { outlineLabel: 'Old step' },
    },
  ],
  transitions: [
    {
      fromStep: 'old_step',
      toRef: 'complete',
      guardKind: 'always',
      guardText: null,
      outcomeStatus: null,
      counterLimit: null,
      ordinal: 0,
    },
    {
      fromStep: 'old_step',
      toRef: 'complete',
      guardKind: 'fallback',
      guardText: null,
      outcomeStatus: null,
      counterLimit: null,
      ordinal: 1,
    },
  ],
  terminals: [
    {
      stableStepId: 'complete',
      kind: 'complete',
      instruction: null,
      ordinal: 0,
    },
  ],
} as unknown as RoutineDefinitionDraft

describe('routine outline adapter', () => {
  it('round-trips outline state through the routine draft without losing structured branch data', () => {
    const draft = outlineToRoutineDraft(outline, { actionOptions })

    expect(draft.steps[1]).toMatchObject({
      stableStepId: 'lookup_order',
      kind: 'tool',
      toolRef: 'order.lookup',
      metadata: { outlineLabel: 'Lookup order' },
    })
    expect(draft.transitions.map((transition) => transition.guardKind)).toEqual([
      'default',
      'outcome',
      'counter',
      'default',
      'default',
    ])
    expect(draft.terminals[1]).toMatchObject({ stableStepId: 'human_help', kind: 'handoff' })

    expect(routineDraftToOutline(draft, { actionOptions })).toEqual(outline)
  })

  it('keeps llm prose branch conditions as author prose and maps variables to slot tokens', () => {
    const llmOutline: RoutineOutlineState = {
      ...outline,
      steps: [{
        stableStepId: 'qualify',
        label: 'Qualify',
        instruction: 'Ask whether the request is urgent for @email.',
        branches: [{
          id: 'qualify:0',
          condition: 'The visitor says this is urgent',
          targetRef: 'human_help',
          outcomeStatus: '',
          counterLimit: '',
        }],
      }],
    }

    const draft = outlineToRoutineDraft(llmOutline, { actionOptions })

    expect(draft.steps[0]?.kind).toBe('chat')
    expect(draft.steps[0]?.instruction).toBe('Ask whether the request is urgent for {{slot.email}}.')
    expect(draft.transitions[0]).toMatchObject({
      guardKind: 'llm',
      guardText: 'The visitor says this is urgent',
      toRef: 'human_help',
    })
    expect(routineDraftToOutline(draft, { actionOptions })).toEqual(llmOutline)
  })

  it('does not compile outcome guards from branches leaving chat steps', () => {
    const chatOutcomeOutline: RoutineOutlineState = {
      ...outline,
      steps: [{
        stableStepId: 'qualify',
        label: 'Qualify',
        instruction: 'Ask for @email.',
        branches: [{
          id: 'qualify:0',
          condition: '',
          targetRef: 'human_help',
          outcomeStatus: 'found',
          counterLimit: '',
        }],
      }],
    }

    expect(outlineToRoutineDraft(chatOutcomeOutline, { actionOptions }).transitions[0]).toMatchObject({
      guardKind: 'default',
      outcomeStatus: null,
    })
  })

  it('uses the shared draft header when saving an outline projection and preserves it across projection toggles', () => {
    const staleHeaderOutline: RoutineOutlineState = {
      ...outline,
      name: '',
      activation: {
        triggerDescription: '',
        priority: '0',
      },
    }

    const draft = outlineToRoutineDraft(staleHeaderOutline, {
      actionOptions,
      header: {
        name: 'Order support',
        activation: {
          triggerDescription: 'Visitor asks about an order.',
          priority: '15',
        },
      },
    })

    expect(draft).toMatchObject({
      name: 'Order support',
      activation: {
        triggerDescription: 'Visitor asks about an order.',
        priority: 15,
      },
    })
    expect(routineDraftToOutline(draft, { actionOptions })).toMatchObject({
      name: 'Order support',
      activation: {
        triggerDescription: 'Visitor asks about an order.',
        priority: '15',
      },
    })
  })

  it('normalizes legacy fork and always/fallback payloads when projecting to outline', () => {
    const projected = routineDraftToOutline(legacyDraft, { actionOptions })

    expect(projected.steps[0]).toMatchObject({
      stableStepId: 'old_step',
      label: 'Old step',
      instruction: 'Ask what they need.',
      branches: [
        expect.objectContaining({ condition: '', targetRef: 'complete' }),
        expect.objectContaining({ condition: '', targetRef: 'complete' }),
      ],
    })
    expect(outlineToRoutineDraft(projected, { actionOptions }).transitions.map((transition) => transition.guardKind))
      .toEqual(['default', 'default'])
  })

  it('maps validator diagnostics to stable outline cards and branch rows', () => {
    const diagnostics = [
      { code: 'declared_unused_slot' as const, location: 'slot:email', message: 'Unused slot' },
      { code: 'dangling_step_reference' as const, location: 'transition:lookup_order->human_help', message: 'Bad target' },
      { code: 'missing_terminal' as const, location: 'routine:Order support', message: 'Missing terminal' },
    ]

    expect(diagnosticsForOutlineTarget(diagnostics, { scope: 'variable', id: 'email' })).toEqual([diagnostics[0]])
    expect(diagnosticsForOutlineTarget(diagnostics, { scope: 'branch', id: 'lookup_order->human_help' })).toEqual([diagnostics[1]])
    expect(diagnosticsForOutlineTarget(diagnostics, { scope: 'routine', id: 'Order support' })).toEqual([diagnostics[2]])
  })
})
