'use client'

import { createContext, useContext, type ReactNode } from 'react'

import type { RoutineSlotType } from '@/lib/api-types'
import type { ChipDocVariable } from '@/lib/routine-prose'

// Lets a chip (rendered deep inside the Lexical document) read the type and flags of the
// variable it references, which is owned by the editor screen's state.
type RoutineVariablesContextValue = {
  variables: ChipDocVariable[]
  getType: (refId: string) => RoutineSlotType
  // The type, required, and mutable setters are present only where the chip may change that
  // property. Where the routine Document tab's field row owns it, the chip menu and the
  // condition builder show the value disabled.
  setType?: (refId: string, type: RoutineSlotType) => void
  // Whether a slot must be filled before the routine completes. Defaults to required.
  getRequired: (refId: string) => boolean
  setRequired?: (refId: string, required: boolean) => void
  // Whether a slot stays editable after the routine completes (issue #746). Defaults off.
  getMutable: (refId: string) => boolean
  setMutable?: (refId: string, mutable: boolean) => void
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
    getRequired: () => true,
    getMutable: () => false,
    supportsStepBindings: false,
  }
}
