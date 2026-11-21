import { describe, expect, it } from 'vitest'

import type { SkillAuthoringOutput } from '@/lib/api-routine-skill-catalog'
import { addBranch, replaceInstruction, updateBranchGuard } from '@/lib/routine-document-edits'
import { addOutputAssignment, changeAssignedOutput, changeAssignedVariable, removeOutputAssignment } from '@/lib/routine-output-assignments'
import { draftFromBlockDoc, routineToBlockDoc, type RoutineBlockDoc } from '@/lib/routine-prose'

const outputs: SkillAuthoringOutput[] = [
  { name: 'city', type: 'text', required: false },
  { name: 'email', type: 'email', required: false },
  { name: 'last_name', type: 'text', required: false },
  { name: 'first_name', type: 'text', required: true },
  { name: 'orders', type: 'list', required: false, fields: [{ name: 'title', type: 'text', role: 'title' }] },
]

// A customer lookup: ask for the number, then look the customer up.
const lookupRoutine = (): RoutineBlockDoc => {
  const result = routineToBlockDoc({
    name: 'Customer lookup',
    activation: { triggerDescription: 'The visitor asks about a customer', priority: 0 },
    slots: [{ stableSlotId: 'customer_id', key: 'customer_id', type: 'number', required: true, description: null, ordinal: 0 }],
    steps: [
      { stableStepId: 'ask', kind: 'chat', instruction: 'Ask for {{slot.customer_id}}.', toolRef: null, actionType: null, ordinal: 0, metadata: {} },
      { stableStepId: 'lookup', kind: 'tool', instruction: 'Look up the customer.', toolRef: 'lookup_customer', actionType: null, ordinal: 1, metadata: { inputBindings: { customer_id: { kind: 'variableRef', ref: 'customer_id' } } } },
    ],
    transitions: [
      { fromStep: 'ask', toRef: 'lookup', guardKind: 'default', guardText: null, ordinal: 0 },
      { fromStep: 'lookup', toRef: 'done', guardKind: 'default', guardText: null, ordinal: 1 },
    ],
    terminals: [{ stableStepId: 'done', kind: 'complete', instruction: 'Tell the visitor what the lookup returned.', ordinal: 0 }],
  })
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join(', '))
  return result.doc
}

const assignmentsOf = (doc: RoutineBlockDoc) => doc.steps.find((step) => step.stableStepId === 'lookup')?.outputAssignments ?? {}

describe('skill step Sets rows', () => {
  it('declares the variables a step sets without adding a field to collect', () => {
    let doc = lookupRoutine()
    doc = addOutputAssignment(doc, 'lookup', outputs)
    doc = addOutputAssignment(doc, 'lookup', outputs)
    doc = addOutputAssignment(doc, 'lookup', outputs)
    doc = changeAssignedVariable(doc, 'lookup', 2, 'Surname')
    // A rule on a variable the step sets, as the routine branches on it.
    doc = addBranch(doc, 'lookup', 'field')
    doc = updateBranchGuard(doc, 'lookup', 1, { fieldRef: 'city', fieldOp: 'is_absent' })

    const draft = draftFromBlockDoc(doc)

    expect(draft.slots.map((slot) => slot.key)).toEqual(['customer_id'])
    expect(draft.steps.find((step) => step.stableStepId === 'lookup')?.metadata.outputAssignments).toEqual({
      city: 'city',
      email: 'email',
      last_name: 'surname',
    })
    expect(draft.transitions.find((transition) => transition.guardKind === 'field')?.fieldRef).toBe('city')
  })

  it('names a new row after its output, and numbers the variable when that name is taken', () => {
    const withSlot: RoutineBlockDoc = { ...lookupRoutine(), information: [...lookupRoutine().information, { stableSlotId: 'city', key: 'city', type: 'text', required: true, description: null, mutable: false }] }

    expect(assignmentsOf(addOutputAssignment(withSlot, 'lookup', outputs))).toEqual({ city: 'city_2' })
    // Without declared outputs the row names a numbered output for the author to rename.
    expect(assignmentsOf(addOutputAssignment(lookupRoutine(), 'lookup', []))).toEqual({ output_1: 'output_1' })
  })

  it('changes a row in place, and its variable follows the output while it still has the default name', () => {
    let doc = lookupRoutine()
    for (let count = 0; count < 3; count += 1) doc = addOutputAssignment(doc, 'lookup', outputs)

    const changed = changeAssignedOutput(doc, 'lookup', 1, 'first_name')

    expect(Object.entries(assignmentsOf(changed))).toEqual([
      ['city', 'city'],
      ['first_name', 'first_name'],
      ['last_name', 'last_name'],
    ])
    expect(draftFromBlockDoc(changed).slots.map((slot) => slot.key)).toEqual(['customer_id'])
  })

  it('keeps a variable that something else reads, or that the author renamed', () => {
    let doc = lookupRoutine()
    for (let count = 0; count < 2; count += 1) doc = addOutputAssignment(doc, 'lookup', outputs)
    doc = addBranch(doc, 'lookup', 'field')
    doc = updateBranchGuard(doc, 'lookup', 1, { fieldRef: 'email', fieldOp: 'is_present' })
    const renamed = changeAssignedVariable(doc, 'lookup', 0, 'home_town')

    expect(Object.entries(assignmentsOf(changeAssignedOutput(doc, 'lookup', 1, 'first_name')))).toEqual([
      ['city', 'city'],
      ['first_name', 'email'],
    ])
    expect(Object.entries(assignmentsOf(changeAssignedOutput(renamed, 'lookup', 0, 'last_name')))).toEqual([
      ['last_name', 'home_town'],
      ['email', 'email'],
    ])
  })

  it('refuses an output another row already reads, and removes one row only', () => {
    let doc = lookupRoutine()
    for (let count = 0; count < 3; count += 1) doc = addOutputAssignment(doc, 'lookup', outputs)

    expect(assignmentsOf(changeAssignedOutput(doc, 'lookup', 0, 'email'))).toEqual(assignmentsOf(doc))
    expect(Object.keys(assignmentsOf(removeOutputAssignment(doc, 'lookup', 1)))).toEqual(['city', 'last_name'])
  })

  it('leaves the step instruction and the routine fields alone', () => {
    const doc = replaceInstruction(lookupRoutine(), 'lookup', [{ kind: 'text', text: 'Find them.' }])
    const edited = addOutputAssignment(doc, 'lookup', outputs)

    expect(edited.information).toEqual(doc.information)
    expect(edited.steps.find((step) => step.stableStepId === 'lookup')?.instruction).toEqual([{ kind: 'text', text: 'Find them.' }])
  })
})
