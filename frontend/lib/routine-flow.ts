import {
  collectedSlotsByStep,
  routineGuardProvenance,
  type RoutineGuardKind,
  type RoutineGuardProvenance,
  type RoutineStepKind,
  type RoutineTerminalKind,
} from '@radioso/routine-definition'

import { guardToSentence } from '@/lib/routine-document'
import {
  blockSegmentsToInstruction,
  type RoutineBlockDoc,
  type RoutineBlockEnding,
  type RoutineBlockInstructionSegment,
} from '@/lib/routine-prose'

/**
 * Projects the block document — the same shape the Document editor renders — onto a
 * node/edge graph for the canvas. Both views therefore agree on what a routine says;
 * only the presentation differs.
 *
 * Mirrors the `envelopeToFlowGraph` split in `turn-flow.ts`: this module owns the
 * meaning, the component owns the drawing.
 */

export const ROUTINE_FLOW_ACTIVATION_ID = 'activation'

/** Node ids are namespaced because a step and a terminal may share a stable id. */
const stepNodeId = (stableStepId: string): string => `step:${stableStepId}`
const endingNodeId = (terminalId: string): string => `ending:${terminalId}`
const unresolvedNodeId = (toRef: string): string => `unresolved:${toRef}`

export type RoutineFlowNodeKind = 'activation' | 'step' | 'ending' | 'unresolved'

export interface RoutineFlowNode {
  id: string
  nodeKind: RoutineFlowNodeKind
  /** The step's stable id, the ending's kind label, or the missing reference. */
  label: string
  sublabel: string
  stepKind?: RoutineStepKind
  terminalKind?: RoutineTerminalKind
  /** Slot keys this step is the collector for (empty for a later use of the same slot). */
  collects: string[]
  skillRef?: string
  actionType?: string
  approvalOptionCount?: number
}

export interface RoutineFlowEdge {
  id: string
  source: string
  target: string
  /** Absent on the activation edge, which is an entry rather than a transition. */
  guardKind?: RoutineGuardKind
  provenance: RoutineGuardProvenance
  /**
   * A `default` guard states no condition, so it is the plain onward path rather than
   * a decision — the same reading the Document editor gives it, where it renders as an
   * arrow with no badge.
   */
  isDecision: boolean
  /** The condition, in the Document editor's wording. Empty for the plain onward path. */
  sentence: string
  escalates: boolean
  selfLoop: boolean
  unresolved: boolean
}

export interface RoutineFlowGraph {
  nodes: RoutineFlowNode[]
  edges: RoutineFlowEdge[]
  /** Declared slots no chat step collects — they can never be filled from the visitor. */
  uncollectedSlotKeys: string[]
  /** How many branches actually decide something, and how many of those are rules. */
  decisionCounts: { total: number; rules: number }
}

/**
 * What a step says, for reading. A slot reference shows as its name — the stored
 * `{{slot.x}}` token is machinery the author never typed. `blockSegmentsToInstruction`
 * stays the form the slot-collection rule matches on.
 */
const segmentsToDisplayText = (segments: RoutineBlockInstructionSegment[]): string =>
  segments.map((segment) => (segment.kind === 'text' ? segment.text : segment.key)).join('')

const endingLabel = (kind: RoutineTerminalKind): string => (kind === 'complete' ? 'Finish' : 'Hand off')

export function routineBlockDocToFlowGraph(doc: RoutineBlockDoc): RoutineFlowGraph {
  const slotNames = new Map(doc.information.map((slot) => [slot.key, slot.key]))

  // Block-doc steps arrive in ordinal order, so the index is the ordinal the shared
  // collection rule needs.
  const collected = collectedSlotsByStep(
    doc.steps.map((step, ordinal) => ({
      stableStepId: step.stableStepId,
      kind: step.kind,
      instruction: blockSegmentsToInstruction(step.instruction),
      ordinal,
    })),
  )

  const nodes: RoutineFlowNode[] = [
    {
      id: ROUTINE_FLOW_ACTIVATION_ID,
      nodeKind: 'activation',
      label: 'Starts when',
      sublabel: doc.activation.triggerDescription,
      collects: [],
    },
    ...doc.steps.map((step): RoutineFlowNode => ({
      id: stepNodeId(step.stableStepId),
      nodeKind: 'step',
      label: step.stableStepId,
      sublabel: segmentsToDisplayText(step.instruction),
      stepKind: step.kind,
      collects: [...(collected.get(step.stableStepId) ?? [])],
      ...(step.toolRef ? { skillRef: step.toolRef } : {}),
      ...(step.actionType ? { actionType: step.actionType } : {}),
      ...(step.options ? { approvalOptionCount: step.options.length } : {}),
    })),
  ]

  // An ending can be referenced by several branches and defined inline on the first of
  // them, so collect one node per terminal id rather than one per reference.
  const endings = new Map<string, RoutineBlockEnding>()
  for (const step of doc.steps) {
    for (const branch of step.branches) {
      if (branch.target.kind === 'ending' && branch.target.ending) {
        endings.set(branch.target.terminalId, branch.target.ending)
      }
    }
  }
  for (const ending of doc.unreferencedEndings) endings.set(ending.stableStepId, ending)

  const unresolvedRefs = new Set<string>()
  const edges: RoutineFlowEdge[] = []
  const firstStep = doc.steps[0]

  if (firstStep) {
    edges.push({
      id: `${ROUTINE_FLOW_ACTIVATION_ID}->${firstStep.stableStepId}`,
      source: ROUTINE_FLOW_ACTIVATION_ID,
      target: stepNodeId(firstStep.stableStepId),
      provenance: 'exact',
      isDecision: false,
      sentence: '',
      escalates: false,
      selfLoop: false,
      unresolved: false,
    })
  }

  for (const step of doc.steps) {
    step.branches.forEach((branch, index) => {
      const target = branch.target
      let targetId: string
      let escalates = false
      if (target.kind === 'step') {
        targetId = stepNodeId(target.stableStepId)
      } else if (target.kind === 'ending') {
        targetId = endingNodeId(target.terminalId)
        escalates = endings.get(target.terminalId)?.kind === 'handoff'
      } else {
        targetId = unresolvedNodeId(target.toRef)
        unresolvedRefs.add(target.toRef)
      }
      edges.push({
        id: `${step.stableStepId}->${targetId}#${index}`,
        source: stepNodeId(step.stableStepId),
        target: targetId,
        guardKind: branch.guard.kind,
        provenance: routineGuardProvenance(branch.guard.kind),
        isDecision: branch.guard.kind !== 'default',
        sentence: branch.guard.kind === 'default' ? '' : guardToSentence(branch.guard, slotNames),
        escalates,
        selfLoop: target.kind === 'step' && target.stableStepId === step.stableStepId,
        unresolved: target.kind === 'unresolved',
      })
    })
  }

  for (const [terminalId, ending] of endings) {
    nodes.push({
      id: endingNodeId(terminalId),
      nodeKind: 'ending',
      label: endingLabel(ending.kind),
      sublabel: ending.instruction ?? '',
      terminalKind: ending.kind,
      collects: [],
    })
  }
  for (const toRef of unresolvedRefs) {
    nodes.push({
      id: unresolvedNodeId(toRef),
      nodeKind: 'unresolved',
      label: toRef,
      sublabel: 'This target no longer exists.',
      collects: [],
    })
  }

  const decisions = edges.filter((edge) => edge.isDecision)
  return {
    nodes,
    edges,
    uncollectedSlotKeys: doc.information
      .filter((slot) => ![...collected.values()].some((keys) => keys.includes(slot.key)))
      .map((slot) => slot.key),
    decisionCounts: {
      total: decisions.length,
      rules: decisions.filter((edge) => edge.provenance === 'exact').length,
    },
  }
}
