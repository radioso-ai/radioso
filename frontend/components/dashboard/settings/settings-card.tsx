'use client'

import type { ReactNode } from 'react'

export function SettingsCard({
  id,
  eyebrow,
  icon,
  title,
  description,
  children,
}: {
  id?: string
  eyebrow?: string
  icon: ReactNode
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 space-y-5 rounded-2xl border border-border bg-card/95 p-5 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
          {icon}
        </div>
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h3 className="font-medium text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}
