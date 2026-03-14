'use client'

import { Fragment, type ReactNode } from 'react'

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { type AnswerSegment, type Citation } from '@/lib/api'

interface AssistantMessageContentProps {
  content: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  onOpenDocument: (documentId: string) => void
}

const getCitationLabel = (citation: Citation, index: number) =>
  citation.title?.trim() || `Document ${index + 1}`

const CitationMarker = ({
  citation,
  index,
  onOpenDocument,
}: {
  citation: Citation
  index: number
  onOpenDocument: (documentId: string) => void
}) => (
  <HoverCard openDelay={100}>
    <HoverCardTrigger asChild>
      <button
        type="button"
        onClick={() => onOpenDocument(citation.documentId)}
        className="mx-0.5 inline-flex align-baseline text-xs font-medium text-primary transition-opacity hover:opacity-80"
      >
        [{index + 1}]
      </button>
    </HoverCardTrigger>
    <HoverCardContent className="w-fit max-w-xs px-3 py-2 text-sm">
      {getCitationLabel(citation, index)}
    </HoverCardContent>
  </HoverCard>
)

const getRenderableSegments = (
  content: string,
  answerSegments?: AnswerSegment[],
) => {
  if (answerSegments && answerSegments.length > 0) {
    return answerSegments
  }

  return [{ text: content }]
}

export function AssistantMessageContent({
  content,
  citations = [],
  answerSegments,
  onOpenDocument,
}: AssistantMessageContentProps) {
  const segments = getRenderableSegments(content, answerSegments)
  const contentNodes: ReactNode[] = []

  segments.forEach((segment, segmentIndex) => {
    const dedupedIndices = [...new Set(segment.citationIndices ?? [])].filter(
      (index) => index >= 0 && index < citations.length,
    )

    contentNodes.push(
      <Fragment key={`segment-${segmentIndex}`}>
        {segment.text}
        {dedupedIndices.map((citationIndex) => {
          const citation = citations[citationIndex]
          if (!citation) {
            return null
          }

          return (
            <CitationMarker
              key={`${citation.documentId}-${citation.chunkId}-${citationIndex}`}
              citation={citation}
              index={citationIndex}
              onOpenDocument={onOpenDocument}
            />
          )
        })}
      </Fragment>,
    )
  })

  return (
    <div className="text-sm whitespace-pre-wrap break-words">
      {contentNodes}
    </div>
  )
}
