'use client'

import { Fragment, type ReactNode } from 'react'

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

const splitClaims = (content: string) => {
  const paragraphs = content.split('\n')

  return paragraphs.map((paragraph) => {
    if (!paragraph.trim()) {
      return ['']
    }

    return paragraph.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [paragraph]
  })
}

const buildClaimCitationMap = (claimCount: number, citations: Citation[]) => {
  const citationMap = Array.from({ length: claimCount }, () => [] as Array<{ citation: Citation; index: number }>)

  if (claimCount === 0) {
    return citationMap
  }

  citations.forEach((citation, index) => {
    const targetClaim = citations.length === 1
      ? 0
      : Math.round((index * (claimCount - 1)) / (citations.length - 1))

    citationMap[targetClaim]?.push({
      citation,
      index,
    })
  })

  return citationMap
}

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

export function AssistantMessageContent({
  content,
  citations = [],
  onOpenDocument,
}: AssistantMessageContentProps) {
  const claimGroups = splitClaims(content)
  const claimCount = claimGroups.reduce((total, group) => total + group.length, 0)
  const claimCitationMap = buildClaimCitationMap(claimCount, citations)
  const contentNodes: ReactNode[] = []
  let claimIndex = 0

  claimGroups.forEach((claims, paragraphIndex) => {
    if (paragraphIndex > 0) {
      contentNodes.push(<br key={`line-break-${paragraphIndex}`} />)
    }

    claims.forEach((claim, localClaimIndex) => {
      contentNodes.push(
        <Fragment key={`claim-${paragraphIndex}-${localClaimIndex}`}>
          {claim}
          {claimCitationMap[claimIndex]?.map(({ citation, index }) => (
            <CitationMarker
              key={`${citation.documentId}-${citation.chunkId}-${index}`}
              citation={citation}
              index={index}
              onOpenDocument={onOpenDocument}
            />
          ))}
        </Fragment>,
      )

      claimIndex += 1
    })
  })

  return (
    <div className="text-sm whitespace-pre-wrap break-words">
      {contentNodes}
    </div>
  )
}
