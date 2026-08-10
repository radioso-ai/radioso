import { describe, expect, it } from 'vitest'

import {
  addBranch,
  addEnding,
  addSlot,
  addStep,
  changeBranchGuardKind,
  moveStep,
  referenceEnding,
  removeBranch,
  removeStep,
  renameSlot,
  replaceInstruction,
  slotReferences,
  targetBranchAtStep,
  updateBindings,
  updateBranchGuard,
} from '@/lib/routine-document-edits'
import { draftFromBlockDoc, routineToBlockDoc, type RoutineBlockDoc } from '@/lib/routine-prose'

const source = () => {
  const result = routineToBlockDoc({
    name: 'Account recovery',
    activation: { triggerDescription: 'A customer cannot access their account', priority: 0 },
    slots: [{ stableSlotId: 'email', key: 'email', type: 'email', required: true, description: 'Customer email', ordinal: 0 }],
    steps: [{ stableStepId: 'ask_email', kind: 'chat', instruction: 'Ask for {{slot.email}}.', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
    transitions: [],
    terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: 'All set.', ordinal: 0 }],
  })
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join(', '))
  return result.doc
}

describe('routine document edits', () => {
  it('adds, removes, and reorders steps without mutating the source', () => {
    const original = source()
    const withSteps = addStep(addStep(original, 'chat'), 'approval')
    expect(withSteps.steps.map((step) => step.kind)).toEqual(['chat', 'chat', 'approval'])
    const moved = moveStep(withSteps, withSteps.steps[2]!.stableStepId, -1)
    expect(moved.steps.map((step) => step.kind)).toEqual(['chat', 'approval', 'chat'])
    expect(removeStep(moved, moved.steps[1]!.stableStepId).steps).toHaveLength(2)
    expect(original.steps).toHaveLength(1)
  })

  it('adds, edits, targets, and removes branches as typed document data', () => {
    const branched = addBranch(source(), 'ask_email', 'field')
    const edited = updateBranchGuard(branched, 'ask_email', 0, { fieldRef: 'email', fieldOp: 'is_present' })
    const withTarget = targetBranchAtStep(addStep(edited, 'chat'), 'ask_email', 0, 'step_1')
    expect(withTarget.steps[0]!.branches[0]).toMatchObject({
      guard: { kind: 'field', fieldRef: 'email', fieldOp: 'is_present' },
      target: { kind: 'step', stableStepId: 'step_1' },
    })
    expect(removeBranch(withTarget, 'ask_email', 0).steps[0]!.branches).toEqual([])
    expect(changeBranchGuardKind(branched, 'ask_email', 0, 'llm').steps[0]!.branches[0]!.guard.kind).toBe('llm')
  })

  it('creates and references endings while preserving a single definition', () => {
    const withEnding = addEnding(source(), 'handoff')
    const handoff = withEnding.unreferencedEndings.find((ending) => ending.kind === 'handoff')!
    const branched = addBranch(withEnding, 'ask_email')
    const referenced = referenceEnding(branched, 'ask_email', 0, handoff.stableStepId)
    expect(referenced.steps[0]!.branches[0]!.target).toEqual({ kind: 'ending', terminalId: handoff.stableStepId })
    const projected = draftFromBlockDoc(referenced)
    expect(projected.terminals.filter((ending) => ending.stableStepId === handoff.stableStepId)).toHaveLength(1)
  })

  it('renames slots through instructions, bindings, and guards', () => {
    const withBranch = updateBranchGuard(addBranch(source(), 'ask_email', 'slot_filled'), 'ask_email', 0, { slotKeys: ['email'] })
    const withBindings = updateBindings(withBranch, 'ask_email', {
      inputBindings: { recipient: { kind: 'variableRef', ref: 'email' } },
      outputAssignments: { normalized_email: 'email' },
    })
    const renamed = renameSlot(withBindings, 'email', 'Customer email')
    expect(renamed.information[0]!.key).toBe('customer_email')
    expect(renamed.steps[0]!.instruction).toContainEqual({ kind: 'slotReference', key: 'customer_email', source: '{{slot.customer_email}}' })
    expect(renamed.steps[0]!.inputBindings?.recipient).toEqual({ kind: 'variableRef', ref: 'customer_email' })
    expect(renamed.steps[0]!.branches[0]!.guard).toMatchObject({ slotKeys: ['customer_email'] })
    expect(slotReferences(renamed, 'customer_email')).toEqual(expect.arrayContaining(['instruction in ask_email', 'binding in ask_email', 'output in ask_email', 'guard in ask_email']))
  })

  it('keeps typed binding edits through the block-document round trip', () => {
    const tool = addStep(source(), 'tool')
    const edited = updateBindings(tool, 'step_1', {
      inputBindings: {
        email: { kind: 'variableRef', ref: 'email' },
        locale: { kind: 'contextVariableRef', contextVariable: 'page_locale' },
        retry: { kind: 'literal', value: true },
      },
      outputAssignments: { account_id: 'account_id' },
      mode: 'typed',
    })
    expect(edited.steps[1]!.inputBindings?.locale).toEqual({ kind: 'contextVariableRef', contextVariable: 'page_locale' })
    expect(edited.steps[1]!.outputAssignments).toEqual({ account_id: 'account_id' })
  })

  it('projects an edited document back to a clean block document', () => {
    let doc: RoutineBlockDoc = replaceInstruction(addStep(source(), 'chat'), 'step_1', [{ kind: 'text', text: 'Confirm the account.' }])
    doc = targetBranchAtStep(addBranch(doc, 'ask_email', 'default'), 'ask_email', 0, 'step_1')
    doc = addSlot(doc)
    const draft = draftFromBlockDoc(doc)
    const projected = routineToBlockDoc(draft)
    expect(projected.ok).toBe(true)
    if (projected.ok) expect(projected.doc.steps).toHaveLength(2)
  })
})
