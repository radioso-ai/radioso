'use client'

import { useState } from 'react'
import { Book, ChevronDown, ChevronRight, Code2, Database, FileText, Search, Settings2, Shield, Workflow } from 'lucide-react'

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
      { title: 'Introduction', href: '#introduction' },
      { title: 'Run locally in 5 minutes', href: '#run-locally' },
      { title: 'Embed on your website', href: '#website-embed' },
      { title: 'API first success', href: '#api-first-success' },
    ],
  },
  {
    title: 'Grounding',
    icon: <Shield className="h-4 w-4" />,
    items: [
      { title: 'Grounded answers', href: '#grounded-answers' },
      { title: 'Citations', href: '#citations' },
      { title: 'Unsupported answers', href: '#unsupported-answers' },
    ],
  },
  {
    title: 'API Reference',
    icon: <Code2 className="h-4 w-4" />,
    items: [
      { title: 'Authentication', href: '#authentication' },
      { title: 'Upload documents', href: '#upload-documents' },
      { title: 'Create chat responses', href: '#chat-responses' },
      { title: 'Response format', href: '#response-format' },
    ],
  },
  {
    title: 'Operations',
    icon: <Settings2 className="h-4 w-4" />,
    items: [
      { title: 'Retrieval settings', href: '#retrieval-settings' },
      { title: 'Document processing', href: '#document-processing' },
      { title: 'Deployment', href: '#deployment' },
    ],
  },
  {
    title: 'Architecture',
    icon: <Workflow className="h-4 w-4" />,
    items: [
      { title: 'Request flow', href: '#request-flow' },
      { title: 'Retrieval pipeline', href: '#retrieval-pipeline' },
      { title: 'Storage model', href: '#storage-model' },
    ],
  },
  {
    title: 'Resources',
    icon: <FileText className="h-4 w-4" />,
    items: [
      { title: 'TypeScript SDK', href: '#typescript-sdk' },
      { title: 'Operator guides', href: '#operator-guides' },
      { title: 'Benchmarks', href: '#benchmarks' },
    ],
  },
]

function NavSection({
  activeHref,
  item,
  onSelect,
}: {
  activeHref: string
  item: NavItem
  onSelect: (href: string) => void
}) {
  const [isOpen, setIsOpen] = useState(true)

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
            <button
              key={subItem.href}
              onClick={() => (subItem.href ? onSelect(subItem.href) : undefined)}
              className={cn(
                'block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors',
                activeHref === subItem.href ? 'bg-primary/8 font-medium text-primary' : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground'
              )}
            >
              {subItem.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function DocsSidebar({
  activeHref,
  onSearchChange,
  onSelect,
  searchQuery,
}: {
  activeHref: string
  onSearchChange: (value: string) => void
  onSelect: (href: string) => void
  searchQuery: string
}) {
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
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <div className="text-xl font-semibold text-foreground">Radioso Docs</div>
            <div className="text-sm text-muted-foreground">Grounded chat platform</div>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search docs..." value={searchQuery} onChange={(e) => onSearchChange(e.target.value)} className="bg-background/70 pl-10" />
        </div>
      </div>
      <nav className="p-4">
        {(searchQuery ? filteredNavigation : navigation).map((item) => (
          <NavSection key={item.title} item={item} activeHref={activeHref} onSelect={onSelect} />
        ))}
      </nav>
    </aside>
  )
}
