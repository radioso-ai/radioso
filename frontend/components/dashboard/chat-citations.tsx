'use client'

import { Fragment, type ReactNode, useState } from 'react'
import { FileText } from 'lucide-react'

const URL_REGEX = /https?:\/\/[^\s<>)"']+/g

export function linkifyText(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(URL_REGEX)) {
    const url = match[0]
    const index = match.index
    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index))
    }
    parts.push(
      <a
        key={index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline hover:text-primary/80"
      >
        {url}
      </a>,
    )
    lastIndex = index + url.length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { type AnswerSegment, type Citation } from '@/lib/api'
import { AssistantMarkdownContent } from './chat-markdown'

export type CitationOpenResult = 'opened' | 'unavailable' | 'error'

interface AssistantMessageContentProps {
  content: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
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
  onOpenDocument: (citation: Citation, index: number) => void
}) => (
  <HoverCard openDelay={100}>
    <HoverCardTrigger asChild>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          void onOpenDocument(citation, index)
        }}
        className="mx-0.5 inline-flex translate-y-[-0.15rem] items-center rounded-full border border-primary/25 bg-primary/8 px-1.5 py-0.5 align-baseline text-[11px] font-semibold leading-none text-primary transition-colors hover:border-primary/40 hover:bg-primary/14"
        aria-label={`Open source ${index + 1}: ${getCitationLabel(citation, index)}`}
      >
        [{index + 1}]
      </button>
    </HoverCardTrigger>
    <HoverCardContent className="max-w-xs space-y-2 px-3 py-3">
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Source {index + 1}
        </p>
        <p className="text-sm font-medium leading-snug">
          {getCitationLabel(citation, index)}
        </p>
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <FileText className="h-3.5 w-3.5" />
        <span>Click to open document</span>
      </div>
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

const hasBlockMarkdown = (content: string) =>
  /\n\s*\n/.test(content)
  || /^\s{0,3}([-+*]|\d+\.)\s+/m.test(content)
  || /^\s{0,3}>/m.test(content)
  || /^\s{0,3}#{1,6}\s+/m.test(content)
  || /```/.test(content)
  || /^\s*\|.+\|\s*$/m.test(content)

export function AssistantMessageContent({
  content,
  citations = [],
  answerSegments,
  onOpenDocument,
}: AssistantMessageContentProps) {
  const [citationNotice, setCitationNotice] = useState<{ scope: string; message: string } | null>(null)
  const noticeScope = `${content}|${citations.length}|${answerSegments?.length ?? 0}`
  const segments = getRenderableSegments(content, answerSegments)
  const contentNodes: ReactNode[] = []

  const handleCitationOpen = async (citation: Citation, index: number) => {
    try {
      const result = await onOpenDocument(citation.documentId)
      if (result === 'opened') {
        setCitationNotice(null)
        return
      }

      if (result === 'unavailable') {
        setCitationNotice({
          scope: noticeScope,
          message: `${getCitationLabel(citation, index)} is unavailable because the source was deleted.`,
        })
        return
      }

      setCitationNotice({
        scope: noticeScope,
        message: `Unable to open ${getCitationLabel(citation, index)} right now.`,
      })
    } catch {
      setCitationNotice({
        scope: noticeScope,
        message: `Unable to open ${getCitationLabel(citation, index)} right now.`,
      })
    }
  }

  segments.forEach((segment, segmentIndex) => {
    const dedupedIndices = [...new Set(segment.citationIndices ?? [])].filter(
      (index) => index >= 0 && index < citations.length,
    )

    contentNodes.push(
      <Fragment key={`segment-${segmentIndex}`}>
        <AssistantMarkdownContent content={segment.text} inline={dedupedIndices.length > 0 && !hasBlockMarkdown(segment.text)} />
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
              onOpenDocument={handleCitationOpen}
            />
          )
        })}
      </Fragment>,
    )
  })

  return (
    <div className="space-y-2">
      <div className="text-sm break-words leading-6">
        {contentNodes}
      </div>
      {citationNotice && citationNotice.scope === noticeScope ? (
        <p className="text-xs text-amber-300" role="status">
          {citationNotice.message}
        </p>
      ) : null}
    </div>
  )
}
