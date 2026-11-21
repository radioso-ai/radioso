import type { SkillAuthoringOutput } from './api-routine-skill-catalog'
import type { RoutineSlotType } from './api-types'

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
