'use client'

import { Fragment, type CSSProperties, type ReactNode, useState } from 'react'
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
        className="text-[var(--message-link-fg,var(--color-primary))] underline underline-offset-4 hover:text-[var(--message-link-hover-fg,var(--color-primary))]"
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
} from '../ui/hover-card'
import { type AnswerSegment, type Citation } from '../../lib/api'
import {
  buildWebsiteEmbedSurfaceCssVars,
  type WebsiteEmbedTheme,
} from '../../lib/embed-widget'
import { AssistantMarkdownContent } from './chat-markdown'

export type CitationOpenResult = 'opened' | 'unavailable' | 'error'

interface AssistantMessageContentProps {
  content: string
  citations?: Citation[]
  answerSegments?: AnswerSegment[]
  onOpenDocument: (documentId: string) => Promise<CitationOpenResult>
  theme?: WebsiteEmbedTheme | null
}

const getCitationLabel = (citation: Citation, index: number) =>
  citation.title?.trim() || `Document ${index + 1}`

const CitationMarker = ({
  citation,
  index,
  onOpenDocument,
  theme,
}: {
  citation: Citation
  index: number
  onOpenDocument: (citation: Citation, index: number) => void
  theme?: WebsiteEmbedTheme | null
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
    <HoverCardContent
      className="max-w-xs space-y-2 px-3 py-3"
      style={
        theme
          ? {
              ...buildWebsiteEmbedSurfaceCssVars(theme),
              background: theme.panelBackground,
              borderColor: theme.panelBorder,
              color: theme.panelForeground,
            }
          : undefined
      }
    >
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

const ORDERED_LIST_ITEM_PATTERN = /^(\s*)(\d+)\.\s+([\s\S]+)$/

const getSegmentCitationIndices = (segment: AnswerSegment, citations: Citation[]) =>
  [...new Set(segment.citationIndices ?? [])].filter(
    (index) => index >= 0 && index < citations.length,
  )

const getOrderedListItem = (segment: AnswerSegment) => {
  const match = segment.text.match(ORDERED_LIST_ITEM_PATTERN)
  if (!match) {
    return null
  }

  return {
    number: Number(match[2]),
    content: match[3],
  }
}

export function AssistantMessageContent({
  content,
  citations = [],
  answerSegments,
  onOpenDocument,
  theme,
}: AssistantMessageContentProps) {
  const [citationNotice, setCitationNotice] = useState<{ scope: string; message: string } | null>(null)
  const noticeScope = `${content}|${citations.length}|${answerSegments?.length ?? 0}`
  const segments = getRenderableSegments(content, answerSegments)
  const contentThemeVars = theme
    ? ({
        '--message-link-fg': theme.accent,
        '--message-link-hover-fg': theme.accent,
      } as CSSProperties)
    : undefined

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

  const renderCitations = (citationIndices: number[]) =>
    citationIndices.map((citationIndex) => {
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
          theme={theme}
        />
      )
    })

  const contentNodes: ReactNode[] = []

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]
    const orderedListItem = getOrderedListItem(segment)

    if (orderedListItem) {
      const listItems: Array<{
        key: string
        number: number
        content: string
        citationIndices: number[]
      }> = []

      for (let listIndex = segmentIndex; listIndex < segments.length; listIndex += 1) {
        const listSegment = segments[listIndex]
        const listItem = getOrderedListItem(listSegment)
        if (!listItem) {
          break
        }

        listItems.push({
          key: `segment-${listIndex}`,
          number: listItem.number,
          content: listItem.content,
          citationIndices: getSegmentCitationIndices(listSegment, citations),
        })
        segmentIndex = listIndex
      }

      contentNodes.push(
        <ol key={`ordered-list-${segmentIndex}`} className="ml-5 list-decimal space-y-1 text-foreground">
          {listItems.map((item) => (
            <li key={item.key} value={item.number} className="ml-1 text-foreground">
              <AssistantMarkdownContent content={item.content} inline={!hasBlockMarkdown(item.content)} />
              {renderCitations(item.citationIndices)}
            </li>
          ))}
        </ol>,
      )
      continue
    }

    const dedupedIndices = getSegmentCitationIndices(segment, citations)
    contentNodes.push(
      <Fragment key={`segment-${segmentIndex}`}>
        <AssistantMarkdownContent content={segment.text} inline={dedupedIndices.length > 0 && !hasBlockMarkdown(segment.text)} />
        {renderCitations(dedupedIndices)}
      </Fragment>,
    )
  }

  return (
    <div className="space-y-2" style={contentThemeVars}>
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
