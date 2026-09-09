'use client'

import Link from 'next/link'
import { useEffect, useRef, type KeyboardEvent } from 'react'

import { cn } from '@/lib/utils'

export type AgentCockpitTab = 'chat' | 'profile' | 'directives' | 'routines' | 'skills' | 'context-variables'

const TABS: Array<{ id: AgentCockpitTab; label: string }> = [
  { id: 'chat', label: 'Test Chat' },
  { id: 'profile', label: 'Profile' },
  { id: 'directives', label: 'Directives' },
  { id: 'routines', label: 'Routines' },
  { id: 'skills', label: 'Skills' },
  { id: 'context-variables', label: 'Context' },
]

/**
 * Routed agent navigation. Links intentionally retain browser navigation and URL
 * ownership so unsaved-editor protections remain in the existing section hosts.
 */
export function AgentCockpitNav({
  activeTab,
  hrefForTab,
}: {
  activeTab: AgentCockpitTab | null
  hrefForTab: (tab: AgentCockpitTab) => string
}) {
  const activeTabRef = useRef<HTMLAnchorElement | null>(null)

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeTab])

  const moveFocus = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = Array.from(event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLAnchorElement>('[role="tab"]') ?? [])
    const index = tabs.indexOf(event.currentTarget)
    if (index < 0) return
    event.preventDefault()
    const target = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs.at(-1)
      : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }

  return (
    <nav aria-label="Agent cockpit" className="relative -mx-1 overflow-hidden">
      <div role="tablist" className="flex snap-x snap-mandatory overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((tab) => {
          const active = tab.id === activeTab
          return (
            <Link
              key={tab.id}
              href={hrefForTab(tab.id)}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              ref={active ? activeTabRef : undefined}
              onKeyDown={moveFocus}
              className={cn(
                'snap-start whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                active && 'bg-muted text-foreground',
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent sm:hidden" />
    </nav>
  )
}
