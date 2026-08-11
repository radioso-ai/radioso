'use client'

import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useCopilotContext } from '@/lib/copilot-context'
import type { CopilotAvailability } from '@/lib/api-copilot'
import type { DashboardRouteState } from '@/lib/dashboard-routes'
import { CopilotChatSurface } from './copilot-chat-surface'

export function CopilotLauncher() {
  const { openPanel, panelOpen } = useCopilotContext()
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => openPanel()} aria-label="Open Copilot" aria-expanded={panelOpen}>
      <Sparkles className="mr-2 h-4 w-4" aria-hidden />
      Copilot
      <kbd className="ml-2 hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">⌘J</kbd>
    </Button>
  )
}

export function CopilotSelectionAffordance() {
  const { selectionPrompt, openPanel, dismissSelectionPrompt } = useCopilotContext()
  if (!selectionPrompt) return null
  return (
    <div className="fixed z-[60]" style={{ top: selectionPrompt.top, left: selectionPrompt.left }}>
      <Button
        type="button"
        size="sm"
        className="h-8 shadow-md"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => openPanel(selectionPrompt.text)}
      >
        <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        Ask Copilot
      </Button>
      <button type="button" className="sr-only" onClick={dismissSelectionPrompt}>Dismiss selection prompt</button>
    </div>
  )
}

export function CopilotPanel({
  accountId,
  routeState,
  availability,
}: {
  accountId: string
  routeState: DashboardRouteState
  availability: CopilotAvailability | null
}) {
  const { panelOpen, closePanel } = useCopilotContext()
  return (
    <Sheet open={panelOpen} onOpenChange={(open) => { if (!open) closePanel() }}>
      <SheetContent side="right" className="w-full max-w-none gap-0 overflow-hidden p-0 sm:max-w-3xl" data-copilot-panel>
        <SheetHeader className="border-b border-border px-6 py-4">
          <SheetTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-secondary" aria-hidden />Copilot</SheetTitle>
          <SheetDescription>Ask about the dashboard context you are viewing. Press Escape to close.</SheetDescription>
        </SheetHeader>
        <CopilotChatSurface accountId={accountId} routeState={routeState} initialAvailability={availability} mode="panel" />
      </SheetContent>
    </Sheet>
  )
}
