'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface CodeBlockProps {
  code: string
  language: string
  filename?: string
  showLineNumbers?: boolean
}

const languageColors: Record<string, string> = {
  bash: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
  curl: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  javascript: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  json: 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
  typescript: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
}

export function CodeBlock({ code, language, filename, showLineNumbers = true }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const lines = code.trim().split('\n')

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn('rounded px-2 py-0.5 text-xs font-medium', languageColors[language] || 'bg-muted text-muted-foreground')}>
            {language}
          </span>
          {filename ? <span className="font-mono text-xs text-muted-foreground">{filename}</span> : null}
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100" onClick={handleCopy}>
          {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <pre className="p-5 text-sm font-mono">
          <code>
            {lines.map((line, i) => (
              <div key={i} className="table-row">
                {showLineNumbers ? <span className="table-cell pr-4 text-right text-muted-foreground/50 select-none">{i + 1}</span> : null}
                <span className="table-cell text-foreground">{line || ' '}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}
