'use client'

import type { ReactNode } from 'react'

export function SettingsTabShell({
  children,
  footer,
}: {
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="settings-surface min-h-0 flex-1 overflow-y-auto">
      <div className="w-full px-4 py-6 sm:px-6">
        <div className="min-w-0 space-y-6">
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
