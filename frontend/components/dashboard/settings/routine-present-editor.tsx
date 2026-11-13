'use client'

import { addPresentPickField, itemFieldOptions, presentSourceOptions, setPresentPick, setPresentSource } from '@/lib/routine-present-edits'
import type { RoutineBlockDoc, RoutineBlockStep } from '@/lib/routine-prose'

const NEW_FIELD = '__new_item_field__'
const selectClass = 'ml-1 h-9 rounded-md border border-input bg-transparent px-2 text-sm'

/**
 * A chat step's cards (#1763): the earlier tool step whose results it shows, and the item field a
 * visitor's pick fills. Off by default; a step without a pick field only shows its cards.
 */
export function RoutinePresentEditor({ step, stepIndex, doc, apply }: {
  step: RoutineBlockStep
  stepIndex: number
  doc: RoutineBlockDoc
  apply: (edit: (current: RoutineBlockDoc) => RoutineBlockDoc) => void
}) {
  const sources = presentSourceOptions(doc, step.stableStepId)
  const present = step.present
  if (sources.length === 0 && !present) return null
  const fields = itemFieldOptions(doc)
  return <div className="flex flex-wrap items-center gap-2">
    <label className="text-xs font-medium text-foreground">Show results as cards<select aria-label={`Step ${stepIndex + 1} cards from`} value={present?.from ?? ''} onChange={(event) => apply((current) => setPresentSource(current, step.stableStepId, event.target.value || null))} className={selectClass}><option value="">Off</option>{[...new Set([...sources, ...(present ? [present.from] : [])])].map((source) => <option key={source} value={source}>from @{source}</option>)}</select></label>
    {present ? <label className="text-xs font-medium text-foreground">Pick fills<select aria-label={`Step ${stepIndex + 1} pick fills`} value={present.slot ?? ''} onChange={(event) => { const value = event.target.value; apply((current) => value === NEW_FIELD ? addPresentPickField(current, step.stableStepId) : setPresentPick(current, step.stableStepId, value || null)) }} className={selectClass}><option value="">Nothing, only show</option>{[...new Set([...fields, ...(present.slot ? [present.slot] : [])])].map((field) => <option key={field} value={field}>@{field}</option>)}<option value={NEW_FIELD}>New item field</option></select></label> : null}
  </div>
}
