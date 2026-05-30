'use client'

import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function DashboardPaginatedContent({
  as: Component = 'div',
  children,
  className,
  isRefreshing,
  ...props
}: {
  as?: 'div' | 'section'
  children: ReactNode
  className?: string
  isRefreshing: boolean
} & Omit<ComponentPropsWithoutRef<'div'>, 'className' | 'children' | 'aria-busy'>) {
  return (
    <Component
      {...props}
      className={cn(className, 'transition-opacity', isRefreshing && 'opacity-60')}
      aria-busy={isRefreshing}
    >
      {children}
    </Component>
  )
}
