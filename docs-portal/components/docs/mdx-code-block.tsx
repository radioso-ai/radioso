'use client'

import { Check, Copy } from 'lucide-react'
import { createContext, useContext, useRef, useState, type ComponentProps } from 'react'

import { Button } from '@radioso/ui/button'
import { cn } from '@radioso/ui/utils'

const InsidePreContext = createContext(false)

const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'bash',
  sh: 'shell',
  shell: 'shell',
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  http: 'http',
  mdx: 'mdx',
  md: 'markdown',
}

function readCode(pre: HTMLElement | null): string {
  if (!pre) return ''

  const lines = pre.querySelectorAll('[data-line]')
  if (lines.length > 0) {
    return Array.from(lines)
      .map((line) => line.textContent ?? '')
      .join('\n')
  }

  return pre.textContent ?? ''
}

/**
 * MDX `pre` override. Every fenced block in every MDX page renders in the
 * branded surface with a copy button, instead of the unstyled default.
 */
export function MdxCodeBlock({ children, className, ...props }: ComponentProps<'pre'>) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const language = (props as Record<string, unknown>)['data-language']
  const filename = (props as Record<string, unknown>)['data-filename']
  const label =
    typeof language === 'string' ? (LANGUAGE_LABELS[language] ?? language) : undefined

  const handleCopy = async () => {
    const code = readCode(preRef.current)
    if (!code) return

    try {
      await navigator.clipboard.writeText(code)
    } catch {
      return
    }

    setCopied(true)
    if (resetRef.current) clearTimeout(resetRef.current)
    resetRef.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-card shadow-sm not-first:mt-6">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {label ? (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
              {label}
            </span>
          ) : null}
          {typeof filename === 'string' && filename ? (
            <span className="truncate font-mono text-xs text-muted-foreground">{filename}</span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleCopy}
          aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
          className={cn(
            // Always rendered rather than hover-only: there is no hover on
            // touch, and a quickstart whose first instruction is "paste this"
            // cannot hide its copy affordance behind a pointer.
            'shrink-0 text-muted-foreground opacity-60 transition-opacity hover:text-foreground',
            'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
          )}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <pre
          ref={preRef}
          tabIndex={0}
          className={cn('py-4 text-[13px] leading-relaxed outline-none', className)}
          {...props}
        >
          <InsidePreContext.Provider value={true}>{children}</InsidePreContext.Provider>
        </pre>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  )
}

/**
 * MDX `code` override. Inside a fenced block the highlighter owns the styling;
 * standalone inline code gets the branded chip treatment.
 */
export function MdxInlineCode({ className, children, ...props }: ComponentProps<'code'>) {
  const insidePre = useContext(InsidePreContext)

  if (insidePre) {
    return (
      <code className={cn('nextra-code', className)} dir="ltr" {...props}>
        {children}
      </code>
    )
  }

  return (
    <code
      className={cn(
        'rounded border border-border/70 bg-muted px-[0.35em] py-[0.15em] font-mono text-[0.875em] text-foreground',
        className,
      )}
      dir="ltr"
      {...props}
    >
      {children}
    </code>
  )
}
