'use client'

import { useState } from 'react'
import { Book, ChevronDown, ChevronRight, Code2, Database, FileText, Search, Settings2, Shield, Workflow } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type NavItem = {
  title: string
  href?: string
  icon?: React.ReactNode
  items?: NavItem[]
}

const navigation: NavItem[] = [
  {
    title: 'Getting Started',
    icon: <Book className="h-4 w-4" />,
    items: [
      { title: 'Overview', href: '/quickstarts' },
      { title: 'Run locally in 5 minutes', href: '/quickstarts/run-locally' },
      { title: 'Embed on your website', href: '/quickstarts/website-embed' },
      { title: 'API first success', href: '/quickstarts/api-first-success' },
    ],
  },
  {
    title: 'Why Radioso',
    icon: <Shield className="h-4 w-4" />,
    items: [
      { title: 'Overview', href: '/why-radioso' },
      { title: 'Grounded answers', href: '/why-radioso/grounded-answers' },
      { title: 'Use cases', href: '/why-radioso/use-cases' },
    ],
  },
  {
    title: 'Guides',
    icon: <Code2 className="h-4 w-4" />,
    items: [
      { title: 'Authentication', href: '/guides/authentication' },
      { title: 'Document upload', href: '/guides/document-upload' },
      { title: 'Retrieval tuning', href: '/guides/retrieval-tuning' },
    ],
  },
  {
    title: 'API',
    icon: <Database className="h-4 w-4" />,
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
    icon: <Settings2 className="h-4 w-4" />,
    items: [
      { title: 'TypeScript getting started', href: '/sdk/typescript-getting-started' },
      { title: 'Basic usage', href: '/sdk/basic-usage' },
      { title: 'Retrieval settings', href: '/sdk/retrieval-settings' },
    ],
  },
  {
    title: 'Architecture',
    icon: <Workflow className="h-4 w-4" />,
    items: [
      { title: 'Overview', href: '/architecture' },
      { title: 'Retrieval pipeline', href: '/architecture/retrieval-pipeline' },
      { title: 'Document processing lifecycle', href: '/architecture/document-processing-lifecycle' },
      { title: 'Deployment topology', href: '/architecture/deployment-topology' },
    ],
  },
  {
    title: 'Operators',
    icon: <FileText className="h-4 w-4" />,
    items: [
      { title: 'Deployment', href: '/operators/deployment' },
      { title: 'Document processing', href: '/operators/document-processing' },
    ],
  },
]

function NavSection({
  item,
  pathname,
}: {
  item: NavItem
  pathname: string
}) {
  const hasActiveChild = Boolean(item.items?.some((subItem) => subItem.href === pathname))
  const [isOpen, setIsOpen] = useState(hasActiveChild || pathname === '/')

  return (
    <div className="mb-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-secondary/60 hover:text-foreground"
      >
        {item.icon}
        <span className="flex-1 text-left">{item.title}</span>
        {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {isOpen && item.items ? (
        <div className="ml-4 mt-2 space-y-1 border-l border-border pl-3">
          {item.items.map((subItem) => (
            <Link
              key={subItem.href}
              href={subItem.href ?? '/'}
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
}: {
  onSearchChange: (value: string) => void
  searchQuery: string
}) {
  const pathname = usePathname()
  const filteredNavigation = navigation
    .map((section) => ({
      ...section,
      items: section.items?.filter((item) => item.title.toLowerCase().includes(searchQuery.toLowerCase())),
    }))
    .filter((section) => section.items && section.items.length > 0)

  return (
    <aside className="sticky top-0 hidden h-screen w-80 overflow-y-auto border-r border-border bg-sidebar xl:block">
      <div className="border-b border-border p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground text-background shadow-sm">
            <Image src="/radioso-icon.svg" alt="" width={32} height={32} priority className="h-8 w-8" />
          </div>
          <div>
            <div className="text-xl font-semibold text-foreground">Radioso Docs</div>
            <div className="text-sm text-muted-foreground">Knowledge agents platform</div>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search docs..." value={searchQuery} onChange={(e) => onSearchChange(e.target.value)} className="bg-background/70 pl-10" />
        </div>
      </div>
      <nav className="p-4">
        {(searchQuery ? filteredNavigation : navigation).map((item) => (
          <NavSection key={item.title} item={item} pathname={pathname} />
        ))}
      </nav>
    </aside>
  )
}
