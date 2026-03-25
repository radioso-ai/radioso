'use client'

import { History } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { DocumentSearchHistoryEntry } from '@/lib/api'

export function DocumentSearchHistory({
  history,
  isLoading,
  error,
  onOpen,
}: {
  history: DocumentSearchHistoryEntry[]
  isLoading: boolean
  error: string | null
  onOpen: (searchId: string) => void
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" />
        Loading search history...
      </div>
    )
  }

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>
  }

  if (!history.length) {
    return null
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <History className="h-4 w-4" />
        Recent searches
      </div>
      <div className="flex flex-wrap gap-2">
        {history.slice(0, 6).map((entry) => (
          <Button key={entry.searchId} size="sm" variant="outline" onClick={() => onOpen(entry.searchId)}>
            {entry.query}
          </Button>
        ))}
      </div>
    </div>
  )
}
