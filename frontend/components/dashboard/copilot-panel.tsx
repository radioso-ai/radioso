'use client'

import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'

import { AssistantAvatar } from '@/components/chat/public-chat-bubble-view'
import { Button } from '@/components/ui/button'
import { useCopilotContext } from '@/lib/copilot-context'
import type { CopilotAvailability } from '@/lib/api-copilot'
import type { DashboardRouteState } from '@/lib/dashboard-routes'
import { RAY_AVATAR_URL, RAY_NAME } from '@/lib/ray'
import { CopilotChatSurface } from './copilot-chat-surface'

// The primary Ray affordance: a tab flush against the bottom-right viewport edge.
// It is unmounted (not hidden) while the panel is open, so it never sits over the
// panel or swallows clicks — the open panel carries its own close affordance.
export function AskRayTag() {
  const { panelOpen, openPanel } = useCopilotContext()
  if (panelOpen) return null
  return (
    <button
      type="button"
      data-testid="ask-ray-tag"
      aria-label="Ask Ray"
      onClick={() => openPanel()}
      className="fixed bottom-0 right-5 z-40 flex items-center gap-1.5 rounded-t-lg border border-b-0 border-border bg-sidebar px-3 py-1.5 text-sm text-foreground shadow-sm transition-[transform,background-color] hover:-translate-y-0.5 hover:bg-sidebar-accent"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={RAY_AVATAR_URL} alt="" aria-hidden="true" className="size-4 shrink-0 rounded-sm" />
      {RAY_NAME}
      <kbd className="hidden shrink-0 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground sm:inline">⌘J</kbd>
    </button>
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

  // Escape still closes Ray. The panel is docked (not a modal sheet), so it never
  // traps focus or covers content — the dashboard stays interactive beside it.
  useEffect(() => {
    if (!panelOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [panelOpen, closePanel])

  // Rendered only while open so the chat surface (and its data fetches) mount lazily.
  if (!panelOpen) return null

  return (
    <aside
      data-copilot-panel
      aria-label={RAY_NAME}
      className="flex h-svh w-full min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-background md:w-[min(32rem,40vw)]"
    >
      <div className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
        {/* Avatar is decorative here — the visible "Ray" text names the heading. */}
        <h2 className="flex items-center gap-2 text-sm font-semibold"><AssistantAvatar avatarUrl={RAY_AVATAR_URL} label="" className="size-6" />{RAY_NAME}</h2>
        <div className="flex items-center gap-1">
          <div ref={setPanelHeaderSlot} />
          <Button type="button" variant="ghost" size="icon" onClick={closePanel} aria-label="Close Ray">
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      <CopilotChatSurface accountId={accountId} routeState={routeState} initialAvailability={availability} mode="panel" panelHeaderSlot={panelHeaderSlot} />
    </aside>
  )
}
