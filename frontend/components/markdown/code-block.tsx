'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { getHighlighter, resolveLanguage } from './highlighter'

export function CodeBlock({
  code,
  language,
  className,
}: {
  code: string
  language?: string
  className?: string
}) {
  const lang = resolveLanguage(language)
  const displayLang = language?.trim() || lang
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const highlighter = await getHighlighter()
        if (cancelled) return
        const rendered = highlighter.codeToHtml(code, {
          lang,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false,
        })
        if (!cancelled) {
          setHtml(rendered)
        }
      } catch {
        // Fallback to plain rendering remains.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, lang])

  useEffect(
    () => () => {
      if (copyResetTimeoutRef.current !== null) {
        clearTimeout(copyResetTimeoutRef.current)
      }
    },
    [],
  )

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) {
        clearTimeout(copyResetTimeoutRef.current)
      }
      copyResetTimeoutRef.current = setTimeout(() => {
        copyResetTimeoutRef.current = null
        setCopied(false)
      }, 1500)
    } catch {
      // Clipboard write can fail in insecure contexts; surface nothing.
    }
  }

  return (
    <div
      className={cn(
        'group relative my-3 overflow-hidden rounded-lg border border-border bg-muted/40',
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border bg-muted/60 px-3 py-1.5">
        <span className="rounded bg-background/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {displayLang}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto text-xs leading-6 [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:px-4 [&_pre]:py-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 overflow-x-auto px-4 py-3 text-xs leading-6 text-foreground">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
