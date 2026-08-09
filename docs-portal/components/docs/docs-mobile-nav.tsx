'use client'

import { X } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { filterGroups, useDocsNav } from '@/components/docs/docs-nav'
import { DocsNavSearch, DocsNavTree } from '@/components/docs/docs-sidebar'
import { externalLinks } from '@/components/docs/site-links'
import { Button } from '@radioso/ui/button'
import { cn } from '@radioso/ui/utils'

export const MOBILE_NAV_ID = 'docs-mobile-nav'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type TopLevelLink = { href: string; label: string; match: (pathname: string) => boolean }

export function DocsMobileNav({
  open,
  onClose,
  topLevelLinks,
}: {
  open: boolean
  onClose: () => void
  topLevelLinks: TopLevelLink[]
}) {
  const pathname = usePathname()
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const nav = useDocsNav()
  const groups = filterGroups(nav?.groups ?? [], searchQuery)

  // Close on navigation so a link tap does not leave the drawer covering the page.
  useEffect(() => {
    onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- route change only
  }, [pathname])

  useEffect(() => {
    if (!open) return

    restoreFocusRef.current = document.activeElement as HTMLElement | null

    const { body } = document
    const previousOverflow = body.style.overflow
    body.style.overflow = 'hidden'

    const panel = panelRef.current
    panel?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab' || !panel) return

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 xl:hidden">
      <button
        type="button"
        aria-label="Close navigation"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-foreground/40 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        id={MOBILE_NAV_ID}
        role="dialog"
        aria-modal="true"
        aria-label="Documentation navigation"
        tabIndex={-1}
        className={cn(
          'absolute inset-y-0 left-0 flex h-full w-[min(20rem,88vw)] flex-col',
          'border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-2xl outline-none',
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-sidebar-border px-4 py-3">
          <span className="font-display text-sm font-semibold">Radioso Docs</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close navigation"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="px-4 py-3">
          <DocsNavSearch value={searchQuery} onChange={setSearchQuery} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-8">
          <nav aria-label="Sections" className="mb-5 border-b border-sidebar-border pb-4">
            <ul className="space-y-0.5">
              {topLevelLinks.map((item) => {
                const active = item.match(pathname)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'block rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        active
                          ? 'bg-primary/10 text-primary'
                          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>

          <nav aria-label="Documentation pages">
            <DocsNavTree groups={groups} onNavigate={onClose} />
          </nav>
        </div>

        <div className="border-t border-sidebar-border p-4">
          <Button asChild className="w-full">
            <a href={externalLinks.app}>Open app</a>
          </Button>
        </div>
      </div>
    </div>
  )
}
