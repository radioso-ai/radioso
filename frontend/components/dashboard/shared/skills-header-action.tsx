'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'

type AddSkillHandler = () => void

type SkillsHeaderActionContextValue = {
  handler: AddSkillHandler | null
  setHandler: (handler: AddSkillHandler | null) => void
}

const SkillsHeaderActionContext = createContext<SkillsHeaderActionContextValue | null>(null)

/**
 * Lets the Skills section contribute its "Add new skill" action to the page-level header.
 * The picker/dialog state stays in `SkillList`; only the trigger is shared upward.
 */
export function SkillsHeaderActionProvider({ children }: { children: ReactNode }) {
  const [handler, setHandler] = useState<AddSkillHandler | null>(null)
  return (
    <SkillsHeaderActionContext.Provider value={{ handler, setHandler }}>
      {children}
    </SkillsHeaderActionContext.Provider>
  )
}

/** Registers the section's add-skill trigger while mounted. Pass a stable (memoized) handler. */
export function useRegisterAddSkillAction(handler: AddSkillHandler) {
  // Depend on the stable `setHandler` (a useState setter), NOT the context object — the
  // provider value's identity changes whenever `handler` updates, which would loop the effect.
  const setHandler = useContext(SkillsHeaderActionContext)?.setHandler
  useEffect(() => {
    if (!setHandler) {
      return
    }
    setHandler(() => handler)
    return () => setHandler(null)
  }, [setHandler, handler])
}

/** Page-header button; renders only once the Skills section has registered its trigger. */
export function AddSkillHeaderButton() {
  const context = useContext(SkillsHeaderActionContext)
  const handler = context?.handler ?? null
  if (!handler) {
    return null
  }
  return (
    <Button type="button" size="sm" onClick={handler}>
      <Plus className="h-4 w-4" />
      Add new skill
    </Button>
  )
}
