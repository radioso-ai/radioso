import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  draftToDoc,
  serializeProseDoc,
  type RoutineDraftSource,
} from '../src/index.js'

const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, 'fixtures/canonical', name), 'utf8')

const render = (draft: RoutineDraftSource): string => {
  const doc = draftToDoc(draft)
  if (!doc) throw new Error(`Draft ${draft.name} is not portable`)
  return serializeProseDoc({
    name: draft.name,
    trigger: draft.activation.triggerDescription,
    reentryMode: draft.activation.reentryMode,
    priority: draft.activation.priority,
    completionExport: draft.completionExport,
    variables: doc.variables,
    paragraphs: doc.paragraphs,
  })
}

describe('canonical golden documents', () => {
  it('serializes a simple titled routine byte-for-byte', () => {
    const draft: RoutineDraftSource = {
      name: 'Support intake',
      activation: {
        triggerDescription: 'When the user needs support',
        gateRef: null,
        priority: 3,
        reentryMode: 'once_per_conversation',
      },
      slots: [{
        stableSlotId: 'topic',
        key: 'topic',
        type: 'text',
        required: true,
        description: 'topic',
        ordinal: 0,
      }],
      steps: [{
        stableStepId: 'collect_topic',
        kind: 'chat',
        instruction: 'Ask for {{slot.topic}}.',
        toolRef: null,
        actionType: null,
        ordinal: 0,
        metadata: { outlineLabel: 'collect_topic' },
      }],
      transitions: [{
        fromStep: 'collect_topic',
        toRef: 'done',
        guardKind: 'default',
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      }],
      terminals: [{
        stableStepId: 'done',
        kind: 'complete',
        instruction: null,
        ordinal: 0,
      }],
    }

    expect(render(draft)).toBe(fixture('simple.routine.md'))
  })

  it('serializes export, tool bindings, field guards, and handoff byte-for-byte', () => {
    const draft: RoutineDraftSource = {
      name: 'Refund check',
      activation: {
        triggerDescription: 'customer asks for a refund',
        gateRef: null,
        priority: 0,
        reentryMode: 'always',
      },
      completionExport: {
        enabled: true,
        triggerKinds: ['complete', 'handoff'],
        destinationRef: '55555555-5555-4555-8555-555555555555',
      },
      slots: [{
        stableSlotId: 'amount',
        key: 'amount',
        type: 'number',
        required: true,
        description: 'amount',
        ordinal: 0,
      }, {
        stableSlotId: 'refund_status',
        key: 'refund_status',
        type: 'text',
        required: true,
        description: 'refund_status',
        ordinal: 1,
      }],
      steps: [{
        stableStepId: 'check_eligibility',
        kind: 'tool',
        instruction: 'Call the refund tool ',
        toolRef: 'refund.check',
        actionType: null,
        ordinal: 0,
        metadata: {
          outlineLabel: 'Check eligibility',
          inputBindings: {
            amount: { kind: 'variableRef', ref: 'amount' },
            locale: { kind: 'contextVariableRef', contextVariable: 'page_locale' },
          },
          outputAssignments: { status: 'refund_status' },
          mode: 'typed',
        },
      }],
      transitions: [{
        fromStep: 'check_eligibility',
        toRef: 'done',
        guardKind: 'default',
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      }, {
        fromStep: 'check_eligibility',
        toRef: 'done',
        guardKind: 'field',
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        fieldRef: 'refund_status',
        fieldOp: 'equals',
        fieldValue: 'approved',
        fieldValues: null,
        fieldUnit: null,
        ordinal: 1,
      }, {
        fromStep: 'check_eligibility',
        toRef: 'handoff',
        guardKind: 'outcome',
        guardText: null,
        outcomeStatus: 'failed',
        counterLimit: null,
        ordinal: 2,
      }],
      terminals: [{
        stableStepId: 'done',
        kind: 'complete',
        instruction: null,
        ordinal: 0,
      }, {
        stableStepId: 'handoff',
        kind: 'handoff',
        instruction: 'Bringing in a teammate.',
        ordinal: 1,
      }],
    }

    expect(render(draft)).toBe(fixture('export-tool.routine.md'))
  })
})
