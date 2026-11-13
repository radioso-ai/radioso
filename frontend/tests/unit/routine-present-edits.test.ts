import { describe, expect, it } from 'vitest'

import { changeStepKind, renameSlot, renameStep, slotRemovalBlockers } from '@/lib/routine-document-edits'
import {
  addPresentPickField,
  formatPresentLine,
  itemFieldOptions,
  presentSourceOptions,
  setPresentPick,
  setPresentSource,
} from '@/lib/routine-present-edits'
import { draftFromBlockDoc, routineToBlockDoc, type RoutineBlockDoc } from '@/lib/routine-prose'

// A chat step that shows a tool step's results as cards (#1763): the author picks the source and
// the item field a visitor's pick fills, and every other edit keeps the binding pointing right.

const homes = (): RoutineBlockDoc => {
  const result = routineToBlockDoc({
    name: 'Find a home',
    activation: { triggerDescription: 'A visitor looks for a home', priority: 0 },
    slots: [{ stableSlotId: 'area', key: 'area', type: 'text', required: true, description: null, ordinal: 0 }],
    steps: [
      { stableStepId: 'brief', kind: 'chat', instruction: 'Where? {{slot.area}}', toolRef: null, actionType: null, ordinal: 0, metadata: {} },
      { stableStepId: 'search', kind: 'tool', instruction: 'Search.', toolRef: 'search_homes', actionType: null, ordinal: 1, metadata: {} },
      { stableStepId: 'choose', kind: 'chat', instruction: 'Show the matches.', toolRef: null, actionType: null, ordinal: 2, metadata: {} },
    ],
    transitions: [],
    terminals: [{ stableStepId: 'complete', kind: 'complete', instruction: 'Done.', ordinal: 0 }],
  })
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join(', '))
  return result.doc
}

const choose = (doc: RoutineBlockDoc) => doc.steps.find((step) => step.stableStepId === 'choose')

describe('routine present edits', () => {
  it('offers the tool steps before the step as sources', () => {
    expect(presentSourceOptions(homes(), 'choose')).toEqual(['search'])
    expect(presentSourceOptions(homes(), 'brief')).toEqual([])
  })

  it('shows cards from a source, then lets a new item field take the pick, and saves both', () => {
    const shown = setPresentSource(homes(), 'choose', 'search')
    expect(choose(shown)?.present).toEqual({ from: 'search', selection: 'none' })

    const picked = addPresentPickField(shown, 'choose')
    expect(choose(picked)?.present).toEqual({ from: 'search', selection: 'single', slot: 'chosen_search' })
    expect(itemFieldOptions(picked)).toEqual(['chosen_search'])
    const draft = draftFromBlockDoc(picked)
    expect(draft.steps.find((step) => step.stableStepId === 'choose')?.metadata).toEqual({ present: { from: 'search', selection: 'single', slot: 'chosen_search' } })
    expect(draft.slots.find((slot) => slot.key === 'chosen_search')?.type).toBe('item')
  })

  it('goes back to only showing the cards, and off', () => {
    const picked = addPresentPickField(setPresentSource(homes(), 'choose', 'search'), 'choose')
    expect(choose(setPresentPick(picked, 'choose', null))?.present).toEqual({ from: 'search', selection: 'none' })
    expect(choose(setPresentSource(picked, 'choose', null))?.present).toBeUndefined()
  })

  it('follows a renamed field or source, keeps a bound field from being removed, and drops the binding off a non-chat step', () => {
    const picked = addPresentPickField(setPresentSource(homes(), 'choose', 'search'), 'choose')

    expect(choose(renameSlot(picked, 'chosen_search', 'chosen_home'))?.present?.slot).toBe('chosen_home')
    expect(choose(renameStep(picked, 1, 'find_homes'))?.present?.from).toBe('find_homes')
    expect(slotRemovalBlockers(picked, 'chosen_search')).toEqual(['cards in choose'])
    expect(choose(changeStepKind(picked, 'choose', 'tool'))?.present).toBeUndefined()
  })

  it('reads as one line on the step row', () => {
    expect(formatPresentLine({ from: 'search', selection: 'single', slot: 'chosen_home' })).toBe('Shows cards from @search → @chosen_home')
    expect(formatPresentLine({ from: 'search', selection: 'none' })).toBe('Shows cards from @search')
  })
})
