'use client'

import { Github, Menu, Moon, Sun, X } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'

import { mobileDiscoveryLinks } from '@/components/docs/docs-navigation'
import { Button } from '@/components/ui/button'
import { site } from '@/lib/site'

export function DocsHeader({
  mobileNavOpen,
  onMobileNavToggle,
}: {
  mobileNavOpen: boolean
  onMobileNavToggle: () => void
}) {
  const { resolvedTheme, setTheme } = useTheme()
  const pathname = usePathname()

  const navItems = [
    { href: '/', label: 'Home' },
    { href: '/quickstarts', label: 'Quickstarts' },
    { href: '/guides', label: 'Guides' },
    { href: '/api', label: 'API' },
    { href: '/architecture', label: 'Architecture' },
  ]

  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-background/90 backdrop-blur">
      <div className="flex min-h-16 items-center justify-between gap-4 px-4 md:px-6 xl:px-8">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={onMobileNavToggle}
            className="h-10 w-10 rounded-xl xl:hidden"
            aria-expanded={mobileNavOpen}
            aria-controls="docs-mobile-navigation"
            aria-label={mobileNavOpen ? 'Close docs navigation' : 'Open docs navigation'}
          >
            {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
          <nav className="hidden items-center gap-2 xl:flex">
            {navItems.map((item) => {
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : item.href === '/api'
                    ? pathname === '/api' || pathname.startsWith('/api/') || pathname === '/api-reference'
                    : item.href === '/quickstarts'
                      ? pathname === '/quickstarts' || pathname.startsWith('/quickstarts/')
                      : item.href === '/guides'
                        ? pathname === '/guides' || pathname.startsWith('/guides/')
                        : pathname === item.href || pathname.startsWith(`${item.href}/`)

              return (
                <Link
                  key={item.href}
                  className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-foreground/70 hover:bg-secondary/60 hover:text-foreground'
                  }`}
                  href={item.href}
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon" className="hidden h-9 w-9 text-muted-foreground hover:text-foreground sm:inline-flex">
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
      </div>
      <div className="flex gap-2 overflow-x-auto px-4 pb-3 xl:hidden [&::-webkit-scrollbar]:hidden">
        {mobileDiscoveryLinks.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <Link
              key={item.href}
              href={item.href}
              className={active
                ? 'shrink-0 rounded-full bg-secondary px-3 py-1.5 text-sm font-medium text-secondary-foreground'
                : 'shrink-0 rounded-full border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground/75 transition-colors hover:text-foreground'}
            >
              {item.title}
            </Link>
          )
        })}
      </div>
    </header>
  )
}
