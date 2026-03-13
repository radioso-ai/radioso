'use client'

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { type Citation } from '@/lib/api'

interface AssistantMessageContentProps {
  content: string
  citations?: Citation[]
  onOpenDocument: (documentId: string) => void
}

const getCitationLabel = (citation: Citation, index: number) =>
  citation.title?.trim() || `Document ${index + 1}`

export function AssistantMessageContent({
  content,
  citations = [],
  onOpenDocument,
}: AssistantMessageContentProps) {
  return (
    <div className="text-sm whitespace-pre-wrap break-words">
      {content ? <span>{content}</span> : null}
      {citations.length > 0 ? <span> </span> : null}
      {citations.map((citation, index) => (
        <HoverCard key={`${citation.documentId}-${citation.chunkId}-${index}`} openDelay={100}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              onClick={() => onOpenDocument(citation.documentId)}
              className="mr-1 inline-flex align-baseline text-xs font-medium text-primary transition-opacity last:mr-0 hover:opacity-80"
            >
              [{index + 1}]
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="w-fit max-w-xs px-3 py-2 text-sm">
            {getCitationLabel(citation, index)}
          </HoverCardContent>
        </HoverCard>
      ))}
    </div>
  )
}
