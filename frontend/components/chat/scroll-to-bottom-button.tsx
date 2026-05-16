'use client'

import { ChevronDown } from 'lucide-react'

import type { WebsiteEmbedTheme } from '@/lib/embed-widget'
import { cn } from '@/lib/utils'

export function ScrollToBottomButton({
  onClick,
  label = 'Scroll to latest message',
  theme,
  className,
}: {
  onClick: () => void
  label?: string
  theme?: WebsiteEmbedTheme | null
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-full border bg-background text-foreground shadow-md transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      style={
        theme
          ? {
              background: theme.panelBackground,
              borderColor: theme.panelBorder,
              color: theme.panelForeground,
            }
          : undefined
      }
    >
      <ChevronDown className="h-4 w-4" />
    </button>
  )
}
