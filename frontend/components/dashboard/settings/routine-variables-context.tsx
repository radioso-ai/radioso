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
  return useContext(RoutineVariablesContext) ?? { variables: [], getType: () => 'text', setType: () => {} }
}
