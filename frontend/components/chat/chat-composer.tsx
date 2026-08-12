'use client'

import { type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/**
 * Generic chat composer: a unified input "pill" (textarea + send button) that
 * mirrors the public-chat composer's balanced layout without its embed theming.
 * The textarea's own border/background are stripped so it blends into the pill,
 * and its min-height matches the send button so they line up. Autosize comes
 * from the base Textarea's `field-sizing-content`.
 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  ariaLabel = 'Message',
  disabled = false,
  maxLength,
  hint,
  autoFocus,
  className,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  maxLength?: number
  hint?: ReactNode
  autoFocus?: boolean
  className?: string
}) {
  const canSubmit = !disabled && value.trim().length > 0

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (canSubmit) onSubmit()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (canSubmit) onSubmit()
    }
  }

  return (
    <form onSubmit={submit} className={cn('space-y-2', className)}>
      <div className="flex items-end gap-1.5 rounded-2xl border border-input bg-background px-2 py-1.5 transition-shadow focus-within:ring-2 focus-within:ring-secondary/40 focus-within:ring-offset-0">
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled}
          maxLength={maxLength}
          autoFocus={autoFocus}
          className="min-h-9 max-h-40 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button type="submit" size="icon" aria-label="Send question" disabled={!canSubmit} className="size-9 shrink-0 rounded-full transition-colors">
          <Send className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {hint || maxLength !== undefined ? (
        <div className="flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
          <span>{hint}</span>
          {maxLength !== undefined ? <span>{value.length}/{maxLength}</span> : null}
        </div>
      ) : null}
    </form>
  )
}
