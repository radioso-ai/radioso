import { presentSourceCandidates } from '@radioso/routine-definition'
import { draftFromBlockDoc, slugifyVariableKey, type RoutineBlockDoc, type RoutineBlockStep } from '@/lib/routine-prose'

/**
 * A chat step that shows a tool step's results as cards (#1763): which tool step's results, and
 * the item field a visitor's pick fills. The author binds both; the model chooses which results
 * show and which of their fields fill a card. Validation reports a binding that cannot work, so a
 * half-made one still saves as a draft.
 */
type RoutineStepPresent = NonNullable<RoutineBlockStep['present']>

const mapStep = (doc: RoutineBlockDoc, stepId: string, edit: (step: RoutineBlockStep) => RoutineBlockStep): RoutineBlockDoc => {
  const next = structuredClone(doc)
  next.steps = next.steps.map((step) => step.stableStepId === stepId ? edit(step) : step)
  return next
}

const withoutPresent = (step: RoutineBlockStep): RoutineBlockStep => {
  const rest = { ...step }
  delete rest.present
  return rest
}

/**
 * The tool steps whose results a step can show: those that lead to it through tool and action steps
 * only, so their result is still there on the turn the step replies. The rule validation applies.
 */
export const presentSourceOptions = (doc: RoutineBlockDoc, stepId: string): string[] => {
  const draft = draftFromBlockDoc(doc)
  return presentSourceCandidates(draft.steps, draft.transitions, stepId)
}

/** The item fields a pick can fill. */
export const itemFieldOptions = (doc: RoutineBlockDoc): string[] =>
  doc.information.filter((slot) => slot.type === 'item').map((slot) => slot.key)

/** Shows `from`'s results as cards on the step, keeping what a pick fills; null stops showing them. */
export const setPresentSource = (doc: RoutineBlockDoc, stepId: string, from: string | null): RoutineBlockDoc =>
  mapStep(doc, stepId, (step) => from
    ? { ...step, present: { ...(step.present ?? { selection: 'none' as const }), from } }
    : withoutPresent(step))

/** Lets the visitor's pick fill the item field `slot`; null only shows the cards. */
export const setPresentPick = (doc: RoutineBlockDoc, stepId: string, slot: string | null): RoutineBlockDoc =>
  mapStep(doc, stepId, (step) => step.present
    ? { ...step, present: slot ? { from: step.present.from, selection: 'single', slot } : { from: step.present.from, selection: 'none' } }
    : step)

/** Adds an item field named after the step's source and lets the pick fill it. */
export const addPresentPickField = (doc: RoutineBlockDoc, stepId: string): RoutineBlockDoc => {
  const step = doc.steps.find((candidate) => candidate.stableStepId === stepId)
  if (!step?.present) return structuredClone(doc)
  const taken = new Set(doc.information.map((slot) => slot.key))
  const base = slugifyVariableKey(`chosen_${step.present.from}`) || 'chosen_item'
  let key = base
  for (let index = 2; taken.has(key); index += 1) key = `${base}_${index}`
  const next = structuredClone(doc)
  next.information.push({ stableSlotId: key, key, type: 'item', required: true, description: null, mutable: false })
  return setPresentPick(next, stepId, key)
}

/** The step's binding with a renamed field or step followed; unchanged when it names neither. */
export const renameInPresent = (
  present: RoutineStepPresent | undefined,
  rename: { slot?: { from: string; to: string }; step?: { from: string; to: string } },
): RoutineStepPresent | undefined => {
  if (!present) return present
  const from = rename.step && present.from === rename.step.from ? rename.step.to : present.from
  const slot = rename.slot && present.slot === rename.slot.from ? rename.slot.to : present.slot
  return { ...present, from, ...(slot ? { slot } : {}) }
}

/** One line for the step's row: where its cards come from, and what a pick fills. */
export const formatPresentLine = (present: RoutineStepPresent): string =>
  present.slot ? `Shows cards from @${present.from} → @${present.slot}` : `Shows cards from @${present.from}`
