'use client'

import type { ReactNode } from 'react'

export function SettingsCard({
  id,
  icon,
  title,
  description,
  children,
}: {
  id?: string
  icon: ReactNode
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section id={id} className="rounded-lg border border-border bg-card p-4 space-y-4 scroll-mt-24">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          {icon}
        </div>
        <div>
          <h3 className="font-medium text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}
