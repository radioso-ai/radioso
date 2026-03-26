'use client'

import { MetadataBadges } from '@/components/dashboard/shared/metadata-badges'
import type { DocumentSearchResponse } from '@/lib/api'

export function DocumentSearchResults({
  search,
  error,
  onOpenDocument,
}: {
  search: DocumentSearchResponse | null
  error: string | null
  onOpenDocument: (documentId: string) => void
}) {
  if (error) {
    return <p className="text-sm text-destructive">{error}</p>
  }

  if (!search) {
    return null
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {search.resultCount} document{search.resultCount === 1 ? '' : 's'} retrieved
      </p>

      {search.results.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          No matching documents found for this search.
        </div>
      ) : (
        <div className="space-y-3">
          {search.results.map((result) => (
            <button
              key={`${search.searchId}-${result.documentId}`}
              type="button"
              onClick={() => onOpenDocument(result.documentId)}
              disabled={!result.actions.some((action) => action.type === 'open_document' && action.status === 'available')}
              className="w-full rounded-lg border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="space-y-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{result.title}</p>
                  <p className="text-xs text-muted-foreground">
                    Rank {result.rank} • Score {result.score.toFixed(3)}
                  </p>
                </div>
                <MetadataBadges metadata={result.metadata} className="" />
                {result.matchEvidence.map((evidence) => (
                  <p key={evidence} className="text-sm text-muted-foreground">
                    {evidence}
                  </p>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
