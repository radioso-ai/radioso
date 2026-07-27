'use client'

import { Search } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { Input } from '@radioso/ui/input'
import { cn } from '@radioso/ui/utils'

type NavItem = {
  title: string
  href: string
}

type NavSection = {
  title: string
  items: NavItem[]
}

const navigation: NavSection[] = [
  {
    title: 'Why Radioso',
    items: [
      { title: 'Overview', href: '/why-radioso' },
      { title: 'Grounded answers', href: '/why-radioso/grounded-answers' },
      { title: 'Use cases', href: '/why-radioso/use-cases' },
    ],
  },
  {
    title: 'Getting Started',
    items: [
      { title: 'Run locally in 5 minutes', href: '/quickstarts/run-locally' },
      { title: 'Embed on your website', href: '/quickstarts/website-embed' },
      { title: 'API first success', href: '/quickstarts/api-first-success' },
    ],
  },
  {
    title: 'Guides',
    items: [
      { title: 'Authentication', href: '/guides/authentication' },
      { title: 'Document upload', href: '/guides/document-upload' },
      { title: 'Retrieval tuning', href: '/guides/retrieval-tuning' },
    ],
  },
  {
    title: 'API',
    items: [
      { title: 'Overview', href: '/api' },
      { title: 'Auth and sessions', href: '/api/auth-and-sessions' },
      { title: 'Accounts and users', href: '/api/accounts-and-users' },
      { title: 'Workspaces and tokens', href: '/api/workspaces-and-tokens' },
      { title: 'Documents and search', href: '/api/documents-and-search' },
      { title: 'Chat and history', href: '/api/chat-and-history' },
      { title: 'Public chat and embed', href: '/api/public-chat-and-embed' },
      { title: 'Settings', href: '/api/settings' },
      { title: 'Connectors and webhooks', href: '/api/connectors-and-webhooks' },
      { title: 'API reference', href: '/api-reference' },
    ],
  },
  {
    title: 'SDK',
    items: [
      { title: 'TypeScript getting started', href: '/sdk/typescript-getting-started' },
      { title: 'Basic usage', href: '/sdk/basic-usage' },
      { title: 'Retrieval settings', href: '/sdk/retrieval-settings' },
    ],
  },
  {
    title: 'Architecture',
    items: [
      { title: 'Overview', href: '/architecture' },
      { title: 'Retrieval pipeline', href: '/architecture/retrieval-pipeline' },
      { title: 'Document processing lifecycle', href: '/architecture/document-processing-lifecycle' },
      { title: 'Deployment topology', href: '/architecture/deployment-topology' },
    ],
  },
  {
    title: 'Operators',
    items: [
      { title: 'Deployment', href: '/operators/deployment' },
      { title: 'Document processing', href: '/operators/document-processing' },
    ],
  },
]

export function DocsSidebar({
  onSearchChange,
  searchQuery,
}: {
  onSearchChange: (value: string) => void
  searchQuery: string
}) {
  const pathname = usePathname()
  const query = searchQuery.trim().toLowerCase()
  const sections = query
    ? navigation
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => item.title.toLowerCase().includes(query)),
        }))
        .filter((section) => section.items.length > 0)
    : navigation

  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground xl:block">
      <div className="px-5 pb-4 pt-6">
        <Link href="/" className="mb-5 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-foreground text-background">
            <Image src="/radioso-icon.svg" alt="" width={22} height={22} priority className="h-[22px] w-[22px]" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-sidebar-foreground">Radioso Docs</div>
            <div className="text-xs text-sidebar-foreground/55">Conversational agents platform</div>
          </div>
        </Link>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground/50" />
          <Input
            placeholder="Search docs"
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
            className="h-9 bg-background/60 pl-9 text-sm"
          />
        </div>
      </div>
      <nav className="px-3 pb-8">
        {sections.map((section) => (
          <div key={section.title} className="mb-5">
            <div className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/50">
              {section.title}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'relative block rounded-md px-3 py-1.5 text-sm transition-colors',
                        'before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-secondary before:transition-transform before:content-[""]',
                        active
                          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground before:scale-y-100'
                          : 'text-sidebar-foreground/75 before:scale-y-0 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
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
      </nav>
    </aside>
  )
}
