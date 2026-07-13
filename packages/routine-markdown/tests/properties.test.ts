import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  canonicalize,
  docToDraftInput,
  draftToDoc,
  parse,
  serializeProseDoc,
  type ChipDocVariable,
  type ProseParagraph,
  type RoutineDraftSource,
} from '../src/index.js'

const seed = 100_713

const firstKeyChars = [...'abcdefghijklmnopqrstuvwxyz']
const keyChars = [...'abcdefghijklmnopqrstuvwxyz0123456789_']

const keyArb = fc
  .tuple(
    fc.constantFrom(...firstKeyChars),
    fc.array(fc.constantFrom(...keyChars), { minLength: 0, maxLength: 8 }),
  )
  .map(([first, rest]) => `${first}${rest.join('')}`)
  .filter((value) => !['ctx', 'in', 'out', 'mode', 'done', 'handoff'].includes(value))

const textArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '.split('')), { minLength: 1, maxLength: 30 })
  .map((chars) => chars.join('').replace(/\s+/g, ' ').trim())
  .filter((value) => value.length > 0)

const variableArb = keyArb.map((id): ChipDocVariable => ({
  id,
  name: id,
  type: 'text',
}))

const documentArb = fc.record({
  name: textArb,
  trigger: textArb,
  variables: fc.uniqueArray(variableArb, { minLength: 1, maxLength: 4, selector: (variable) => variable.id }),
  paragraphTexts: fc.array(textArb, { minLength: 1, maxLength: 5 }),
}).map(({ name, trigger, variables, paragraphTexts }) => {
  const paragraphs: ProseParagraph[] = paragraphTexts.map((text, index) => {
    const variable = variables[index % variables.length]!
    return {
      segments: [
        { kind: 'text', text: `${text} ` },
        { kind: 'chip', chipKind: 'variable', refId: variable.id, label: `@${variable.id}` },
        { kind: 'text', text: '.' },
      ],
    }
  })
  return { name, trigger, variables, paragraphs }
})

const draftArb = fc.record({
  name: textArb,
  trigger: textArb,
  slotKey: keyArb,
  stepId: keyArb,
  instruction: textArb,
}).map(({ name, trigger, slotKey, stepId, instruction }): RoutineDraftSource => ({
  name,
  activation: {
    triggerDescription: trigger,
    gateRef: null,
    priority: 0,
    reentryMode: 'once_per_conversation',
  },
  slots: [{
    stableSlotId: slotKey,
    key: slotKey,
    type: 'text',
    required: true,
    description: slotKey,
    ordinal: 0,
  }],
  steps: [{
    stableStepId: stepId,
    kind: 'chat',
    instruction: `${instruction} {{slot.${slotKey}}}.`,
    toolRef: null,
    actionType: null,
    ordinal: 0,
    metadata: { outlineLabel: stepId },
  }],
  transitions: [{
    fromStep: stepId,
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
}))

const structuralShape = (paragraphs: ProseParagraph[]) =>
  paragraphs.map((paragraph) => ({
    headingLevel: paragraph.headingLevel ?? null,
    segments: paragraph.segments.map((segment) => segment.kind === 'text'
      ? { kind: 'text', text: segment.text }
      : {
          kind: 'chip',
          chipKind: segment.chipKind,
          refId: segment.refId,
          op: segment.op ?? null,
          value: segment.value ?? null,
          values: segment.values ?? null,
          unit: segment.unit ?? null,
          counterLimit: segment.counterLimit ?? null,
          inputBindings: segment.inputBindings ?? {},
          outputAssignments: segment.outputAssignments ?? {},
          mode: segment.mode ?? null,
        }),
  }))

describe('routine markdown properties', () => {
  it('round-trips arbitrary valid drafts through serialize and parse', () => {
    fc.assert(
      fc.property(draftArb, (draft) => {
        const doc = draftToDoc(draft)
        expect(doc).not.toBeNull()
        if (!doc) return

        const serialized = serializeProseDoc({
          name: draft.name,
          trigger: draft.activation.triggerDescription,
          reentryMode: draft.activation.reentryMode,
          priority: draft.activation.priority,
          variables: doc.variables,
          paragraphs: doc.paragraphs,
        })
        const parsed = parse(serialized)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) return

        const roundTripped = docToDraftInput({
          name: parsed.doc.name ?? '',
          trigger: parsed.doc.trigger ?? '',
          reentryMode: parsed.doc.reentryMode,
          priority: parsed.doc.priority,
          variables: parsed.doc.variables,
          blocks: parsed.doc.paragraphs.map((paragraph) => ({
            text: paragraph.segments.map((segment) =>
              segment.kind === 'text'
                ? segment.text
                : segment.chipKind === 'variable'
                  ? `{{slot.${segment.refId}}}`
                  : '').join(''),
            chips: paragraph.segments
              .filter((segment): segment is Extract<ProseParagraph['segments'][number], { kind: 'chip' }> => segment.kind === 'chip')
              .map((segment) => ({
                kind: segment.chipKind,
                refId: segment.refId,
                label: segment.label,
                ...(segment.op ? { op: segment.op } : {}),
                ...(segment.value !== undefined ? { value: segment.value } : {}),
                ...(segment.values !== undefined ? { values: segment.values } : {}),
                ...(segment.unit !== undefined ? { unit: segment.unit } : {}),
                ...(segment.counterLimit !== undefined ? { counterLimit: segment.counterLimit } : {}),
                ...(segment.inputBindings ? { inputBindings: segment.inputBindings } : {}),
                ...(segment.outputAssignments ? { outputAssignments: segment.outputAssignments } : {}),
                ...(segment.mode ? { mode: segment.mode } : {}),
              })),
            ...(paragraph.headingLevel ? { headingLevel: paragraph.headingLevel } : {}),
          })),
        })

        expect(roundTripped.name).toBe(draft.name)
        expect(roundTripped.activation.triggerDescription).toBe(draft.activation.triggerDescription)
        expect(roundTripped.slots.map((slot) => slot.key)).toEqual(draft.slots?.map((slot) => slot.key))
        expect(roundTripped.steps.map((step) => step.stableStepId)).toEqual(draft.steps?.map((step) => step.stableStepId))
      }),
      { seed, numRuns: 75 },
    )
  })

  it('round-trips arbitrary valid authored documents through serialize and parse', () => {
    fc.assert(
      fc.property(documentArb, (document) => {
        const serialized = serializeProseDoc(document)
        const parsed = parse(serialized)

        expect(parsed.ok).toBe(true)
        if (!parsed.ok) return
        expect(parsed.doc.name).toBe(document.name)
        expect(parsed.doc.trigger).toBe(document.trigger)
        expect(structuralShape(parsed.doc.paragraphs)).toEqual(structuralShape(document.paragraphs))
      }),
      { seed, numRuns: 75 },
    )
  })

  it('canonicalize is idempotent over arbitrary parseable text', () => {
    fc.assert(
      fc.property(documentArb, (document) => {
        const content = serializeProseDoc(document).replace(`grammar: 1\n`, '')
        const first = canonicalize(content)
        expect(first.ok).toBe(true)
        if (!first.ok) return

        const second = canonicalize(first.content)
        expect(second).toEqual(first)
      }),
      { seed, numRuns: 75 },
    )
  })

  it('canonical output always re-parses', () => {
    fc.assert(
      fc.property(documentArb, (document) => {
        const canonical = canonicalize(serializeProseDoc(document))
        expect(canonical.ok).toBe(true)
        if (!canonical.ok) return

        expect(parse(canonical.content).ok).toBe(true)
      }),
      { seed, numRuns: 75 },
    )
  })
})
