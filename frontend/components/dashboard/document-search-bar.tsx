'use client'

import { Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

export function DocumentSearchBar({
  query,
  onQueryChange,
  onSubmit,
  onClear,
  isSearching,
}: {
  query: string
  onQueryChange: (value: string) => void
  onSubmit: () => void
  onClear: () => void
  isSearching: boolean
}) {
  return (
    <div className="flex w-full max-w-5xl items-center">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onSubmit()
            }
          }}
          placeholder="Search across document content"
          className="h-12 rounded-xl border-border/80 bg-background/80 pl-11 pr-24 text-base"
        />
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
          {isSearching ? <Spinner className="h-4 w-4 text-muted-foreground" /> : null}
          {query ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-full text-muted-foreground"
              onClick={onClear}
              disabled={isSearching}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Clear search</span>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
