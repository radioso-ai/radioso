'use client'

import { ArrowLeft, ArrowRight } from 'lucide-react'
import Link from 'next/link'

import { useDocsNav, type NavLink } from '@/components/docs/docs-nav'
import { cn } from '@radioso/ui/utils'

function PaginationLink({ link, direction }: { link: NavLink; direction: 'previous' | 'next' }) {
  const isNext = direction === 'next'
  const Icon = isNext ? ArrowRight : ArrowLeft

  return (
    <Link
      href={link.href}
      rel={isNext ? 'next' : 'prev'}
      className={cn(
        'group flex flex-1 flex-col gap-1 rounded-xl border border-border/70 bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5',
        isNext ? 'items-end text-right' : 'items-start text-left',
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {isNext ? null : <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
        {isNext ? 'Next' : 'Previous'}
        {isNext ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      </span>
      <span className="text-sm font-medium text-foreground group-hover:text-primary">
        {link.title}
      </span>
    </Link>
  )
}

export function DocsPagination() {
  const nav = useDocsNav()

  if (!nav) return null
  if (nav.activeThemeContext.pagination === false) return null

  const { previous, next } = nav
  if (!previous && !next) return null

  return (
    <nav
      aria-label="Pages"
      className="mt-16 flex flex-col gap-3 border-t border-border/70 pt-8 sm:flex-row"
    >
      {previous ? (
        <PaginationLink link={previous} direction="previous" />
      ) : (
        <div className="hidden flex-1 sm:block" />
      )}
      {next ? <PaginationLink link={next} direction="next" /> : <div className="hidden flex-1 sm:block" />}
    </nav>
  )
}
