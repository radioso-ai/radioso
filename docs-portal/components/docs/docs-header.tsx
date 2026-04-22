'use client'

import { Github, Moon, Sun } from 'lucide-react'
import Link from 'next/link'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'
import { site } from '@/lib/site'

export function DocsHeader() {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-border/80 bg-background/90 px-8 backdrop-blur">
      <nav className="flex items-center gap-2">
        <Link className="rounded-md px-4 py-2 text-sm font-medium text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground" href="/">
          Guides
        </Link>
        <Link className="rounded-md px-4 py-2 text-sm font-medium text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground" href="/api-reference">
          API Reference
        </Link>
        <Link className="rounded-md px-4 py-2 text-sm font-medium text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground" href="/architecture">
          Architecture
        </Link>
      </nav>
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-foreground">
          <a href="https://github.com" target="_blank" rel="noreferrer">
            <Github className="h-4 w-4" />
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          className="h-9 w-9 text-muted-foreground hover:text-foreground"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
        <Button asChild size="sm" className="gap-2 rounded-xl">
          <a href={site.appUrl}>Open app</a>
        </Button>
      </div>
    </header>
  )
}
