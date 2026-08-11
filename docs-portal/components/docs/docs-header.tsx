'use client'

import { Github, Menu, Moon, Sun } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useCallback, useState } from 'react'

import { DocsMobileNav, MOBILE_NAV_ID } from '@/components/docs/docs-mobile-nav'
import { externalLinks } from '@/components/docs/site-links'
import { Button } from '@radioso/ui/button'
import { cn } from '@radioso/ui/utils'

const topLevelLinks = [
  {
    href: '/why-radioso',
    label: 'Why Radioso',
    match: (p: string) => p === '/why-radioso' || p.startsWith('/why-radioso/'),
  },
  {
    href: '/quickstarts/run-locally',
    label: 'Guides',
    match: (p: string) =>
      p.startsWith('/quickstarts/') ||
      p.startsWith('/guides/') ||
      p.startsWith('/sdk/') ||
      p.startsWith('/operators/'),
  },
  {
    href: '/api',
    label: 'API',
    match: (p: string) => p === '/api' || p.startsWith('/api/') || p === '/api-reference',
  },
  {
    href: '/architecture',
    label: 'Architecture',
    match: (p: string) => p === '/architecture' || p.startsWith('/architecture/'),
  },
]

export function DocsHeader() {
  const { resolvedTheme, setTheme } = useTheme()
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  return (
    <>
      <div className="sticky top-0 z-40 px-3 pb-2 pt-3 sm:px-5 sm:pt-4">
        {/* Fades the page out behind the floating pill so scrolled content does
            not show through the inset gap above it. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full bg-gradient-to-b from-background via-background/85 to-transparent"
        />
        <header className="mx-auto flex h-14 items-center justify-between gap-2 rounded-2xl border border-border/70 bg-card/85 px-2.5 shadow-[0_1px_2px_rgba(20,35,23,0.04),0_8px_24px_-12px_rgba(20,35,23,0.18)] backdrop-blur-xl sm:px-4">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Open navigation menu"
            aria-expanded={menuOpen}
            aria-controls={MOBILE_NAV_ID}
            className="h-9 w-9 text-muted-foreground hover:text-foreground xl:hidden"
          >
            <Menu className="h-4.5 w-4.5" aria-hidden="true" />
          </Button>

          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-md px-1 py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
              <Image
                src="/radioso-icon.svg"
                alt=""
                width={20}
                height={20}
                priority
                className="h-5 w-5"
              />
            </span>
            <span className="font-display hidden text-sm font-semibold tracking-tight sm:inline">
              Radioso Docs
            </span>
            <span className="sr-only sm:hidden">Radioso Docs home</span>
          </Link>

          <nav aria-label="Documentation sections" className="ml-2 hidden items-center gap-1 lg:flex">
            {topLevelLinks.map((item) => {
              const active = item.match(pathname)

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="hidden h-9 w-9 text-muted-foreground hover:text-foreground sm:inline-flex"
          >
            <a href={externalLinks.github} target="_blank" rel="noreferrer" aria-label="Radioso on GitHub">
              <Github className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle dark mode"
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" aria-hidden="true" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" aria-hidden="true" />
          </Button>
          <Button asChild size="sm" className="rounded-full px-4">
            <a href={externalLinks.app}>Open app</a>
          </Button>
        </div>
        </header>
      </div>

      <DocsMobileNav open={menuOpen} onClose={closeMenu} topLevelLinks={topLevelLinks} />
    </>
  )
}
