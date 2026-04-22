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

  return (
    <div className="flex min-h-screen bg-background">
      <DocsSidebar onSearchChange={setSearchQuery} searchQuery={searchQuery} />
      <div className="flex min-w-0 flex-1 flex-col">
        <DocsHeader />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className={cn('mx-auto w-full max-w-5xl px-8 py-14', contentClassName)}>{children}</div>
        </main>
      </div>
    </div>
  )
}
