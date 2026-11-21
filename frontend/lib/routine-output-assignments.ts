import type { SkillAuthoringOutput } from '@/lib/api-routine-skill-catalog'
import { slotRemovalBlockers } from '@/lib/routine-document-edits'
import { slugifyVariableKey, type RoutineBlockDoc } from '@/lib/routine-prose'
import { nextUnassignedOutput } from '@/lib/routine-skill-outputs'

// The Sets rows of a skill step: which output lands in which routine variable. A row is the
// variable's whole declaration, so none of these edits touches `information`: a variable a skill
// sets is never a field the routine collects, and the validator refuses a slot of the same name.
// Rows are edited in place, so a changed row never moves.

type Row = [output: string, variable: string]

const rowsOf = (doc: RoutineBlockDoc, stepId: string): Row[] =>
  Object.entries(doc.steps.find((step) => step.stableStepId === stepId)?.outputAssignments ?? {})

const withRows = (doc: RoutineBlockDoc, stepId: string, rows: Row[]): RoutineBlockDoc => {
  const next = structuredClone(doc)
  next.steps = next.steps.map((step) => step.stableStepId === stepId ? { ...step, outputAssignments: Object.fromEntries(rows) } : step)
  return next
}

const variableName = (value: string): string => value.trim() ? slugifyVariableKey(value) : ''

/** Whether a name already belongs to a collected field or to another step's or row's output. */
const nameIsTaken = (doc: RoutineBlockDoc, name: string): boolean =>
  doc.information.some((slot) => slot.key === name)
  || doc.steps.some((step) => Object.values(step.outputAssignments ?? {}).includes(name))

const freeName = (isTaken: (name: string) => boolean, base: string): string => {
  let name = base
  for (let suffix = 2; isTaken(name); suffix += 1) name = `${base}_${suffix}`
  return name
}

/**
 * Adds a row for the next declared output not yet set, landing in a variable of the output's own
 * name (numbered when that name is taken), so a row never holds an assignment with no variable.
 * With every declared output set, or none declared, the row names a numbered output to rename.
 */
export const addOutputAssignment = (doc: RoutineBlockDoc, stepId: string, outputs: readonly SkillAuthoringOutput[]): RoutineBlockDoc => {
  const rows = rowsOf(doc, stepId)
  const outputsInRows = new Set(rows.map(([output]) => output))
  const output = nextUnassignedOutput(outputs, Object.fromEntries(rows))?.name
    ?? freeName((name) => outputsInRows.has(name), `output_${rows.length + 1}`)
  return withRows(doc, stepId, [...rows, [output, freeName((name) => nameIsTaken(doc, name), variableName(output))]])
}

/**
 * Points row `index` at another output. A variable still named for the old output follows the new
 * one when nothing else reads it and the new name is free; otherwise the row keeps its variable.
 * An output another row already sets is refused, since two rows cannot read one output.
 */
export const changeAssignedOutput = (doc: RoutineBlockDoc, stepId: string, index: number, output: string): RoutineBlockDoc => {
  const rows = rowsOf(doc, stepId)
  const row = rows[index]
  if (!row || rows.some(([other], candidate) => candidate !== index && other === output)) return structuredClone(doc)
  const [previousOutput, variable] = row
  const withoutRow = withRows(doc, stepId, rows.filter((_, candidate) => candidate !== index))
  const renamed = variableName(output)
  const follows = variable === variableName(previousOutput)
    && slotRemovalBlockers(withoutRow, variable).length === 0
    && !nameIsTaken(withoutRow, renamed)
  return withRows(doc, stepId, rows.map((candidate, at) => at === index ? [output, follows ? renamed : variable] : candidate))
}

/** Row `index` stores its output in `value`, as a variable name. */
export const changeAssignedVariable = (doc: RoutineBlockDoc, stepId: string, index: number, value: string): RoutineBlockDoc =>
  withRows(doc, stepId, rowsOf(doc, stepId).map((row, at) => at === index ? [row[0], variableName(value)] : row))

export const removeOutputAssignment = (doc: RoutineBlockDoc, stepId: string, index: number): RoutineBlockDoc =>
  withRows(doc, stepId, rowsOf(doc, stepId).filter((_, at) => at !== index))
