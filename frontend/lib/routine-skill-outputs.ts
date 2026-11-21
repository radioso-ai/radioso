import type { SkillAuthoringOutput } from './api-routine-skill-catalog'
import type { RoutineFieldGuardOp, RoutineSlotType } from './api-types'
import { fieldGuardOpsForType } from './routine-prose'

type VariableRef = { id: string; type: RoutineSlotType }

/**
 * The routine variable type a skill output is stored as, which is what decides the checks a guard
 * offers on it. A list has no variable type of its own, so it is kept as text.
 */
export const outputVariableType = (output: SkillAuthoringOutput): RoutineSlotType =>
  output.type === 'list' ? 'text' : output.type

/** The existing variables an output can be stored in without changing what a guard on them offers. */
export const variablesFittingOutput = (
  variables: readonly VariableRef[],
  output: SkillAuthoringOutput | undefined,
): VariableRef[] =>
  output ? variables.filter((variable) => variable.type === outputVariableType(output)) : [...variables]

/** The next declared output not yet assigned to a variable, for the Output button. */
export const nextUnassignedOutput = (
  outputs: readonly SkillAuthoringOutput[],
  assignments: Readonly<Record<string, string>>,
): SkillAuthoringOutput | undefined => outputs.find((output) => !(output.name in assignments))

type AssigningStep = {
  kind: string
  toolRef?: string | null
  actionType?: string | null
  outputAssignments?: Record<string, string>
}

/**
 * The variables a step assigns from a list output. A list has no variable type of its own, so the
 * editor knows a variable holds one only through the step that sets it and the catalog's type for
 * that output.
 */
export const listBackedVariableIds = (
  steps: readonly AssigningStep[],
  outputsOfSkill: (skillRef: string) => readonly SkillAuthoringOutput[] | undefined,
): Set<string> => {
  const ids = new Set<string>()
  for (const step of steps) {
    const ref = (step.kind === 'tool' ? step.toolRef : step.kind === 'action' ? step.actionType : '') ?? ''
    const outputs = ref ? outputsOfSkill(ref) : undefined
    if (!outputs) continue
    for (const [outputName, variableId] of Object.entries(step.outputAssignments ?? {})) {
      if (variableId && outputs.find((output) => output.name === outputName)?.type === 'list') ids.add(variableId)
    }
  }
  return ids
}

const LIST_GUARD_OPS: readonly RoutineFieldGuardOp[] = ['is_present', 'is_absent']

/** The checks a variable offers: only is-set and is-not-set for a list, since an empty list is absent. */
export const guardOpsForVariable = (type: RoutineSlotType, holdsList: boolean): readonly RoutineFieldGuardOp[] =>
  holdsList ? LIST_GUARD_OPS : fieldGuardOpsForType(type)

/** Whether a stored check still fits its variable; one that does not shows as invalid. */
export const guardOpFitsVariable = (op: RoutineFieldGuardOp, type: RoutineSlotType, holdsList: boolean): boolean =>
  guardOpsForVariable(type, holdsList).includes(op)
