'use client'

import { ChevronRight } from 'lucide-react'
import Link from 'next/link'

import { useDocsNav } from '@/components/docs/docs-nav'

export function DocsBreadcrumbs() {
  const nav = useDocsNav()
  const crumbs = nav?.breadcrumbs ?? []

  if (crumbs.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className="mb-6">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <li className="flex items-center gap-1">
          <Link href="/" className="rounded transition-colors hover:text-foreground">
            Docs
          </Link>
        </li>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1

          return (
            <li key={`${crumb.href}-${index}`} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
              {isLast ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {crumb.title}
                </span>
              ) : (
                <Link href={crumb.href} className="rounded transition-colors hover:text-foreground">
                  {crumb.title}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
