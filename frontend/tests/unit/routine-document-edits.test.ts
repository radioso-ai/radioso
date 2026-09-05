import { describe, expect, it } from 'vitest'

import {
  addBranch,
  addEnding,
  addSlot,
  addStep,
  changeBranchGuardKind,
  changeStepKind,
  createEndingForBranch,
  moveStep,
  nextApprovalOptionId,
  referenceEnding,
  removeBranch,
  removeEnding,
  removeStep,
  renameEnding,
  renameSlot,
  renameStep,
  replaceInstruction,
  slotReferences,
  targetBranchAtStep,
  updateApproval,
  updateBindings,
  updateBranch,
  updateBranchGuard,
  updateEnding,
  updateSlot,
  updateStep,
} from '@/lib/routine-document-edits'
import { routineToForm } from '@/lib/routine-form'
import { draftFromBlockDoc, routineToBlockDoc, type RoutineBlockDoc } from '@/lib/routine-prose'
import type { RoutineDefinition, RoutineDefinitionDraft } from '@/lib/api'

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

const pristineSeed = () => {
  const result = routineToBlockDoc({
    name: '',
    activation: { triggerDescription: '', priority: 0 },
    slots: [],
    steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: '', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
    transitions: [],
    terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: '', ordinal: 0 }],
  })
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join(', '))
  return result.doc
}

describe('routine document edits', () => {
  describe('renaming the names the compiler uses', () => {
    it('renames a step and moves every branch that pointed at it', () => {
      const withBranch = targetBranchAtStep(addBranch(source(), 'ask_email', 'llm'), 'ask_email', 0, 'ask_email')

      const edited = renameStep(withBranch, 0, 'collect_email')

      expect(edited.steps[0]?.stableStepId).toBe('collect_email')
      expect(edited.steps[0]?.branches[0]?.target).toEqual({ kind: 'step', stableStepId: 'collect_email' })
    })

    it('refuses a rename that would make two steps answer to one name', () => {
      const twoSteps = addStep(source(), 'chat')
      // Two rows answering to one name make every branch to it ambiguous, so the rename is
      // refused rather than allowed and then unpicked.
      expect(renameStep(twoSteps, 1, 'ask_email')).toEqual(twoSteps)
    })

    it('refuses a step name already taken by an ending', () => {
      const doc = source()
      const endingId = doc.unreferencedEndings[0]?.stableStepId ?? 'complete'

      expect(renameStep(doc, 0, endingId)).toEqual(doc)
    })

    it('renames an ending and follows it from every branch that targets it', () => {
      const branched = createEndingForBranch(addBranch(source(), 'ask_email', 'llm'), 'ask_email', 0, 'complete')
      const target = branched.steps[0]?.branches[0]?.target
      if (target?.kind !== 'ending') throw new Error('expected an ending target')

      const edited = renameEnding(branched, target.terminalId, 'wrapped_up')

      const renamed = edited.steps[0]?.branches[0]?.target
      expect(renamed).toMatchObject({ kind: 'ending', terminalId: 'wrapped_up' })
    })

    it('removes an ending nothing points at', () => {
      const doc = addEnding(source(), 'handoff')
      const added = doc.unreferencedEndings.at(-1)!.stableStepId

      const edited = removeEnding(doc, added)

      expect(edited.unreferencedEndings.map((ending) => ending.stableStepId)).not.toContain(added)
    })

    it('keeps an ending a branch still needs', () => {
      const branched = createEndingForBranch(addBranch(source(), 'ask_email', 'llm'), 'ask_email', 0, 'complete')
      const target = branched.steps[0]?.branches[0]?.target
      if (target?.kind !== 'ending') throw new Error('expected an ending target')

      // Removing it would leave the branch pointing nowhere, which is the state the reader
      // has to warn about — so the edit declines instead of creating one.
      expect(removeEnding(branched, target.terminalId)).toEqual(branched)
    })
  })

  describe('changing a step kind', () => {
    it('turns a chat step into a tool step awaiting a skill', () => {
      const edited = changeStepKind(source(), 'ask_email', 'tool')
      const step = edited.steps.find((candidate) => candidate.stableStepId === 'ask_email')

      expect(step).toMatchObject({ kind: 'tool', toolRef: '' })
      // The instruction is the author's writing, not a property of the kind, so it survives.
      expect(step?.instruction).toEqual(source().steps[0]?.instruction)
    })

    it('turns a chat step into an action step awaiting an action type', () => {
      const step = changeStepKind(source(), 'ask_email', 'action').steps[0]

      expect(step).toMatchObject({ kind: 'action', actionType: '' })
      expect(step?.toolRef ?? null).toBeNull()
    })

    it('drops the previous kind\'s catalog reference when switching between them', () => {
      const asTool = changeStepKind(source(), 'ask_email', 'tool')
      const withRef = updateStep(asTool, 'ask_email', { toolRef: 'lookup_account' })

      const asAction = changeStepKind(withRef, 'ask_email', 'action')

      // A tool reference means nothing to an action step; leaving it would save a field the
      // kind cannot use and the validator rejects.
      expect(asAction.steps[0]?.toolRef ?? null).toBeNull()
      expect(asAction.steps[0]).toMatchObject({ kind: 'action', actionType: '' })
    })

    it('seeds a usable decision when a step becomes an approval', () => {
      const edited = changeStepKind(source(), 'ask_email', 'approval')
      const step = edited.steps[0]

      expect(step?.kind).toBe('approval')
      expect(step?.captureKey).toBe('decision')
      expect(step?.options?.map((option) => option.label)).toEqual(['Approve', 'Decline'])
      // Each option is a decision edge, so the branches the backend requires exist already.
      expect(step?.branches).toHaveLength(2)
    })

    it('removes the synthesized decision edges when a step stops being an approval', () => {
      const approval = changeStepKind(source(), 'ask_email', 'approval')
      expect(approval.steps[0]?.branches).toHaveLength(2)

      const backToChat = changeStepKind(approval, 'ask_email', 'chat')

      // Those branches guard on `<captureKey>.id`, which no longer exists once the step is
      // not an approval; keeping them would fail validation with an unknown reference.
      expect(backToChat.steps[0]?.branches).toHaveLength(0)
      expect(backToChat.steps[0]?.captureKey ?? null).toBeNull()
      expect(backToChat.steps[0]?.options ?? null).toBeNull()
    })

    it('keeps a branch the author wrote when the kind changes', () => {
      const branched = addBranch(source(), 'ask_email', 'llm')
      expect(branched.steps[0]?.branches).toHaveLength(1)

      const edited = changeStepKind(branched, 'ask_email', 'tool')

      expect(edited.steps[0]?.branches).toHaveLength(1)
    })

    it('leaves the document alone for an unknown step', () => {
      const doc = source()
      expect(changeStepKind(doc, 'missing_step', 'tool')).toEqual(doc)
    })

    it('still compiles to a saveable draft after a kind change', () => {
      const edited = changeStepKind(source(), 'ask_email', 'approval')

      const draft = draftFromBlockDoc(edited)

      expect(draft.steps[0]).toMatchObject({ kind: 'approval', captureKey: 'decision' })
    })
  })

  it('replaces a pristine seed step when adding a step', () => {
    const edited = addStep(pristineSeed(), 'approval')

    expect(edited.steps).toHaveLength(1)
    expect(edited.steps[0].kind).toBe('approval')
  })

  it('appends when the single seed step has instruction text', () => {
    const edited = replaceInstruction(pristineSeed(), 'step_1', [{ kind: 'text', text: 'Ask for the account email.' }])
    const withStep = addStep(edited, 'approval')

    expect(withStep.steps).toHaveLength(2)
  })

  it('appends when the pristine seed step has a branch', () => {
    const withBranch = addBranch(pristineSeed(), 'step_1')
    const withStep = addStep(withBranch, 'approval')

    expect(withStep.steps).toHaveLength(2)
  })

  it('appends on the second consecutive add from a pristine seed', () => {
    const withSteps = addStep(addStep(pristineSeed(), 'chat'), 'chat')

    expect(withSteps.steps).toHaveLength(2)
  })

  it('adds, removes, and reorders steps without mutating the source', () => {
    const original = source()
    const withSteps = addStep(addStep(original, 'chat'), 'approval')
    expect(withSteps.steps.map((step) => step.kind)).toEqual(['chat', 'chat', 'approval'])
    const moved = moveStep(withSteps, withSteps.steps[2].stableStepId, -1)
    expect(moved.steps.map((step) => step.kind)).toEqual(['chat', 'approval', 'chat'])
    expect(removeStep(moved, moved.steps[1].stableStepId).steps).toHaveLength(2)
    expect(original.steps).toHaveLength(1)
  })

  it('adds, edits, targets, and removes branches as typed document data', () => {
    const branched = addBranch(source(), 'ask_email', 'field')
    const edited = updateBranchGuard(branched, 'ask_email', 0, { fieldRef: 'email', fieldOp: 'is_present' })
    const withTarget = targetBranchAtStep(addStep(edited, 'chat'), 'ask_email', 0, 'step_1')
    expect(withTarget.steps[0].branches[0]).toMatchObject({
      guard: { kind: 'field', fieldRef: 'email', fieldOp: 'is_present' },
      target: { kind: 'step', stableStepId: 'step_1' },
    })
    expect(removeBranch(withTarget, 'ask_email', 0).steps[0].branches).toEqual([])
    expect(changeBranchGuardKind(branched, 'ask_email', 0, 'llm').steps[0].branches[0].guard.kind).toBe('llm')
  })

  it('creates and references endings while preserving a single definition', () => {
    const withEnding = addEnding(source(), 'handoff')
    const handoff = withEnding.unreferencedEndings.find((ending) => ending.kind === 'handoff')!
    const branched = addBranch(withEnding, 'ask_email')
    const referenced = referenceEnding(branched, 'ask_email', 0, handoff.stableStepId)
    // The branch embeds its own copy of the definition so later edits to other branches
    // can never orphan it; emission still deduplicates to a single terminal.
    expect(referenced.steps[0].branches[0].target).toMatchObject({ kind: 'ending', terminalId: handoff.stableStepId, ending: { kind: 'handoff' } })
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
    expect(renamed.information[0].stableSlotId).toBe('email')
    expect(renamed.information[0].key).toBe('customer_email')
    expect(renamed.steps[0].instruction).toContainEqual({ kind: 'slotReference', key: 'customer_email', source: '{{slot.customer_email}}' })
    expect(renamed.steps[0].inputBindings?.recipient).toEqual({ kind: 'variableRef', ref: 'customer_email' })
    expect(renamed.steps[0].branches[0].guard).toMatchObject({ slotKeys: ['customer_email'] })
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
    expect(edited.steps[1].inputBindings?.locale).toEqual({ kind: 'contextVariableRef', contextVariable: 'page_locale' })
    expect(edited.steps[1].outputAssignments).toEqual({ account_id: 'account_id' })
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

  it('preserves field and AI branch guards through the Document-to-Form sync path', () => {
    const initial = routineToBlockDoc({
      name: 'Check order eligibility',
      activation: { triggerDescription: 'When a customer asks whether an order is eligible.', priority: 0 },
      slots: [],
      steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: 'Ask for the order total.', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [],
      terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: '', ordinal: 0 }],
    })
    if (!initial.ok) throw new Error(initial.diagnostics.map((item) => item.message).join(', '))

    let doc = addStep(initial.doc, 'chat')
    doc = replaceInstruction(doc, 'step_2', [
      { kind: 'text', text: 'Ask for ' },
      { kind: 'slotReference', key: 'order_total', source: '{{slot.order_total}}' },
    ])
    doc = renameSlot(addSlot(doc), 'slot_1', 'order_total')
    doc = updateSlot(doc, 'order_total', { type: 'number' })
    doc = updateStep(addStep(doc, 'tool'), 'step_3', { toolRef: 'orders.check_eligibility' })

    doc = addBranch(doc, 'step_3')
    doc = changeBranchGuardKind(doc, 'step_3', 0, 'field')
    doc = updateBranchGuard(doc, 'step_3', 0, { fieldRef: 'order_total', fieldOp: 'lt', fieldValue: '50' })
    doc = updateEnding(createEndingForBranch(doc, 'step_3', 0, 'handoff'), 'handoff_1', { instruction: 'Hand this order to the billing team.' })

    doc = addBranch(doc, 'step_3')
    doc = changeBranchGuardKind(doc, 'step_3', 1, 'llm')
    doc = updateBranchGuard(doc, 'step_3', 1, { guardText: 'The customer needs a nuanced eligibility explanation.' })

    const draft = draftFromBlockDoc(doc)
    expect(draft.transitions).toHaveLength(2)
    expect(draft.transitions.map((transition) => transition.guardKind)).toEqual(['field', 'llm'])

    const draftAsRoutine = (nextDraft: RoutineDefinitionDraft): RoutineDefinition => ({
      ...nextDraft,
      id: 'local-draft',
      lineageId: 'local-lineage',
      agentId: 'local-agent',
      version: 1,
      status: 'draft',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })
    const form = routineToForm(draftAsRoutine(draft))
    expect(form.steps.find((step) => step.stableStepId === 'step_3')?.transitions.map((transition) => transition.guardKind)).toEqual(['field', 'llm'])
  })

  it('allocates approval option ids without colliding after deletion', () => {
    const options = [
      { id: 'approve', label: 'Approve', description: null },
      { id: 'option_3', label: 'Later', description: null },
    ]

    expect(nextApprovalOptionId(options)).toBe('option_1')
    expect(nextApprovalOptionId([...options, { id: 'option_1', label: 'First', description: null }])).toBe('option_2')
  })
})

describe('approval decision edges', () => {
  const emptyDoc = () => {
    const projected = routineToBlockDoc({
      name: 'X',
      activation: { triggerDescription: 't', priority: 0 },
      slots: [],
      steps: [{ stableStepId: 'step_1', kind: 'chat', instruction: 'Greet.', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [],
      terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: 'Done.', ordinal: 0 }],
    })
    if (!projected.ok) throw new Error('fixture must project')
    return projected.doc
  }

  it('creates one decision edge per option when an approval step is added', () => {
    const doc = addStep(emptyDoc(), 'approval')
    const approval = doc.steps.find((step) => step.kind === 'approval')!
    expect(approval.branches).toHaveLength(2)
    expect(approval.branches.map((branch) => branch.guard)).toMatchObject([
      { kind: 'field', fieldRef: 'decision.id', fieldOp: 'equals', fieldValue: 'approve' },
      { kind: 'field', fieldRef: 'decision.id', fieldOp: 'equals', fieldValue: 'decline' },
    ])
    const emitted = draftFromBlockDoc(doc)
    const decisionEdges = emitted.transitions.filter((transition) => transition.fieldRef === 'decision.id')
    expect(decisionEdges).toHaveLength(2)
  })

  it('reconciles edges when options are added, removed, or the capture key changes', () => {
    const withApproval = addStep(emptyDoc(), 'approval')
    const approvalId = withApproval.steps.find((step) => step.kind === 'approval')!.stableStepId
    const options = withApproval.steps.find((step) => step.kind === 'approval')!.options!

    const withThird = updateApproval(withApproval, approvalId, { options: [...options, { id: 'defer', label: 'Defer', description: null }] })
    expect(withThird.steps.find((step) => step.stableStepId === approvalId)!.branches).toHaveLength(3)

    const withoutDecline = updateApproval(withThird, approvalId, { options: [options[0], { id: 'defer', label: 'Defer', description: null }] })
    const branches = withoutDecline.steps.find((step) => step.stableStepId === approvalId)!.branches
    expect(branches.map((branch) => branch.guard.fieldValue)).toEqual(['approve', 'defer'])

    const renamed = updateApproval(withoutDecline, approvalId, { captureKey: 'verdict' })
    const renamedBranches = renamed.steps.find((step) => step.stableStepId === approvalId)!.branches
    expect(renamedBranches.every((branch) => branch.guard.fieldRef === 'verdict.id')).toBe(true)
  })

  it('leaves custom branches on an approval step untouched', () => {
    const withApproval = addStep(emptyDoc(), 'approval')
    const approvalId = withApproval.steps.find((step) => step.kind === 'approval')!.stableStepId
    const withCustom = updateBranch(addBranch(withApproval, approvalId, 'llm'), approvalId, 2, {
      guard: { kind: 'llm', provenance: 'judgment', guardText: 'needs a human read', outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null },
    })
    const reconciled = updateApproval(withCustom, approvalId, { captureKey: 'decision' })
    const guards = reconciled.steps.find((step) => step.stableStepId === approvalId)!.branches.map((branch) => branch.guard.kind)
    expect(guards.filter((kind) => kind === 'llm')).toHaveLength(1)
    expect(guards.filter((kind) => kind === 'field')).toHaveLength(2)
  })
})
