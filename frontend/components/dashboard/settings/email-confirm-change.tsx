'use client'

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

import { Button } from '@/components/ui/button'

/** The one confirmation a consequential change asks for: what it does, then Confirm or Cancel. */
export function ConfirmChange({
  label,
  confirmRef,
  isBusy,
  onConfirm,
  onCancel,
  children,
}: {
  label: string
  confirmRef: RefObject<HTMLButtonElement | null>
  isBusy: boolean
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}) {
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <p className="text-sm text-foreground">{children}</p>
      <div className="flex flex-wrap gap-2">
        <Button ref={confirmRef} type="button" size="sm" disabled={isBusy} onClick={onConfirm}>
          Confirm
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Focus for a control whose confirmation replaces it for a moment: the Confirm button while
 * asking, the control itself afterwards, each placed once the render that shows it has landed.
 */
export function useConfirmFocus(isBusy: boolean) {
  const controlRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useRef<'control' | 'confirm' | null>(null)

  useEffect(() => {
    const target = focusAfterRender.current
    if (!target || isBusy) return
    focusAfterRender.current = null
    ;(target === 'confirm' ? confirmRef : controlRef).current?.focus()
  })

  return {
    controlRef,
    confirmRef,
    focusControl: () => { focusAfterRender.current = 'control' },
    focusConfirm: () => { focusAfterRender.current = 'confirm' },
  }
}
