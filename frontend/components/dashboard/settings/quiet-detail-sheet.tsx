'use client'

import { useRef, useState, type ReactNode } from 'react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

// The side sheet a quiet-list row opens: everything the one-line row leaves out, with the row's
// actions in a footer.

export function QuietSheetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  )
}

// Secondary settings as a label/value grid below the main fields.
export function QuietSheetDetails({ details }: { details: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 border-t border-border pt-4 text-sm">
      {details.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function QuietSheetFrame({
  title,
  subtitle,
  headerEnd,
  footer,
  children,
}: {
  title: string
  // Optional: a switch in the header already says whether the thing is on.
  subtitle?: string
  headerEnd?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      {/* The sheet's own close control sits in the top-right corner, so the header leaves it room. */}
      <SheetHeader className="flex-row items-start justify-between gap-3 pr-12">
        <div className="min-w-0 space-y-1">
          <SheetTitle className="break-words font-display text-xl">{title}</SheetTitle>
          {/* Radix wants a description; with nothing to add it stays for screen readers only. */}
          <SheetDescription className={subtitle ? undefined : 'sr-only'}>{subtitle ?? title}</SheetDescription>
        </div>
        {headerEnd}
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">{children}</div>
      {footer ? <SheetFooter className="flex-row items-center gap-2 border-t border-border">{footer}</SheetFooter> : null}
    </>
  )
}

export function QuietDetailSheet<Target>({
  target,
  onClose,
  returnFocus,
  children,
}: {
  target: Target | null
  onClose: () => void
  // Where the keyboard goes when the sheet is dismissed: the row that opened it.
  returnFocus: (shown: Target) => void
  children: (shown: Target) => ReactNode
}) {
  // The sheet slides out after `target` clears. Keeping the last target mounted lets it leave with
  // its content instead of emptying first.
  const [lastTarget, setLastTarget] = useState(target)
  if (target && target !== lastTarget) setLastTarget(target)
  const shown = target ?? lastTarget
  // The sheet has no trigger to hand focus back to, so a dismissal returns it to the row that
  // opened the sheet. Closing to open an editor leaves focus alone: the editor owns it then.
  const wasDismissed = useRef(false)

  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (open) return
        wasDismissed.current = true
        onClose()
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (wasDismissed.current && shown) returnFocus(shown)
          wasDismissed.current = false
        }}
      >
        {shown ? children(shown) : null}
      </SheetContent>
    </Sheet>
  )
}
