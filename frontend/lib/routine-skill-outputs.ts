import type { SkillAuthoringOutput } from './api-routine-skill-catalog'
import type { RoutineFieldGuardOp, RoutineSlotType } from './api-types'
import { fieldGuardOpsForType } from './routine-prose'

/**
 * The routine variable type a skill output is stored as, which is what decides the checks a guard
 * offers on it. A list has no variable type of its own, so it is kept as text.
 */
export const outputVariableType = (output: SkillAuthoringOutput): RoutineSlotType =>
  output.type === 'list' ? 'text' : output.type

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
 * A variable a skill step sets from one of its outputs. The assignment is its whole declaration:
 * it is never a field the routine collects, so it is not a slot, and a slot of the same name is a
 * collision. Its type is the catalog's type for that output; an output the catalog does not
 * declare is text. `setBy` is the skill of the first step that sets it.
 */
type AssignedVariable = { id: string; type: RoutineSlotType; holdsList: boolean; setBy: string }

const stepSkillRef = (step: AssigningStep): string =>
  (step.kind === 'tool' ? step.toolRef : step.kind === 'action' ? step.actionType : '') ?? ''

/** Every variable the steps set from skill outputs, once each, in the order the steps set them. */
export const assignedVariables = (
  steps: readonly AssigningStep[],
  outputsOfSkill: (skillRef: string) => readonly SkillAuthoringOutput[] | undefined,
): AssignedVariable[] => {
  const byId = new Map<string, AssignedVariable>()
  for (const step of steps) {
    const ref = stepSkillRef(step)
    if (!ref) continue
    const outputs = outputsOfSkill(ref)
    for (const [outputName, variableId] of Object.entries(step.outputAssignments ?? {})) {
      if (!variableId) continue
      const output = outputs?.find((candidate) => candidate.name === outputName)
      const holdsList = output?.type === 'list'
      const known = byId.get(variableId)
      if (known) known.holdsList ||= holdsList
      else byId.set(variableId, { id: variableId, type: output ? outputVariableType(output) : 'text', holdsList, setBy: ref })
    }
  }
  return [...byId.values()]
}

/**
 * The variables a step assigns from a list output. A list has no variable type of its own, so the
 * editor knows a variable holds one only through the step that sets it and the catalog's type for
 * that output.
 */
export const listBackedVariableIds = (
  steps: readonly AssigningStep[],
  outputsOfSkill: (skillRef: string) => readonly SkillAuthoringOutput[] | undefined,
): Set<string> => new Set(assignedVariables(steps, outputsOfSkill).filter((variable) => variable.holdsList).map((variable) => variable.id))

/**
 * The values an outcome rule on a skill step can match, once each. A step reports the outcome's
 * name as its status, so the name is what the rule compares; the catalog's `status` is only the
 * outcome's broad class and repeats across names (an API request's `not_found` is `completed`).
 */
export const outcomeRuleChoices = (
  outcomes: ReadonlyArray<{ name: string; displayName: string }>,
): Array<{ value: string; label: string }> => {
  const seen = new Set<string>()
  return outcomes.flatMap((outcome) => {
    if (seen.has(outcome.name)) return []
    seen.add(outcome.name)
    return [{ value: outcome.name, label: outcome.displayName }]
  })
}

const LIST_GUARD_OPS: readonly RoutineFieldGuardOp[] = ['is_present', 'is_absent']

/** The checks a variable offers: only is-set and is-not-set for a list, since an empty list is absent. */
export const guardOpsForVariable = (type: RoutineSlotType, holdsList: boolean): readonly RoutineFieldGuardOp[] =>
  holdsList ? LIST_GUARD_OPS : fieldGuardOpsForType(type)

/** Whether a stored check still fits its variable; one that does not shows as invalid. */
export const guardOpFitsVariable = (op: RoutineFieldGuardOp, type: RoutineSlotType, holdsList: boolean): boolean =>
  guardOpsForVariable(type, holdsList).includes(op)

/** A stored check that no longer fits a list variable; an ordinary variable is never flagged here. */
export const guardOpIsInvalidForList = (op: RoutineFieldGuardOp, type: RoutineSlotType, holdsList: boolean): boolean =>
  holdsList && !guardOpFitsVariable(op, type, true)
