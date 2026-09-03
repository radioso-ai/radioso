'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function CodeSnippet({
  label,
  code,
  wrap = false,
}: {
  label: string
  code: string
  wrap?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <div className="relative">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="absolute right-2 top-2 z-10 h-7 w-7 bg-background/90"
          onClick={() => void handleCopy()}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="sr-only">Copy {label.toLowerCase()} instruction</span>
        </Button>
        <code
          className={cn(
            'block max-h-[420px] overflow-auto rounded-md border border-border bg-muted/40 p-4 pr-12 font-mono text-sm leading-6 text-foreground',
            wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
          )}
        >
          {code}
        </code>
      </div>
    </section>
  )
}
