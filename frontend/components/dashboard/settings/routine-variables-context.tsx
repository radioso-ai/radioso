'use client'

import { createContext, useContext, type ReactNode } from 'react'

import type { RoutineSlotType } from '@/lib/api-types'
import type { ChipDocVariable } from '@/lib/routine-prose'

// Lets a chip (rendered deep inside the Lexical document) read and set the type of the
// variable it references, which is owned by the editor screen's state. Keeps the type
// on the chip itself instead of a separate list the author has to hunt for.
export type RoutineVariablesContextValue = {
  variables: ChipDocVariable[]
  getType: (refId: string) => RoutineSlotType
  setType: (refId: string, type: RoutineSlotType) => void
  // Whether a slot must be filled before the routine completes. Defaults to required; the
  // chip lets the author mark it optional.
  getRequired: (refId: string) => boolean
  setRequired: (refId: string, required: boolean) => void
  // Whether a slot stays editable after the routine completes (issue #746). Defaults off.
  getMutable: (refId: string) => boolean
  setMutable: (refId: string, mutable: boolean) => void
  // True inside a routine, where a skill runs as a step and can bind its inputs to slots and
  // assign its outputs. A skill mentioned outside a routine (a directive action) has no step
  // to bind, so its chip shows the skill's identity only.
  supportsStepBindings: boolean
}

const RoutineVariablesContext = createContext<RoutineVariablesContextValue | null>(null)

export function RoutineVariablesProvider({
  value,
  children,
}: {
  value: RoutineVariablesContextValue
  children: ReactNode
}) {
  return <RoutineVariablesContext.Provider value={value}>{children}</RoutineVariablesContext.Provider>
}

export function useRoutineVariables(): RoutineVariablesContextValue {
  return useContext(RoutineVariablesContext) ?? {
    variables: [],
    getType: () => 'text',
    setType: () => {},
    getRequired: () => true,
    setRequired: () => {},
    getMutable: () => false,
    setMutable: () => {},
    supportsStepBindings: false,
  }
}
