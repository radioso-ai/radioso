'use client'

import { useState } from 'react'

import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function CopyValueField({
  label,
  value,
  copyValue,
  ariaLabel,
  disabled = false,
  className = '',
  compact = false,
  wrap = false,
  fitContent = false,
  inlineLabel = false,
}: {
  label?: string
  value: string
  copyValue?: string
  ariaLabel: string
  disabled?: boolean
  className?: string
  compact?: boolean
  wrap?: boolean
  fitContent?: boolean
  inlineLabel?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (disabled) {
      return
    }

    await navigator.clipboard.writeText(copyValue ?? value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className={cn(
        'min-w-0',
        fitContent ? 'max-w-full' : '',
        inlineLabel ? 'flex items-start gap-3' : '',
        className,
      )}
    >
      {label ? (
        <p className={cn('text-sm font-medium text-foreground', inlineLabel ? 'pt-2 whitespace-nowrap' : 'mb-1')}>
          {label}
        </p>
      ) : null}
      <div className={cn('flex min-w-0 flex-nowrap items-start gap-2', fitContent ? 'inline-flex max-w-full' : '')}>
        <div
          aria-label={ariaLabel}
          className={cn(
            'flex min-w-0 items-center rounded-md border border-input bg-background px-3 text-foreground shadow-xs',
            fitContent ? 'w-fit max-w-full flex-none' : 'flex-1',
            compact ? 'h-10' : 'h-9',
          )}
        >
          <code
            className={cn(
              'block font-mono text-sm',
              fitContent ? 'max-w-full' : 'w-full',
              wrap
                ? 'overflow-hidden whitespace-pre-wrap break-all'
                : 'overflow-x-auto whitespace-nowrap scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent',
              compact ? 'text-base md:text-sm' : '',
            )}
          >
            {value}
          </code>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          onClick={() => void handleCopy()}
          disabled={disabled}
        >
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
          <span className="sr-only">{ariaLabel}</span>
        </Button>
      </div>
    </div>
  )
}
