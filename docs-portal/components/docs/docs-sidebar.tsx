'use client'

import { Search } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useId, useState } from 'react'

import { filterGroups, useDocsNav, type NavGroup } from '@/components/docs/docs-nav'
import { Input } from '@radioso/ui/input'
import { cn } from '@radioso/ui/utils'

export function DocsNavTree({
  groups,
  onNavigate,
}: {
  groups: NavGroup[]
  onNavigate?: () => void
}) {
  const pathname = usePathname()

  if (groups.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-sidebar-foreground/60" role="status">
        No pages match your search.
      </p>
    )
  }

  return (
    <>
      {groups.map((group) => (
        <div key={group.key} className="mb-5">
          {group.title ? (
            <div className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/55">
              {group.title}
            </div>
          ) : null}
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    {...(item.external ? { target: '_blank', rel: 'noreferrer' } : null)}
                    className={cn(
                      'relative block rounded-md px-3 py-1.5 text-sm transition-colors',
                      'before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:transition-transform before:content-[""]',
                      active
                        ? 'bg-primary/10 font-medium text-primary before:scale-y-100'
                        : 'text-sidebar-foreground/75 before:scale-y-0 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </>
  )
}

export function DocsNavSearch({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  const id = useId()

  return (
    <div className={cn('relative', className)}>
      <label htmlFor={id} className="sr-only">
        Search documentation
      </label>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground/50"
      />
      <Input
        id={id}
        type="search"
        placeholder="Search docs"
        value={value}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        className="h-9 bg-background/60 pl-9 text-sm"
      />
    </div>
  )
}

export function DocsSidebar() {
  const [searchQuery, setSearchQuery] = useState('')
  const nav = useDocsNav()
  const groups = filterGroups(nav?.groups ?? [], searchQuery)

  return (
    <aside
      aria-label="Documentation"
      className="docs-subtle-scrollbar sticky top-0 hidden h-screen w-72 shrink-0 overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground xl:block"
    >
      <div className="px-5 pb-4 pt-6">
        <DocsNavSearch value={searchQuery} onChange={setSearchQuery} />
      </div>
      <nav aria-label="Documentation pages" className="px-3 pb-12">
        <DocsNavTree groups={groups} />
      </nav>
    </aside>
  )
}
