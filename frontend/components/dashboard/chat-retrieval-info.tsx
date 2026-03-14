'use client'

import type { RetrievalInfo } from '@/lib/api'

interface ChatRetrievalInfoProps {
  retrievalInfo?: RetrievalInfo
}

const FAMILY_LABELS: Record<string, string> = {
  date_point: 'Date',
  date_range: 'Date range',
  money_value: 'Price',
  location: 'Location',
}

export function ChatRetrievalInfo({ retrievalInfo }: ChatRetrievalInfoProps) {
  if (!retrievalInfo) {
    return null
  }

  return (
    <details className="mt-3 rounded-md border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer list-none font-medium text-foreground">
        Retrieval details
      </summary>

      <div className="mt-3 space-y-3">
        {retrievalInfo.parsedQuery ? (
          <div className="space-y-1">
            <p className="font-medium text-foreground">Parsed query</p>
            <p>Semantic: {retrievalInfo.parsedQuery.semanticQuery || 'None'}</p>
            <p>Lexical: {retrievalInfo.parsedQuery.lexicalQuery || 'None'}</p>
            <p>
              Constraints:{' '}
              {retrievalInfo.parsedQuery.constraintSummary.length > 0
                ? retrievalInfo.parsedQuery.constraintSummary.join(', ')
                : 'None'}
            </p>
          </div>
        ) : (
          <p>No retrieval parsing details were recorded for this answer.</p>
        )}

        <div className="space-y-1">
          <p className="font-medium text-foreground">Candidate counts</p>
          <p>
            Semantic {retrievalInfo.candidateCounts.semantic} · Lexical {retrievalInfo.candidateCounts.lexical} ·
            Merged {retrievalInfo.candidateCounts.merged} · Final {retrievalInfo.candidateCounts.final}
          </p>
        </div>

        <div className="space-y-1">
          <p className="font-medium text-foreground">Retrieval status</p>
          <p>Rerank: {retrievalInfo.rerankStatus}</p>
          <p>Fallback applied: {retrievalInfo.fallbackApplied ? 'Yes' : 'No'}</p>
        </div>

        <div className="space-y-1">
          <p className="font-medium text-foreground">Applied constraints</p>
          {retrievalInfo.appliedConstraints?.length ? (
            <div className="space-y-1">
              {retrievalInfo.appliedConstraints.map((constraint, index) => (
                <p key={`${constraint.family}-${constraint.summary}-${index}`}>
                  {FAMILY_LABELS[constraint.family] ?? constraint.family}: {constraint.summary} ({constraint.mode},{' '}
                  {constraint.outcome})
                </p>
              ))}
            </div>
          ) : (
            <p>No supported constraints were applied.</p>
          )}
        </div>
      </div>
    </details>
  )
}
