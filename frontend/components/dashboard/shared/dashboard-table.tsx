'use client'

import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function DashboardTable({
  children,
  minWidth = 'min-w-[760px]',
  className,
  ...tableProps
}: {
  children: ReactNode
  minWidth?: string
  className?: string
} & Omit<ComponentPropsWithoutRef<'table'>, 'className'>) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <div className="overflow-x-auto">
        <table {...tableProps} className={cn('w-full table-fixed border-collapse', minWidth)}>
          {children}
        </table>
      </div>
    </div>
  )
}

export function DashboardTableHead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-border bg-muted/30">{children}</tr>
    </thead>
  )
}

export function DashboardTableHeader({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-2.5 text-left text-xs font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function DashboardTableBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>
}

export function DashboardTableRow({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <tr className={cn('border-b border-border last:border-b-0 hover:bg-accent/20', className)}>
      {children}
    </tr>
  )
}

export function DashboardTableCell({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <td className={cn('px-4 py-3 align-middle text-sm text-foreground', className)}>{children}</td>
}
