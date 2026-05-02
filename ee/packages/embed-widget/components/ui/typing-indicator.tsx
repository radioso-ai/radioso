'use client'

import { cn } from '../../lib/utils'

function TypingIndicator({ className }: { className?: string }) {
  return (
    <div
      aria-label="Assistant is typing"
      className={cn('inline-flex min-h-8 items-center gap-1 px-1 py-2', className)}
      role="status"
    >
      <span className="h-2 w-2 animate-[typing-bounce_1.2s_infinite] rounded-full bg-muted-foreground/70 [animation-delay:0ms]" />
      <span className="h-2 w-2 animate-[typing-bounce_1.2s_infinite] rounded-full bg-muted-foreground/70 [animation-delay:150ms]" />
      <span className="h-2 w-2 animate-[typing-bounce_1.2s_infinite] rounded-full bg-muted-foreground/70 [animation-delay:300ms]" />
    </div>
  )
}

export { TypingIndicator }
