import type { ReactNode } from 'react'

import { TypingIndicator } from '@/components/ui/typing-indicator'
import { relativeTimestamp } from '@/lib/relative-time'
import { cn } from '@/lib/utils'

export function ChatTurn({
  role,
  avatar,
  name,
  timestamp,
  streaming = false,
  userVariant = 'bubble',
  messageId,
  children,
  footer,
  className,
}: {
  role: 'user' | 'assistant'
  avatar?: ReactNode
  name?: string
  timestamp?: string
  streaming?: boolean
  userVariant?: 'bubble' | 'quiet'
  /** Rendered as `data-message-id`; lets scroll managers locate this turn. */
  messageId?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
}) {
  const bodyIsEmpty = children === null || children === undefined || (typeof children === 'string' && children.trim().length === 0)
  const body = streaming && bodyIsEmpty ? <TypingIndicator /> : children

  if (role === 'user') {
    return (
      <article data-message-id={messageId} className={cn('ml-auto animate-in fade-in slide-in-from-bottom-1 duration-200', userVariant === 'quiet' ? 'max-w-[70%]' : 'max-w-[85%]', className)}>
        <div className={cn(
          'rounded-2xl',
          userVariant === 'quiet' ? 'bg-muted px-3.5 py-2.5 text-foreground' : 'bg-primary px-4 py-3 text-primary-foreground',
        )}>
          {name || timestamp ? (
            <div className={cn('mb-1 flex items-center justify-end gap-2 text-xs', userVariant === 'quiet' ? 'text-muted-foreground' : 'text-primary-foreground/70')}>
              {name ? <span>{name}</span> : null}
              {timestamp ? <time dateTime={timestamp} title={timestamp}>{relativeTimestamp(timestamp)}</time> : null}
            </div>
          ) : null}
          <div className="whitespace-pre-wrap text-sm">{body}</div>
        </div>
        {footer ? <div className="mt-2">{footer}</div> : null}
      </article>
    )
  }

  return (
    <article data-message-id={messageId} className={cn('mr-auto flex max-w-[95%] animate-in fade-in slide-in-from-bottom-1 duration-200 items-start gap-3', className)}>
      {avatar ? <div className="shrink-0">{avatar}</div> : null}
      <div className="min-w-0 flex-1">
        {name || timestamp ? (
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            {name ? <span className="font-medium text-foreground">{name}</span> : null}
            {timestamp ? <time dateTime={timestamp} title={timestamp}>{relativeTimestamp(timestamp)}</time> : null}
          </div>
        ) : null}
        <div className="text-sm text-foreground">{body}</div>
        {footer ? <div className="mt-2">{footer}</div> : null}
      </div>
    </article>
  )
}
