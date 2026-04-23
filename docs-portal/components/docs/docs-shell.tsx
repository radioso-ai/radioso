'use client'

import { useState } from 'react'

import { DocsHeader } from '@/components/docs/docs-header'
import { DocsSidebar } from '@/components/docs/docs-sidebar'
import { cn } from '@/lib/utils'

export function DocsShell({
  children,
  contentClassName,
}: {
  children: React.ReactNode
  contentClassName?: string
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex min-h-screen bg-background">
      <DocsSidebar onSearchChange={setSearchQuery} searchQuery={searchQuery} />
      <div className="flex min-w-0 flex-1 flex-col">
        <DocsHeader mobileNavOpen={mobileNavOpen} onMobileNavToggle={() => setMobileNavOpen((open) => !open)} />
        {mobileNavOpen ? (
          <div id="docs-mobile-navigation" className="border-b border-border/80 bg-background px-4 py-4 xl:hidden">
            <DocsSidebar
              mode="mobile"
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </div>
        ) : null}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className={cn('mx-auto w-full max-w-5xl px-4 py-10 md:px-8 md:py-14', contentClassName)}>{children}</div>
        </main>
      </div>
    </div>
  )
}
