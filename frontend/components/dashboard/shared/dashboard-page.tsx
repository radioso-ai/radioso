'use client'

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function DashboardPage({
  title,
  description,
  backAction,
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
  backAction?: ReactNode
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
      <div className="sticky top-0 z-20 flex min-h-16 shrink-0 flex-col justify-center border-b border-border bg-background/95 px-6 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className={cn(backAction ? 'space-y-3' : 'space-y-4', headerClassName)}>
          {backAction ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {backAction}
              {actions ? (
                <div className={cn('flex shrink-0 flex-wrap items-center justify-end gap-2', actionsClassName)}>
                  {actions}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className={cn('flex min-w-0 flex-wrap justify-between gap-3', description ? 'items-start' : 'items-center')}>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-end gap-3">
                <h1 className="text-lg font-medium leading-none text-foreground">{title}</h1>
                {titleAccessory}
              </div>
              {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
            </div>
            {!backAction && actions ? (
              <div className={cn('flex shrink-0 flex-wrap items-center justify-end gap-2', actionsClassName)}>
                {actions}
              </div>
            ) : null}
          </div>
          {headerContent}
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
        <div className={cn('z-20 shrink-0 bg-background p-4', footerClassName)}>
          {footer}
        </div>
      ) : null}
    </div>
  )
}
