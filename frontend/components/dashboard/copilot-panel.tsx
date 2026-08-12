'use client'

import { useState } from 'react'
import { Sparkles } from 'lucide-react'

import { AssistantAvatar } from '@/components/chat/public-chat-bubble-view'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useCopilotContext } from '@/lib/copilot-context'
import type { CopilotAvailability } from '@/lib/api-copilot'
import type { DashboardRouteState } from '@/lib/dashboard-routes'
import { RAY_AVATAR_URL, RAY_NAME } from '@/lib/ray'
import { CopilotChatSurface } from './copilot-chat-surface'

export function CopilotLauncher() {
  const { openPanel, panelOpen } = useCopilotContext()
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => openPanel()} aria-label="Open Ray" aria-expanded={panelOpen}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={RAY_AVATAR_URL} alt="" aria-hidden="true" className="mr-2 size-5 rounded-sm" />
      {RAY_NAME}
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
        Ask Ray
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
  const [panelHeaderSlot, setPanelHeaderSlot] = useState<HTMLDivElement | null>(null)
  return (
    <Sheet open={panelOpen} onOpenChange={(open) => { if (!open) closePanel() }}>
      <SheetContent side="right" className="w-full max-w-none gap-0 overflow-hidden p-0 sm:max-w-3xl" data-copilot-panel>
        <SheetHeader className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            {/* Avatar is decorative here — the visible "Ray" text names the title (avoids a "Ray Ray" accessible name). */}
            <SheetTitle className="flex items-center gap-2"><AssistantAvatar avatarUrl={RAY_AVATAR_URL} label="" className="size-6" />{RAY_NAME}</SheetTitle>
            <div ref={setPanelHeaderSlot} />
          </div>
          <SheetDescription className="sr-only">Ask me about what you&apos;re looking at. Press Escape to close.</SheetDescription>
        </SheetHeader>
        <CopilotChatSurface accountId={accountId} routeState={routeState} initialAvailability={availability} mode="panel" panelHeaderSlot={panelHeaderSlot} />
      </SheetContent>
    </Sheet>
  )
}
