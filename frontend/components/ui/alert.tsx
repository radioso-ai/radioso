import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/** Generic banner/alert chrome. No product knowledge — callers supply copy, tone, and actions. */
const alertVariants = cva(
  'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted/40 text-foreground',
        warning: 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100',
        destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      className={cn(alertVariants({ variant, className }))}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn('flex-1 text-sm leading-relaxed', className)}
      {...props}
    />
  )
}

export { Alert, AlertDescription }
