'use client'

import type { ReactNode } from 'react'
import { ArrowDownRight, CheckCircle2 } from 'lucide-react'

import { type DashboardRouteState, buildDashboardHref } from '@/lib/dashboard-routes'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { SettingsTabDescriptor } from '@/components/dashboard/settings/settings-tab-metadata'

export function SettingsTabShell({
  accountId,
  routeState,
  descriptor,
  children,
  footer,
  onNavigate,
}: {
  accountId: string
  routeState: DashboardRouteState
  descriptor: SettingsTabDescriptor
  children: ReactNode
  footer?: ReactNode
  onNavigate: (href: string) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 xl:flex-row xl:items-start">
        <aside className="hidden xl:block xl:sticky xl:top-6 xl:w-72 xl:flex-none">
          <div className="overflow-hidden rounded-2xl border border-border bg-card/95 shadow-sm">
            <div className="border-b border-border bg-gradient-to-br from-primary/12 via-primary/5 to-transparent px-5 py-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
                {descriptor.id}
              </p>
              <h2 className="mt-2 text-xl font-semibold text-foreground">{descriptor.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{descriptor.summary}</p>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                <ArrowDownRight className="h-4 w-4" />
                On this page
              </div>
              <div className="space-y-2">
                {descriptor.sections.map((section) => {
                  const href = buildDashboardHref(accountId, {
                    ...routeState,
                    section: 'settings',
                    settingsTab: descriptor.id,
                    settingsAnchor: section.id,
                  })
                  const isActive = routeState.settingsAnchor === section.id

                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => onNavigate(href)}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
                        isActive
                          ? 'border-primary/50 bg-primary/10'
                          : 'border-border bg-background/70 hover:border-primary/30 hover:bg-muted/40'
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-6 w-6 items-center justify-center rounded-full border',
                          isActive
                            ? 'border-primary/40 bg-primary/15 text-primary'
                            : 'border-border bg-background text-muted-foreground'
                        )}
                      >
                        {isActive ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="text-[10px] font-semibold">{descriptor.sections.indexOf(section) + 1}</span>}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">{section.label}</span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {section.summary}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1 space-y-6">
          {children}
          {footer ? (
            <div className="sticky bottom-4 z-10">
              <div className="rounded-2xl border border-border/80 bg-card/95 p-3 shadow-lg backdrop-blur">
                {footer}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
