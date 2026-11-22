import { PauseCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import type { DocumentSourceListItem } from '@/lib/api'

/** A collapsed source row's name, its address, and, for a website, the pages a crawl held because too many went missing at once. */
export function SourceNameCell({ source }: { source: DocumentSourceListItem }) {
  const heldPageCount = source.kind === 'website' ? (source.heldPageCount ?? 0) : 0
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-foreground">{source.name}</p>
      {source.externalId ? (
        <p className="mt-1 truncate text-xs text-muted-foreground">{source.externalId}</p>
      ) : null}
      {heldPageCount > 0 ? (
        <Badge variant="outline" className="mt-1 gap-1 text-xs font-normal text-muted-foreground">
          <PauseCircle className="h-3 w-3" aria-hidden />
          {heldPageCount} {heldPageCount === 1 ? 'page' : 'pages'} held
        </Badge>
      ) : null}
    </div>
  )
}
