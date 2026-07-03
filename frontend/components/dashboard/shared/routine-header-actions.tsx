'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type RoutineHeaderState = {
  actions: ReactNode | null
  backAction: ReactNode | null
  description: ReactNode | null
  title: ReactNode | null
}

type RoutineHeaderActionsContextValue = {
  header: RoutineHeaderState
  setHeader: (header: RoutineHeaderState) => void
}

const RoutineHeaderActionsContext = createContext<RoutineHeaderActionsContextValue | null>(null)
const emptyRoutineHeader: RoutineHeaderState = {
  actions: null,
  backAction: null,
  description: null,
  title: null,
}

export function RoutineHeaderActionsProvider({ children }: { children: ReactNode }) {
  const [header, setHeader] = useState<RoutineHeaderState>(emptyRoutineHeader)
  return (
    <RoutineHeaderActionsContext.Provider value={{ header, setHeader }}>
      {children}
    </RoutineHeaderActionsContext.Provider>
  )
}

export function useRegisterRoutineHeader(header: RoutineHeaderState) {
  const setHeader = useContext(RoutineHeaderActionsContext)?.setHeader
  useEffect(() => {
    if (!setHeader) return
    setHeader(header)
    return () => setHeader(emptyRoutineHeader)
  }, [header, setHeader])
}

export function useRoutineHeaderState() {
  return useContext(RoutineHeaderActionsContext)?.header ?? emptyRoutineHeader
}
