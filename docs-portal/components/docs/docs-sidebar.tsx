'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { mobileDiscoveryLinks, navigation, type NavItem } from '@/components/docs/docs-navigation'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

function NavSection({
  item,
  pathname,
  forceOpen = false,
  onNavigate,
}: {
  item: NavItem
  pathname: string
  forceOpen?: boolean
  onNavigate?: () => void
}) {
  const hasActiveChild = Boolean(item.items?.some((subItem) => subItem.href === pathname))
  const [isOpen, setIsOpen] = useState(hasActiveChild || pathname === '/')
  const Icon = item.icon

  return (
    <div className="mb-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-secondary/60 hover:text-foreground"
      >
        {Icon ? <Icon className="h-4 w-4" /> : null}
        <span className="flex-1 text-left">{item.title}</span>
        {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {(forceOpen || isOpen) && item.items ? (
        <div className="ml-4 mt-2 space-y-1 border-l border-border pl-3">
          {item.items.map((subItem) => (
            <Link
              key={subItem.href}
              href={subItem.href ?? '/'}
              onClick={onNavigate}
              className={cn(
                'block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors',
                pathname === subItem.href ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground'
              )}
            >
              {subItem.title}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function DocsSidebar({
  onSearchChange,
  searchQuery,
  className,
  mode = 'desktop',
  onNavigate,
}: {
  onSearchChange: (value: string) => void
  searchQuery: string
  className?: string
  mode?: 'desktop' | 'mobile'
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const filteredNavigation = navigation
    .map((section) => ({
      ...section,
      items: section.items?.filter((item) => item.title.toLowerCase().includes(searchQuery.toLowerCase())),
    }))
    .filter((section) => section.items && section.items.length > 0)
  const sections = searchQuery ? filteredNavigation : navigation
  const isMobile = mode === 'mobile'

  return (
    <aside
      className={cn(
        isMobile
          ? 'rounded-3xl border border-border bg-sidebar/95 shadow-sm'
          : 'sticky top-0 hidden h-screen w-80 overflow-y-auto border-r border-border bg-sidebar xl:block',
        className
      )}
    >
      <div className={cn('border-border', isMobile ? 'p-5' : 'border-b p-6')}>
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <span className="text-sm font-semibold">R</span>
          </div>
          <div>
            <div className="text-xl font-semibold text-foreground">Radioso Docs</div>
            <div className="text-sm text-muted-foreground">
              {isMobile ? 'Browse every section on mobile' : 'Grounded chat platform'}
            </div>
          </div>
        </div>
        {isMobile ? (
          <div className="mb-4 flex flex-wrap gap-2">
            {mobileDiscoveryLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-sm transition-colors',
                  pathname === item.href || pathname.startsWith(`${item.href}/`)
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-background text-foreground/80 hover:border-primary/30 hover:text-foreground'
                )}
              >
                {item.title}
              </Link>
            ))}
          </div>
        ) : null}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search docs..." value={searchQuery} onChange={(e) => onSearchChange(e.target.value)} className="bg-background/70 pl-10" />
        </div>
      </div>
      <nav className={cn(isMobile ? 'px-4 pb-4' : 'p-4')}>
        {sections.map((item) => (
          <NavSection
            key={item.title}
            item={item}
            pathname={pathname}
            forceOpen={isMobile && searchQuery.length > 0}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </aside>
  )
}
