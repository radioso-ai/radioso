'use client'

import type { ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'

import { AssistantMarkdownContent } from '@/components/dashboard/chat-markdown'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

export function PipelineConnector({ className }: { className?: string }) {
  return (
    <div className={cn('relative -my-1 flex h-12 items-center justify-center', className)}>
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary/45" />
      <div className="relative flex items-center justify-center">
        <div className="absolute h-px w-24 bg-primary/35" />
        <div className="relative h-4 w-4 rounded-full border border-blue-200/80 bg-blue-400 shadow-[0_0_18px_rgba(96,165,250,0.85)]" />
      </div>
    </div>
  )
}

export function SettingTooltip({
  label,
  content,
}: {
  label: string
  content: string | ReactNode
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Explain ${label}`}
        >
          <CircleHelp className="h-4 w-4" />
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 border-l sm:max-w-xl">
        <SheetHeader className="border-b border-border px-6 py-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
            Settings Guide
          </p>
          <SheetTitle className="text-xl">{label}</SheetTitle>
          <SheetDescription>
            A plain-language explanation of what this control changes, how it behaves in the pipeline, and what tradeoffs to expect when you tune it.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="prose prose-sm max-w-none dark:prose-invert prose-p:leading-7 prose-li:leading-7">
            {typeof content === 'string' ? <AssistantMarkdownContent content={content} /> : content}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function SettingFieldHeader({
  label,
  tooltip,
  description,
  htmlFor,
  className,
}: {
  label: string
  tooltip: string | ReactNode
  description?: string
  htmlFor?: string
  className?: string
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={htmlFor} className="text-foreground">
          {label}
        </Label>
        <SettingTooltip label={label} content={tooltip} />
      </div>
      {description ? (
        <div className="text-sm text-muted-foreground">
          <AssistantMarkdownContent content={description} inline />
        </div>
      ) : null}
    </div>
  )
}
