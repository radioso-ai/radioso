'use client'

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function DashboardPage({
  title,
  description,
  titleAccessory,
  headerContent,
  actions,
  children,
  footer,
  className,
  headerClassName,
  contentClassName,
  actionsClassName,
  footerClassName,
  contentScroll = true,
}: {
  title: ReactNode
  description?: ReactNode
  titleAccessory?: ReactNode
  headerContent?: ReactNode
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  headerClassName?: string
  contentClassName?: string
  actionsClassName?: string
  footerClassName?: string
  contentScroll?: boolean
}) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}>
      <div className="sticky top-0 z-20 shrink-0 border-b border-border bg-background/95 px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className={cn('flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between', headerClassName)}>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <div className="flex min-w-0 items-center gap-3">
                <h1 className="text-lg font-medium text-foreground">{title}</h1>
                {titleAccessory}
              </div>
              {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
            </div>
            {headerContent}
          </div>
          {actions ? (
            <div className={cn('flex items-center gap-2 xl:ml-auto xl:shrink-0', actionsClassName)}>
              {actions}
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          'min-h-0 flex-1',
          contentScroll ? 'overflow-y-auto' : 'overflow-hidden',
          contentClassName ?? 'p-6',
        )}
      >
        {children}
      </div>

      {footer ? (
        <div className={cn('z-20 shrink-0 border-t border-border bg-background p-4', footerClassName)}>
          {footer}
        </div>
      ) : null}
    </div>
  )
}
