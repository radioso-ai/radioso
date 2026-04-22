'use client'

import { useMemo, useState } from 'react'

import { DocsContent } from '@/components/docs/docs-content'
import { DocsHeader } from '@/components/docs/docs-header'
import { DocsSidebar } from '@/components/docs/docs-sidebar'

export default function DocsHomePage() {
  const [activeHref, setActiveHref] = useState('#introduction')
  const [searchQuery, setSearchQuery] = useState('')

  const filteredSections = useMemo(
    () => (searchQuery.trim() ? [`Results for "${searchQuery}"`] : undefined),
    [searchQuery]
  )

  return (
    <div className="flex min-h-screen bg-background">
      <DocsSidebar
        activeHref={activeHref}
        onSearchChange={setSearchQuery}
        onSelect={setActiveHref}
        searchQuery={searchQuery}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <DocsHeader />
        <DocsContent highlightedSections={filteredSections} />
      </div>
    </div>
  )
}
