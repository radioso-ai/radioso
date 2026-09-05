import {
  routineDefinitionDraftEditingInputSchema,
  routineGuardProvenance,
  type RoutineDefinitionDraftEditingAuthoringInput,
  type RoutineDefinitionDraftEditingInput,
  type RoutineGuardProvenance,
  type RoutineInputBinding,
  type RoutineStepMode,
} from '@radioso/routine-definition'
import { SLOT_REFERENCE } from './document.js'
import type { RoutineDefinitionDraftAuthored } from './types.js'

type DraftSlot = RoutineDefinitionDraftEditingInput['slots'][number]
type DraftStep = RoutineDefinitionDraftEditingInput['steps'][number]
type DraftTransition = RoutineDefinitionDraftEditingInput['transitions'][number]
type DraftTerminal = RoutineDefinitionDraftEditingInput['terminals'][number]

export type RoutineBlockInstructionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'slotReference'; key: string; source: string }

export type RoutineBlockSlot = Omit<DraftSlot, 'ordinal'>

type RoutineBlockGuardFields = Omit<DraftTransition, 'fromStep' | 'toRef' | 'ordinal' | 'guardKind'>

type RoutineBlockGuardBase = RoutineBlockGuardFields & {
  kind: DraftTransition['guardKind']
  provenance: RoutineGuardProvenance
}

export type RoutineBlockGuard =
  | (RoutineBlockGuardBase & { kind: Exclude<DraftTransition['guardKind'], 'slot_filled'> })
  | (RoutineBlockGuardBase & { kind: 'slot_filled'; slotKeys: string[] })

export type RoutineBlockEnding = Omit<DraftTerminal, 'ordinal'> & {
  // Inline endings retain this source order so their definitions can move to their
  // first use without changing the relative order of the routine's terminals.
  ordinal: number
}

export type RoutineBlockBranchTarget =
  | { kind: 'step'; stableStepId: string }
  | { kind: 'ending'; terminalId: string; ending?: RoutineBlockEnding }
  // A transition naming an id that no longer exists. A draft saves without semantic
  // validation, so a step deleted through the API or an older row can leave one behind.
  // Representing it keeps the routine readable and lets the author retarget it in place,
  // rather than sending the whole document to a lower-level view over one broken edge.
  | { kind: 'unresolved'; toRef: string }

export type RoutineBlockBranch = {
  guard: RoutineBlockGuard
  target: RoutineBlockBranchTarget
}

export type RoutineBlockStep = Omit<DraftStep, 'instruction' | 'ordinal' | 'metadata'> & {
  instruction: RoutineBlockInstructionSegment[]
  inputBindings?: Record<string, RoutineInputBinding>
  outputAssignments?: Record<string, string>
  mode?: RoutineStepMode
  additionalMetadata: Record<string, unknown>
  branches: RoutineBlockBranch[]
}

export type RoutineBlockDoc = {
  name: string
  activation: RoutineDefinitionDraftEditingInput['activation']
  information: RoutineBlockSlot[]
  steps: RoutineBlockStep[]
  unreferencedEndings: RoutineBlockEnding[]
  completionExport?: RoutineDefinitionDraftEditingInput['completionExport']
}

export type RoutineBlockDiagnostic =
  | {
      code: 'schema_validation'
      message: string
      issues: Array<{ path: Array<string | number>; message: string }>
    }
  | {
      code: 'duplicate_stable_id' | 'unknown_transition_source' | 'unknown_transition_target'
      message: string
    }

export type RoutineToBlockDocResult =
  | { ok: true; doc: RoutineBlockDoc }
  | { ok: false; diagnostics: RoutineBlockDiagnostic[] }

const byOrdinal = <T extends { ordinal: number }>(left: T, right: T): number => left.ordinal - right.ordinal

export function instructionToBlockSegments(instruction: string): RoutineBlockInstructionSegment[] {
  const segments: RoutineBlockInstructionSegment[] = []
  let cursor = 0
  for (const match of instruction.matchAll(SLOT_REFERENCE)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: instruction.slice(cursor, start) })
    segments.push({ kind: 'slotReference', key: match[1], source: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < instruction.length || segments.length === 0) segments.push({ kind: 'text', text: instruction.slice(cursor) })
  return segments
}

export function blockSegmentsToInstruction(segments: RoutineBlockInstructionSegment[]): string {
  return segments.map((segment) => segment.kind === 'text' ? segment.text : segment.source).join('')
}

const metadataForBlock = (metadata: DraftStep['metadata']) => {
  const { inputBindings, outputAssignments, mode, ...additionalMetadata } = metadata
  return { inputBindings, outputAssignments, mode, additionalMetadata }
}

type RoutineBlockStructuralDiagnosticCode = Exclude<RoutineBlockDiagnostic['code'], 'schema_validation'>

const diagnostic = (code: RoutineBlockStructuralDiagnosticCode, message: string): RoutineToBlockDocResult => ({
  ok: false,
  diagnostics: [{ code, message }],
})

const slotKeysFromGuardText = (guardText: string | null): string[] => {
  const slotKeys = new Set<string>()
  for (const match of (guardText ?? '').matchAll(SLOT_REFERENCE)) slotKeys.add(match[1])
  return [...slotKeys]
}

const canonicalSlotFilledGuardText = (slotKeys: string[]): string =>
  slotKeys.map((slotKey) => `{{slot.${slotKey}}}`).join(' ')

export function routineToBlockDoc(input: RoutineDefinitionDraftEditingAuthoringInput): RoutineToBlockDocResult {
  const parsed = routineDefinitionDraftEditingInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: [{
        code: 'schema_validation',
        message: 'Routine definition input is invalid.',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.filter((segment): segment is string | number => typeof segment === 'string' || typeof segment === 'number'),
          message: issue.message,
        })),
      }],
    }
  }
  const draft = parsed.data
  const steps = [...draft.steps].sort(byOrdinal)
  const terminals = [...draft.terminals].sort(byOrdinal)
  const stepIds = new Set<string>()
  const terminalIds = new Set<string>()

  // Steps and terminals share one id namespace. A name used twice makes every branch to it
  // ambiguous, but refusing the whole document leaves the author with nowhere to fix it —
  // and the backend already reports the collision as `node_id_collision`, which the reader
  // anchors to the rows involved. So the document renders, and only the branches that
  // genuinely cannot resolve are marked.
  const collidedIds = new Set<string>()
  for (const id of [...steps.map((step) => step.stableStepId), ...terminals.map((terminal) => terminal.stableStepId)]) {
    if (stepIds.has(id) || terminalIds.has(id)) collidedIds.add(id)
    stepIds.add(id)
  }
  for (const terminal of terminals) terminalIds.add(terminal.stableStepId)
  for (const id of collidedIds) {
    stepIds.delete(id)
    terminalIds.delete(id)
  }

  for (const transition of draft.transitions) {
    // A transition out of a collided id still leaves a real step; it is only its target
    // that cannot be resolved. Check the steps themselves rather than the resolvable set.
    if (!steps.some((step) => step.stableStepId === transition.fromStep)) {
      return diagnostic('unknown_transition_source', `Transition source "${transition.fromStep}" does not name a step.`)
    }
  }

  // A collided id resolves to nothing on purpose: the branch cannot say which row it means.
  const terminalById = new Map(terminals.filter((terminal) => !collidedIds.has(terminal.stableStepId)).map((terminal) => [terminal.stableStepId, terminal]))
  // Every branch that targets a terminal carries the full ending. Copies keep target edits
  // local: removing or retargeting one branch can never take the definition away from
  // another. The inverse mapping deduplicates by stable id, and edits patch every copy.
  const transitionRows = (fromStep: string): RoutineBlockBranch[] => draft.transitions
    .filter((transition) => transition.fromStep === fromStep)
    .sort(byOrdinal)
    .map((transition) => {
      const { fromStep: _fromStep, toRef: _toRef, ordinal: _ordinal, guardKind, ...guardFields } = transition
      const terminal = terminalById.get(transition.toRef)
      const target: RoutineBlockBranchTarget = terminal
        ? { kind: 'ending', terminalId: terminal.stableStepId, ending: { ...terminal } }
        : stepIds.has(transition.toRef)
          ? { kind: 'step', stableStepId: transition.toRef }
          : { kind: 'unresolved', toRef: transition.toRef }
      const guard: RoutineBlockGuard = guardKind === 'slot_filled'
        ? { ...guardFields, kind: guardKind, provenance: routineGuardProvenance(guardKind), slotKeys: slotKeysFromGuardText(guardFields.guardText) }
        : { ...guardFields, kind: guardKind, provenance: routineGuardProvenance(guardKind) }
      return {
        guard,
        target,
      }
    })

  return {
    ok: true,
    doc: {
      name: draft.name,
      activation: draft.activation,
      information: [...draft.slots].sort(byOrdinal).map(({ ordinal: _ordinal, ...slot }) => slot),
      steps: steps.map(({ instruction, ordinal: _ordinal, metadata, ...step }) => ({
        ...step,
        instruction: instructionToBlockSegments(instruction),
        ...metadataForBlock(metadata),
        branches: transitionRows(step.stableStepId),
      })),
      unreferencedEndings: (() => {
        const referenced = new Set(draft.transitions.map((transition) => transition.toRef))
        return terminals.filter((terminal) => !referenced.has(terminal.stableStepId)).map((terminal) => ({ ...terminal }))
      })(),
      ...(draft.completionExport === undefined ? {} : { completionExport: draft.completionExport }),
    },
  }
}

const terminalFromTarget = (target: RoutineBlockBranchTarget): RoutineBlockEnding | undefined =>
  target.kind === 'ending' ? target.ending : undefined

// Saving preserves an unresolved edge exactly as it was read. The document shows the
// author that it points nowhere; only choosing a target rewrites it.
const branchToRef = (target: RoutineBlockBranchTarget): string => {
  if (target.kind === 'step') return target.stableStepId
  if (target.kind === 'ending') return target.terminalId
  return target.toRef
}

export function draftFromBlockDoc(doc: RoutineBlockDoc): RoutineDefinitionDraftAuthored {
  const endings = [
    ...doc.unreferencedEndings,
    ...doc.steps.flatMap((step) => step.branches.map((branch) => terminalFromTarget(branch.target)).filter((ending): ending is RoutineBlockEnding => ending !== undefined)),
  ].sort(byOrdinal)
  const terminalsById = new Set<string>()
  const terminals = endings.flatMap((ending) => {
    if (terminalsById.has(ending.stableStepId)) return []
    terminalsById.add(ending.stableStepId)
    const { ordinal: _ordinal, ...terminal } = ending
    return [{ ...terminal, ordinal: terminalsById.size - 1 }]
  })
  let transitionOrdinal = 0

  return {
    name: doc.name,
    activation: doc.activation,
    slots: doc.information.map((slot, ordinal) => ({ ...slot, ordinal })),
    steps: doc.steps.map(({ instruction, inputBindings, outputAssignments, mode, additionalMetadata, branches: _branches, ...step }, ordinal) => ({
      ...step,
      instruction: blockSegmentsToInstruction(instruction),
      ordinal,
      metadata: {
        ...additionalMetadata,
        ...(inputBindings === undefined ? {} : { inputBindings }),
        ...(outputAssignments === undefined ? {} : { outputAssignments }),
        ...(mode === undefined ? {} : { mode }),
      },
    })),
    transitions: doc.steps.flatMap((step) => step.branches.map((branch) => {
      if (branch.guard.kind === 'slot_filled') {
        const { kind, provenance: _provenance, slotKeys, ...guard } = branch.guard
        return {
          fromStep: step.stableStepId,
          toRef: branchToRef(branch.target),
          guardKind: kind,
          ...guard,
          guardText: canonicalSlotFilledGuardText(slotKeys),
          ordinal: transitionOrdinal++,
        }
      }
      const { kind, provenance: _provenance, ...guard } = branch.guard
      return {
        fromStep: step.stableStepId,
        toRef: branchToRef(branch.target),
        guardKind: kind,
        ...guard,
        ordinal: transitionOrdinal++,
      }
    })),
    terminals,
    ...(doc.completionExport === undefined ? {} : { completionExport: doc.completionExport }),
  }
}
