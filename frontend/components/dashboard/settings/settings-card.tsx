'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function SettingsCard({
  id,
  eyebrow,
  icon,
  title,
  description,
  children,
  className,
  contentClassName,
  iconClassName,
}: {
  id?: string
  eyebrow?: string
  icon: ReactNode
  title: string
  description: string
  children: ReactNode
  className?: string
  contentClassName?: string
  iconClassName?: string
}) {
  return (
    <section
      id={id}
      className={cn(
        'scroll-mt-24 grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-3 gap-y-5 rounded-2xl border border-border bg-card/95 p-5 shadow-sm',
        className,
      )}
    >
      <div
        className={cn(
          'row-span-2 flex h-11 w-11 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10',
          iconClassName,
        )}
      >
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
      <div className={cn('min-w-0', contentClassName)}>{children}</div>
    </section>
  )
}
