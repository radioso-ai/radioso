'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type RoutineHeaderState = {
  actions: ReactNode | null
  backAction: ReactNode | null
  // `undefined` means no routine section has registered a description yet — the page shell
  // reads that as still loading. `null` is a registered, deliberate "no subtitle"; a page shell
  // reading `undefined` the same as `null` would show a permanent "Loading…" once the routine
  // itself has nothing left to say.
  description: ReactNode | null | undefined
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
  description: undefined,
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
