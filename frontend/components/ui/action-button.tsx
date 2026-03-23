import * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ActionButton({
  className,
  theme = 'default',
  ...props
}: React.ComponentProps<typeof Button> & {
  theme?: 'default' | 'yellow'
}) {
  return (
    <Button
      className={cn(
        theme === 'yellow'
          ? 'border-0 bg-amber-300 text-slate-950 hover:bg-amber-200'
          : '',
        className,
      )}
      {...props}
    />
  )
}
