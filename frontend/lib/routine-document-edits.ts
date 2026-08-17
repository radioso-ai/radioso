import { slugifyVariableKey, type ApprovalDocOption, type RoutineBlockBranch, type RoutineBlockDoc, type RoutineBlockEnding, type RoutineBlockGuard, type RoutineBlockInstructionSegment, type RoutineBlockSlot, type RoutineBlockStep, type RoutineInputBinding } from '@/lib/routine-prose'
import type { RoutineGuardKind, RoutineStepKind, RoutineTerminalKind } from '@/lib/api-types'
import { approvalCaptureFieldRef } from '@/lib/routine-approval'

const copy = <T>(value: T): T => structuredClone(value)

const defaultInstruction = (): RoutineBlockInstructionSegment[] => [{ kind: 'text', text: '' }]

const nextId = (prefix: string, ids: Iterable<string>) => {
  const used = new Set(ids)
  let index = 1
  while (used.has(`${prefix}_${index}`)) index += 1
  return `${prefix}_${index}`
}

export const createDocumentStep = (kind: RoutineStepKind, existing: RoutineBlockStep[]): RoutineBlockStep => {
  const stableStepId = nextId('step', existing.map((step) => step.stableStepId))
  return {
    stableStepId,
    kind,
    instruction: defaultInstruction(),
    toolRef: kind === 'tool' ? '' : null,
    ...(kind === 'action' ? { actionType: '' } : {}),
    ...(kind === 'approval' ? {
      captureKey: 'decision',
      options: [
        { id: 'approve', label: 'Approve', description: null },
        { id: 'decline', label: 'Decline', description: null },
      ],
    } : {}),
    additionalMetadata: {},
    branches: [],
  }
}

const isPristineSeedStep = (step: RoutineBlockStep) =>
  step.stableStepId === 'step_1'
  && step.kind === 'chat'
  && step.instruction.every((segment) => segment.kind === 'text' && segment.text === '')
  && step.branches.length === 0
  && step.captureKey == null
  && Object.keys(step.inputBindings ?? {}).length === 0
  && Object.keys(step.outputAssignments ?? {}).length === 0
  && step.toolRef == null
  && step.actionType == null

export const addStep = (doc: RoutineBlockDoc, kind: RoutineStepKind): RoutineBlockDoc => {
  const next = copy(doc)
  const step = createDocumentStep(kind, next.steps)
  if (next.steps.length === 1 && isPristineSeedStep(next.steps[0]!)) next.steps = [step]
  else next.steps.push(step)
  return kind === 'approval' ? syncApprovalBranches(next, step.stableStepId) : next
}

export const removeStep = (doc: RoutineBlockDoc, stableStepId: string): RoutineBlockDoc => {
  const next = copy(doc)
  next.steps = next.steps.filter((step) => step.stableStepId !== stableStepId)
  // A removed target would make the block document non-projectable. Retain the branch but
  // send it to a new complete ending, so the author can immediately choose another target.
  const terminalIds = new Set([
    ...next.unreferencedEndings.map((ending) => ending.stableStepId),
    ...next.steps.flatMap((step) => step.branches.flatMap((branch) => branch.target.kind === 'ending' ? [branch.target.terminalId] : [])),
  ])
  let endingOrdinal = terminalIds.size
  next.steps = next.steps.map((step) => ({
    ...step,
    branches: step.branches.map((branch) => branch.target.kind === 'step' && branch.target.stableStepId === stableStepId
      ? (() => {
          const terminalId = nextId('complete', terminalIds)
          terminalIds.add(terminalId)
          return { ...branch, target: { kind: 'ending' as const, terminalId, ending: { stableStepId: terminalId, kind: 'complete' as const, instruction: '', ordinal: endingOrdinal++ } } }
        })()
      : branch),
  }))
  return next
}

export const moveStep = (doc: RoutineBlockDoc, stableStepId: string, direction: -1 | 1): RoutineBlockDoc => {
  const next = copy(doc)
  const index = next.steps.findIndex((step) => step.stableStepId === stableStepId)
  const destination = index + direction
  if (index < 0 || destination < 0 || destination >= next.steps.length) return next
  ;[next.steps[index], next.steps[destination]] = [next.steps[destination]!, next.steps[index]!]
  return next
}

export const replaceInstruction = (doc: RoutineBlockDoc, stableStepId: string, instruction: RoutineBlockInstructionSegment[]): RoutineBlockDoc => ({
  ...copy(doc),
  steps: doc.steps.map((step) => step.stableStepId === stableStepId ? { ...copy(step), instruction: copy(instruction) } : copy(step)),
})

const guardFor = (kind: RoutineGuardKind): RoutineBlockGuard => {
  const base = {
    guardText: kind === 'llm' ? '' : null,
    provenance: kind === 'llm' ? ('judgment' as const) : ('exact' as const),
    outcomeStatus: null,
    counterLimit: null,
    fieldRef: null,
    fieldOp: null,
    fieldValue: null,
    fieldValues: null,
    fieldUnit: null,
  }
  if (kind === 'slot_filled') return { ...base, kind, slotKeys: [] }
  return { ...base, kind }
}

const createEndingTarget = (doc: RoutineBlockDoc, kind: RoutineTerminalKind): RoutineBlockBranch['target'] => {
  const ids = [
    ...doc.unreferencedEndings.map((ending) => ending.stableStepId),
    ...doc.steps.flatMap((step) => step.branches.flatMap((branch) => branch.target.kind === 'ending' ? [branch.target.terminalId] : [])),
  ]
  const stableStepId = nextId(kind === 'complete' ? 'complete' : 'handoff', ids)
  const ending: RoutineBlockEnding = { stableStepId, kind, instruction: '', ordinal: ids.length }
  return { kind: 'ending', terminalId: stableStepId, ending }
}

export const addBranch = (doc: RoutineBlockDoc, stableStepId: string, guardKind: RoutineGuardKind = 'default'): RoutineBlockDoc => {
  const next = copy(doc)
  next.steps = next.steps.map((step) => step.stableStepId === stableStepId
    ? { ...step, branches: [...step.branches, { guard: guardFor(guardKind), target: createEndingTarget(next, 'complete') }] }
    : step)
  return next
}

export const updateBranch = (doc: RoutineBlockDoc, stepId: string, branchIndex: number, patch: Partial<RoutineBlockBranch>): RoutineBlockDoc => ({
  ...copy(doc),
  steps: doc.steps.map((step) => step.stableStepId === stepId ? {
    ...copy(step),
    branches: step.branches.map((branch, index) => index === branchIndex ? { ...copy(branch), ...copy(patch) } : copy(branch)),
  } : copy(step)),
})

export const updateBranchGuard = (doc: RoutineBlockDoc, stepId: string, branchIndex: number, patch: Partial<RoutineBlockGuard>): RoutineBlockDoc => {
  const branch = doc.steps.find((step) => step.stableStepId === stepId)?.branches[branchIndex]
  return branch ? updateBranch(doc, stepId, branchIndex, { guard: { ...branch.guard, ...copy(patch) } as RoutineBlockGuard }) : copy(doc)
}

export const changeBranchGuardKind = (doc: RoutineBlockDoc, stepId: string, branchIndex: number, kind: RoutineGuardKind): RoutineBlockDoc =>
  updateBranch(doc, stepId, branchIndex, { guard: guardFor(kind) })

export const removeBranch = (doc: RoutineBlockDoc, stepId: string, branchIndex: number): RoutineBlockDoc => ({
  ...copy(doc),
  steps: doc.steps.map((step) => step.stableStepId === stepId
    ? { ...copy(step), branches: step.branches.filter((_, index) => index !== branchIndex).map(copy) }
    : copy(step)),
})

export const targetBranchAtStep = (doc: RoutineBlockDoc, stepId: string, branchIndex: number, targetStepId: string): RoutineBlockDoc =>
  updateBranch(doc, stepId, branchIndex, { target: { kind: 'step', stableStepId: targetStepId } })

export const createEndingForBranch = (doc: RoutineBlockDoc, stepId: string, branchIndex: number, kind: RoutineTerminalKind): RoutineBlockDoc => {
  const next = copy(doc)
  return updateBranch(next, stepId, branchIndex, { target: createEndingTarget(next, kind) })
}

export const referenceEnding = (doc: RoutineBlockDoc, stepId: string, branchIndex: number, terminalId: string): RoutineBlockDoc => {
  const ending = doc.unreferencedEndings.find((item) => item.stableStepId === terminalId)
    ?? doc.steps.flatMap((step) => step.branches)
      .map((branch) => branch.target.kind === 'ending' ? branch.target : undefined)
      .find((target) => target?.terminalId === terminalId)?.ending
  return ending ? updateBranch(doc, stepId, branchIndex, { target: { kind: 'ending', terminalId, ending: copy(ending) } }) : copy(doc)
}

export const addEnding = (doc: RoutineBlockDoc, kind: RoutineTerminalKind): RoutineBlockDoc => {
  const next = copy(doc)
  const target = createEndingTarget(next, kind)
  if (target.kind === 'ending' && target.ending) next.unreferencedEndings.push(target.ending)
  return next
}

export const updateEnding = (doc: RoutineBlockDoc, terminalId: string, patch: Partial<RoutineBlockEnding>): RoutineBlockDoc => {
  const next = copy(doc)
  next.unreferencedEndings = next.unreferencedEndings.map((ending) => ending.stableStepId === terminalId ? { ...ending, ...copy(patch) } : ending)
  next.steps = next.steps.map((step) => ({
    ...step,
    branches: step.branches.map((branch) => branch.target.kind === 'ending' && branch.target.ending?.stableStepId === terminalId
      ? { ...branch, target: { ...branch.target, ending: { ...branch.target.ending, ...copy(patch) } } }
      : branch),
  }))
  return next
}

const replaceSlotReferences = (segments: RoutineBlockInstructionSegment[], from: string, to: string) => segments.map((segment) =>
  segment.kind === 'slotReference' && segment.key === from ? { ...segment, key: to, source: `{{slot.${to}}}` } : segment,
)

export const renameSlot = (doc: RoutineBlockDoc, stableSlotId: string, key: string): RoutineBlockDoc => {
  const previous = doc.information.find((slot) => slot.stableSlotId === stableSlotId)
  if (!previous || !key.trim()) return copy(doc)
  const nextKey = slugifyVariableKey(key)
  const next = copy(doc)
  next.information = next.information.map((slot) => slot.stableSlotId === stableSlotId ? { ...slot, key: nextKey, stableSlotId: nextKey } : slot)
  next.steps = next.steps.map((step) => ({
    ...step,
    instruction: replaceSlotReferences(step.instruction, previous.key, nextKey),
    inputBindings: Object.fromEntries(Object.entries(step.inputBindings ?? {}).map(([input, binding]) => [input,
      binding.kind === 'variableRef' && binding.ref === previous.key ? { ...binding, ref: nextKey } : binding,
    ])),
    outputAssignments: Object.fromEntries(Object.entries(step.outputAssignments ?? {}).map(([output, assignment]) => [output, assignment === previous.key ? nextKey : assignment])),
    branches: step.branches.map((branch) => ({ ...branch, guard: renameGuardRef(branch.guard, previous.key, nextKey) })),
  }))
  return next
}

const renameGuardRef = (guard: RoutineBlockGuard, from: string, to: string): RoutineBlockGuard => {
  if (guard.kind === 'slot_filled') return { ...guard, slotKeys: guard.slotKeys.map((key) => key === from ? to : key) }
  return guard.kind === 'field' && guard.fieldRef === from ? { ...guard, fieldRef: to } : guard
}

export const addSlot = (doc: RoutineBlockDoc): RoutineBlockDoc => {
  const next = copy(doc)
  const key = nextId('slot', next.information.map((slot) => slot.key))
  next.information.push({ stableSlotId: key, key, type: 'text', required: true, description: null, mutable: false })
  return next
}

export const updateSlot = (doc: RoutineBlockDoc, stableSlotId: string, patch: Partial<RoutineBlockSlot>): RoutineBlockDoc => ({
  ...copy(doc), information: doc.information.map((slot) => slot.stableSlotId === stableSlotId ? { ...copy(slot), ...copy(patch) } : copy(slot)),
})

export const slotReferences = (doc: RoutineBlockDoc, key: string): string[] => {
  const references: string[] = []
  for (const step of doc.steps) {
    if (step.instruction.some((segment) => segment.kind === 'slotReference' && segment.key === key)) references.push(`instruction in ${step.stableStepId}`)
    if (Object.values(step.inputBindings ?? {}).some((binding) => binding.kind === 'variableRef' && binding.ref === key)) references.push(`binding in ${step.stableStepId}`)
    if (Object.values(step.outputAssignments ?? {}).includes(key)) references.push(`output in ${step.stableStepId}`)
    if (step.branches.some((branch) => branch.guard.kind === 'slot_filled' ? branch.guard.slotKeys.includes(key) : branch.guard.kind === 'field' && branch.guard.fieldRef === key)) references.push(`guard in ${step.stableStepId}`)
  }
  return references
}

export const removeSlot = (doc: RoutineBlockDoc, stableSlotId: string): RoutineBlockDoc => ({
  ...copy(doc), information: doc.information.filter((slot) => slot.stableSlotId !== stableSlotId).map(copy),
})

export const updateBindings = (doc: RoutineBlockDoc, stepId: string, state: { inputBindings?: Record<string, RoutineInputBinding>; outputAssignments?: Record<string, string>; mode?: 'typed' | 'untyped' }): RoutineBlockDoc => ({
  ...copy(doc), steps: doc.steps.map((step) => step.stableStepId === stepId ? { ...copy(step), ...copy(state) } : copy(step)),
})

// An approval's options are its decision edges: the backend requires one
// `<captureKey>.id == <optionId>` transition per option, so the document keeps a branch per
// option. Targets stay editable through the ordinary branch rows.
const approvalOptionGuard = (captureKey: string, optionId: string): RoutineBlockGuard => ({
  kind: 'field',
  provenance: 'exact',
  guardText: null,
  outcomeStatus: null,
  counterLimit: null,
  fieldRef: approvalCaptureFieldRef(captureKey),
  fieldOp: 'equals',
  fieldValue: optionId,
  fieldValues: null,
  fieldUnit: null,
})

const isApprovalOptionBranch = (branch: RoutineBlockBranch, fieldRefs: string[]) =>
  branch.guard.kind === 'field' && branch.guard.fieldOp === 'equals' && branch.guard.fieldRef !== null && branch.guard.fieldRef !== undefined && fieldRefs.includes(branch.guard.fieldRef)

export const syncApprovalBranches = (doc: RoutineBlockDoc, stepId: string, previousCaptureKey?: string | null): RoutineBlockDoc => {
  const next = copy(doc)
  const step = next.steps.find((candidate) => candidate.stableStepId === stepId)
  if (!step || step.kind !== 'approval' || !step.captureKey) return next
  const captureKey = step.captureKey
  const fieldRef = approvalCaptureFieldRef(captureKey)
  const knownRefs = previousCaptureKey ? [fieldRef, approvalCaptureFieldRef(previousCaptureKey)] : [fieldRef]
  const options = step.options ?? []
  const optionIds = new Set(options.map((option) => option.id))
  const kept: RoutineBlockBranch[] = []
  const existingByOption = new Map<string, RoutineBlockBranch>()
  for (const branch of step.branches) {
    if (!isApprovalOptionBranch(branch, knownRefs)) {
      kept.push(branch)
      continue
    }
    const optionId = String(branch.guard.fieldValue ?? '')
    if (optionIds.has(optionId)) existingByOption.set(optionId, branch)
  }
  step.branches = [
    ...options.map((option) => {
      const existing = existingByOption.get(option.id)
      return existing
        ? { ...existing, guard: approvalOptionGuard(captureKey, option.id) }
        : { guard: approvalOptionGuard(captureKey, option.id), target: createEndingTarget(next, 'complete') }
    }),
    ...kept,
  ]
  return next
}

export const updateApproval = (doc: RoutineBlockDoc, stepId: string, patch: { instruction?: RoutineBlockInstructionSegment[]; captureKey?: string | null; options?: ApprovalDocOption[] }): RoutineBlockDoc => {
  const { options, ...rest } = patch
  const normalized = {
    ...copy(rest),
    ...(options ? { options: options.map((option) => ({ ...option, description: option.description ?? null })) } : {}),
  }
  const previousCaptureKey = doc.steps.find((step) => step.stableStepId === stepId)?.captureKey
  const next = { ...copy(doc), steps: doc.steps.map((step) => step.stableStepId === stepId ? { ...copy(step), ...normalized } : copy(step)) }
  return syncApprovalBranches(next, stepId, previousCaptureKey)
}

export const updateActivation = (doc: RoutineBlockDoc, patch: Partial<RoutineBlockDoc['activation']>): RoutineBlockDoc => ({ ...copy(doc), activation: { ...doc.activation, ...copy(patch) } })

export const updateStep = (doc: RoutineBlockDoc, stepId: string, patch: Partial<RoutineBlockStep>): RoutineBlockDoc => ({
  ...copy(doc), steps: doc.steps.map((step) => step.stableStepId === stepId ? { ...copy(step), ...copy(patch) } : copy(step)),
})
